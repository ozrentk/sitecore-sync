import { collectFallbackConfiguration } from "./fallbackConfiguration";
import { getIntrospectionQuery, Kind, print, visit } from "graphql";
import { itemDetailsQuery } from "./graphql/authoringQueries";
import type { SitecoreHttpAttempt } from "./sitecoreHttpClient";

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
    label: `${language}: ${fallback ? "field-fallback read (item.fields only)" : "exact locale"}`,
    query: fallback ? crossCheck : exact,
    variables: { where: { database: "master", itemId, language }, pageSize: 100, after: null },
  });
  return [...languages.map(language => probe(language, false)), probe(languages[0]!, true)];
}

type DiagnosticRequest = (operation: string, query: string, variables: Readonly<Record<string, unknown>>,
  onAttempt: (attempt: SitecoreHttpAttempt) => void) => Promise<unknown>;

interface DiagnosticPage {
  readonly observedAt: string;
  readonly data: unknown;
  readonly requestId?: number;
  readonly outerItem?: { readonly itemId: unknown; readonly language: unknown; readonly version: unknown };
}

interface DiscardedAttempt {
  readonly reason: "item-changed";
  readonly pages: DiagnosticPage[];
}

interface RequestEvidence {
  readonly id: number;
  readonly operation: string;
  readonly queryId: number;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly versionSelection?: "latest (version omitted)";
  readonly startedAt: string;
  finishedAt?: string;
  status: "returned" | "unavailable";
  readonly httpAttempts: SitecoreHttpAttempt[];
}

export interface ProbeEvidence {
  readonly label: string;
  readonly language: string;
  readonly pages: DiagnosticPage[];
  readonly requestIds?: number[];
  readonly discardedAttempts?: DiscardedAttempt[];
  readonly restarts?: { readonly reason: "item-version-drift"; readonly afterRequestId: number }[];
  issue?: "outer-item-mismatch" | "outer-language-mismatch" | "invalid-outer-version" | "item-changed";
  outcome?: "no-local-fields";
  status: "complete" | "unavailable" | "invalid-response" | "limit-reached" | "item-changed";
}

class DiagnosticLimitError extends Error {}

function normalizedGuid(value: unknown): string | undefined {
  return typeof value === "string" && /^(?:[\da-f]{32}|[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}|\{[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\})$/iu.test(value)
    ? value.replace(/[{}-]/gu, "").toLowerCase() : undefined;
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
  let budgetExhausted = false;
  let requestCount = 0;
  const maximumRequests = 512;
  const requests: RequestEvidence[] = [];
  const queries: { readonly id: number; readonly query: string }[] = [];
  const fits = (data: unknown): boolean => {
    const bytes = Buffer.byteLength(JSON.stringify(data) ?? "null", "utf8");
    if (bytes > remainingBytes) { budgetExhausted = true; return false; }
    remainingBytes -= bytes;
    return true;
  };
  const tracedRequest = async (operation: string, query: string, variables: Readonly<Record<string, unknown>>, requestIds?: number[]) => {
    signal.throwIfAborted();
    if (budgetExhausted || requestCount >= maximumRequests) { throw new DiagnosticLimitError(); }
    let definition = queries.find(entry => entry.query === query);
    if (!definition) {
      definition = { id: queries.length + 1, query };
      if (!fits(definition)) { throw new DiagnosticLimitError(); }
      queries.push(definition);
    }
    const trace: RequestEvidence = { id: ++requestCount, operation, queryId: definition.id, variables,
      versionSelection: operation === "XmCloudSyncItemDetails" ? "latest (version omitted)" : undefined,
      startedAt: new Date().toISOString(), status: "unavailable", httpAttempts: [] };
    requestIds?.push(trace.id);
    try {
      const result = await request(operation, query, variables, attempt => {
        // The shared transport makes at most four HTTP attempts per request.
        if (trace.httpAttempts.length < 4) { trace.httpAttempts.push(attempt); }
      });
      signal.throwIfAborted();
      trace.status = "returned";
      return { result, requestId: trace.id };
    } finally {
      trace.finishedAt = new Date().toISOString();
      if (!fits(trace)) { throw new DiagnosticLimitError(); }
      requests.push(trace);
    }
  };
  let schema: { status: string; data?: unknown; observedAt?: string };
  progress("Reading Authoring schema");
  try {
    const { result: response } = await tracedRequest("IntrospectionQuery", getIntrospectionQuery(), {});
    const result = object(response);
    signal.throwIfAborted();
    const data = object(result?.data);
    schema = !object(data?.__schema) ? { status: "invalid-response" }
      : !fits(data) ? { status: "limit-reached" }
        : { status: "complete", data, observedAt: new Date().toISOString() };
  } catch (error: unknown) {
    signal.throwIfAborted();
    schema = { status: error instanceof DiagnosticLimitError ? "limit-reached" : "unavailable" };
  }
  const readItem = async (label: string, locator: { itemId: string } | { path: string }, language: string, query = print(itemDetailsQuery)): Promise<ProbeEvidence> => {
    signal.throwIfAborted();
    progress(`Reading ${label}`);
    const discardedAttempts: DiscardedAttempt[] = [];
    const restarts: { reason: "item-version-drift"; afterRequestId: number }[] = [];
    const requestIds: number[] = [];
    const evidence: ProbeEvidence = { label, language, pages: [], requestIds, discardedAttempts, restarts, status: "limit-reached" };
    const seen = new Set<string>();
    let after: string | null = null;
    let version: number | undefined;
    let firstItemId: string | undefined;
    for (let page = 0; page < 50; page++) {
      signal.throwIfAborted();
      try {
        const { result: response, requestId } = await tracedRequest("XmCloudSyncItemDetails", query,
          { where: { database: "master", language, ...locator }, pageSize: 100, after }, requestIds);
        const result = object(response);
        signal.throwIfAborted();
        const data = object(result?.data);
        if (!data || !("item" in data)) { evidence.status = "invalid-response"; break; }
        const item = object(data.item);
        const outerLanguage = object(item?.language)?.name;
        const observation: DiagnosticPage = { observedAt: new Date().toISOString(), data, requestId,
          outerItem: item ? { itemId: item.itemId, language: outerLanguage, version: item.version } : undefined };
        if (!fits(observation)) { break; }
        evidence.pages.push(observation);
        if (data.item === null && version === undefined) { evidence.status = "complete"; break; }
        const returnedId = normalizedGuid(item?.itemId);
        if (item) {
          if (!returnedId || ("itemId" in locator ? returnedId !== normalizedGuid(locator.itemId)
            : typeof item.path !== "string" || item.path.toLowerCase() !== locator.path.toLowerCase())
            || (firstItemId !== undefined && returnedId !== firstItemId)) {
            evidence.status = "invalid-response"; evidence.issue = "outer-item-mismatch"; break;
          }
          if (typeof outerLanguage !== "string" || outerLanguage.toLowerCase() !== language.toLowerCase()) {
            evidence.status = "invalid-response"; evidence.issue = "outer-language-mismatch"; break;
          }
          if (typeof item.version !== "number" || !Number.isSafeInteger(item.version) || item.version < 0) {
            evidence.status = "invalid-response"; evidence.issue = "invalid-outer-version"; break;
          }
        } else if (data.item !== null) { evidence.status = "invalid-response"; break; }
        if (version !== undefined && item?.version !== version) {
          discardedAttempts.push({ reason: "item-changed", pages: evidence.pages.splice(0) });
          if (restarts.length) {
            evidence.status = "item-changed"; evidence.issue = "item-changed"; break;
          }
          restarts.push({ reason: "item-version-drift", afterRequestId: requestId });
          progress(`Item changed while reading ${label}; restarting from page one (latest version)`);
          after = null;
          version = undefined;
          firstItemId = undefined;
          seen.clear();
          continue;
        }
        version = item?.version as number;
        firstItemId = returnedId;
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
      } catch (error: unknown) {
        signal.throwIfAborted();
        evidence.status = error instanceof DiagnosticLimitError ? "limit-reached" : "unavailable";
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
    formatVersion: 3, startedAt, finishedAt: new Date().toISOString(),
    notice: "Read-only evidence, not a fallback resolution or transactional snapshot, even when versions match: same-version edits can occur between pages. withLanguageFallback applies to item.fields only; outer returned language/version are separate evidence, not whole-item substitution or field-source provenance. Candidate locales are supplied, not a verified chain. Complete means collection completed with matching outer identity/language and stable numbered version, not verified provenance. Discarded attempts are excluded from active pages and configuration discovery. The report contains selected item content; review before sharing. Unavailable means the request failed (authentication, permissions, schema or transport); it does not mean content is absent. Raw server errors and HTTP headers are omitted. HTTP timing ends when response headers arrive; request timing includes body parsing. Retry delay is scheduled, not proof the next attempt ran.",
    itemId: probes[0]?.variables.where.itemId, schema, observations, configuration, queries, requests,
    coverage: { requestCount, maximumRequests, maximumHttpAttemptsPerRequest: 4, maximumPagesPerProbeIncludingRestarts: 50,
      maximumEvidenceBytes: 6 * 1024 * 1024, evidenceBytesUsed: 6 * 1024 * 1024 - remainingBytes,
      budgetExhausted, omittedRequestTraces: requestCount - requests.length },
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
