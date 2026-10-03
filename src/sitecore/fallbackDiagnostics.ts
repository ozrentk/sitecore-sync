import { collectFallbackConfiguration } from "./fallbackConfiguration";
import { getIntrospectionQuery, Kind, print, visit } from "graphql";
import { itemDetailsQuery } from "./graphql/authoringQueries";

export interface FallbackProbe {
  readonly label: string;
  readonly query: string;
  readonly variables: {
    readonly where: { readonly database: string; readonly itemId: string; readonly language: string };
    readonly pageSize: number;
    readonly after: null;
  };
}

/** Fixed read-only probes; supplied candidates do not assert a configured fallback chain. */
export function buildFallbackProbes(itemId: string, languages: readonly string[]): readonly FallbackProbe[] {
  if (!/^\{?[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}\}?$/iu.test(itemId)
    || itemId.startsWith("{") !== itemId.endsWith("}")) {
    throw new Error("Supply an item GUID.");
  }
  if (languages.length < 1 || languages.length > 8
    || languages.some(language => !/^[a-z]{2,8}(?:-[a-z\d]{1,8})*$/iu.test(language))
    || new Set(languages.map(language => language.toLowerCase())).size !== languages.length) {
    throw new Error("Supply 1–8 distinct language names: requested locale first, then known candidates.");
  }
  const exact = print(itemDetailsQuery);
  const crossCheck = print(visit(itemDetailsQuery, {
    Argument(node) {
      return node.name.value === "withLanguageFallback"
        ? { ...node, value: { kind: Kind.BOOLEAN, value: true } }
        : undefined;
    },
  }));
  const probe = (language: string, fallback: boolean): FallbackProbe => ({
    label: `${language}: ${fallback ? "Sitecore cross-check" : "exact locale"}`,
    query: fallback ? crossCheck : exact,
    variables: { where: { database: "master", itemId, language }, pageSize: 100, after: null },
  });
  return [...languages.map(language => probe(language, false)), probe(languages[0]!, true)];
}

type DiagnosticRequest = (operation: string, query: string, variables: Readonly<Record<string, unknown>>) => Promise<unknown>;

export interface ProbeEvidence {
  readonly label: string;
  readonly language: string;
  readonly pages: { readonly observedAt: string; readonly data: unknown }[];
  outcome?: "no-local-fields";
  status: "complete" | "unavailable" | "invalid-response" | "limit-reached";
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Preserve raw null/missing values; this evidence collector never resolves fallback or enables writes. */
export async function collectFallbackDiagnostic(
  probes: readonly FallbackProbe[], request: DiagnosticRequest, signal: AbortSignal,
  progress: (message: string) => void = () => undefined,
  includeConfiguration = false,
): Promise<unknown> {
  signal.throwIfAborted();
  const startedAt = new Date().toISOString();
  let remainingBytes = 6 * 1024 * 1024;
  const fits = (data: unknown): boolean => {
    const bytes = Buffer.byteLength(JSON.stringify(data) ?? "null", "utf8");
    if (bytes > remainingBytes) { return false; }
    remainingBytes -= bytes;
    return true;
  };
  let schema: { status: string; data?: unknown; observedAt?: string };
  progress("Reading Authoring schema");
  try {
    const result = object(await request("IntrospectionQuery", getIntrospectionQuery(), {}));
    signal.throwIfAborted();
    const data = object(result?.data);
    schema = !object(data?.__schema) ? { status: "invalid-response" }
      : !fits(data) ? { status: "limit-reached" }
        : { status: "complete", data, observedAt: new Date().toISOString() };
  } catch {
    signal.throwIfAborted();
    schema = { status: "unavailable" };
  }
  const readItem = async (label: string, locator: { itemId: string } | { path: string }, language: string, query = print(itemDetailsQuery)): Promise<ProbeEvidence> => {
    signal.throwIfAborted();
    progress(`Reading ${label}`);
    const evidence: ProbeEvidence = { label, language, pages: [], status: "limit-reached" };
    const seen = new Set<string>();
    let after: string | null = null;
    for (let page = 0; page < 50; page++) {
      signal.throwIfAborted();
      try {
        const result = object(await request("XmCloudSyncItemDetails", query, { where: { database: "master", language, ...locator }, pageSize: 100, after }));
        signal.throwIfAborted();
        const data = object(result?.data);
        if (!data || !("item" in data)) { evidence.status = "invalid-response"; break; }
        if (!fits(data)) { break; }
        evidence.pages.push({ observedAt: new Date().toISOString(), data });
        if (data.item === null) { evidence.status = "complete"; break; }
        const item = object(data.item);
        if (item?.version === 0 && item.fields === null) {
          evidence.status = "complete"; evidence.outcome = "no-local-fields"; break;
        }
        const fields = object(item?.fields);
        const pageInfo = object(fields?.pageInfo);
        if (!object(data.item) || !Array.isArray(fields?.nodes) || typeof pageInfo?.hasNextPage !== "boolean") {
          evidence.status = "invalid-response"; break;
        }
        if (!pageInfo.hasNextPage) { evidence.status = "complete"; break; }
        if (typeof pageInfo.endCursor !== "string" || !pageInfo.endCursor || seen.has(pageInfo.endCursor)) {
          evidence.status = "invalid-response"; break;
        }
        after = pageInfo.endCursor;
        seen.add(after);
      } catch {
        signal.throwIfAborted();
        evidence.status = "unavailable";
        break;
      }
    }
    return evidence;
  };
  const observations: ProbeEvidence[] = [];
  for (const probe of probes) {
    observations.push(await readItem(probe.label, { itemId: probe.variables.where.itemId }, probe.variables.where.language, probe.query));
  }
  const configuration = includeConfiguration && probes.length
    ? await collectFallbackConfiguration(observations, [...new Set(probes.map(probe => probe.variables.where.language))], readItem, signal)
    : undefined;
  return {
    formatVersion: 2, startedAt, finishedAt: new Date().toISOString(),
    notice: "Read-only evidence, not a fallback resolution or transactional snapshot. Candidate locales are supplied, not a verified chain. Complete means collection completed, not verified provenance. The report contains selected item content; review before sharing. Unavailable means the request failed (authentication, permissions, schema or transport); it does not mean content is absent. Raw server errors are omitted.",
    itemId: probes[0]?.variables.where.itemId, schema, observations, configuration,
  };
}

export function serializeFallbackDiagnostic(report: unknown, secrets: readonly string[]): string {
  const known = secrets.filter(value => value.length > 0).sort((a, b) => b.length - a.length);
  const redact = (text: string): string => known.reduce((value, secret) => value.split(secret).join("[REDACTED]"), text);
  const scrub = (value: unknown): unknown => {
    if (typeof value === "string") { return redact(value); }
    if (Array.isArray(value)) { return value.map(scrub); }
    if (object(value)) { return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [redact(key), scrub(child)])); }
    return value;
  };
  return JSON.stringify(scrub(report), null, 2);
}
