import { normalizeServerUrl } from "../connections/connection";
import { SitecoreHttpClient, type SitecoreHttpAttempt } from "./sitecoreHttpClient";
import type { PreviewSelection } from "./previewDiagnostic";

export const layoutDiagnosticQuery = `query XmCloudSyncLayoutDiagnostic($site: String!, $route: String!, $language: String!) {
  layout(site: $site, routePath: $route, language: $language) { item { rendered } }
}`;
const renderingId = "904D4725-538E-469B-9317-4FA34C410316";
const schemaQuery = 'query XmCloudSyncRenderingCapability { __schema { queryType { fields { name } } } __type(name: "Item") { fields { name } } }';
const renderingQuery = 'query XmCloudSyncTestDriveRendering($route: String!, $language: String!) { item(path: $route, language: $language) { id path fields { name value } } }';
export const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export type LayoutRole = "cm-preview" | "published-delivery";
export interface LayoutDiagnostic {
  formatVersion: 1; endpointRole: LayoutRole; endpoint: string; selection: PreviewSelection;
  startedAt: string; finishedAt: string; query: string; variables: Record<string, string>; attempts: SitecoreHttpAttempt[]; bytes: number;
  transport: "response" | "network-error" | "cancelled" | "timeout" | "not-started";
  httpStatus?: number; body: "not-read" | "valid" | "invalid" | "too-large" | "credential-material";
  graphql: "unknown" | "success" | "errors" | "partial";
  graphqlErrorCount: number; errorsTruncated: boolean; errors: { message: string }[]; routePresence: "unknown" | "absent" | "present";
  schemaSupported?: boolean; renderingDefinition?: { status: "item-unavailable" | "field-unavailable" | "published-value" | "identity-mismatch"; item?: unknown; componentQuery?: unknown };
  rendered?: unknown; notice: string;
}

export function deliveryEndpoint(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/api/graphql/v1")
    throw Error("Configure an HTTPS Delivery endpoint ending in /api/graphql/v1, without credentials, query or fragment.");
  return url.href;
}
function validate(selection: PreviewSelection): void {
  if (!selection.site.trim() || selection.site.length > 256 || /[\r\n]/u.test(selection.site) || selection.route.length > 2048
    || !selection.route.startsWith("/") || /[\r\n?#]/u.test(selection.route) || !/^[a-z]{2,8}(?:-[a-z\d]{1,8})*$/iu.test(selection.language))
    throw Error("Invalid diagnostic selection.");
}

/** Independent of publishing verification: fixed query, one attempt, no credential fallback. */
export class LayoutDiagnosticClient {
  constructor(private readonly http = new SitecoreHttpClient({ trace() {}, debug() {}, info() {}, warn() {} }), private readonly timeoutMs = 30_000) {}
  async collect(role: LayoutRole, configured: string, token: string, selection: PreviewSelection, signal: AbortSignal): Promise<LayoutDiagnostic> {
    return this.execute(role, configured, token, selection, signal, "layout");
  }
  async inspectRendering(configured: string, token: string, language: string, signal: AbortSignal) {
    const selection = { site: "not-applicable-rendering-definition", route: "/" + renderingId, language };
    const capability = await this.execute("published-delivery", configured, token, selection, signal, "schema");
    if (capability.schemaSupported !== true) return { capability, status: capability.schemaSupported === false ? "schema-unsupported" : "schema-unavailable" };
    const evidence = await this.execute("published-delivery", configured, token, { ...selection, route: renderingId }, signal, "rendering");
    return { capability, evidence, status: evidence.renderingDefinition?.status ?? "query-unavailable" };
  }
  private async execute(role: LayoutRole, configured: string, token: string, selection: PreviewSelection, signal: AbortSignal,
    operation: "layout" | "schema" | "rendering"): Promise<LayoutDiagnostic> {
    validate(operation === "rendering" ? { ...selection, route: "/" + selection.route } : selection);
    if (!token || /[\r\n]/u.test(token)) throw Error("Configure the separate token for this endpoint role.");
    const endpoint = role === "cm-preview" ? `${normalizeServerUrl(configured)}/sitecore/api/graph/edge` : deliveryEndpoint(configured);
    // Never allow the saved credential to appear in endpoint/input provenance.
    if (JSON.stringify({ endpoint, selection }).includes(token)) throw Error("Invalid diagnostic configuration.");
    const deadline = new AbortController(); const active = AbortSignal.any([signal, deadline.signal]);
    const timer = setTimeout(() => deadline.abort(), this.timeoutMs);
    const report: LayoutDiagnostic = { formatVersion: 1, endpointRole: role, endpoint, selection: { ...selection },
      startedAt: new Date().toISOString(), finishedAt: "", query: operation === "layout" ? layoutDiagnosticQuery : operation === "schema" ? schemaQuery : renderingQuery, variables: operation === "schema" ? {} : operation === "rendering" ? { route: selection.route, language: selection.language } : { ...selection }, attempts: [], bytes: 0,
      transport: "not-started", body: "not-read", graphql: "unknown", graphqlErrorCount: 0, errorsTruncated: false, errors: [], routePresence: "unknown",
      notice: "Read-only untrusted content. Separate observations, not a transactional snapshot. Source language and website endpoint mapping are unverified. No publishing cause or website runtime equivalence is established. Catalog root differences do not prove an environment match or mismatch." };
    try {
      active.throwIfAborted();
      const response = await this.http.request(endpoint, { method: "POST", redirect: "error", headers: { "content-type": "application/json", sc_apikey: token },
        body: JSON.stringify({ query: report.query, variables: report.variables }) },
      { name: "Layout diagnostic", signal: active, retryable: false, onAttempt: attempt => report.attempts.push(attempt) });
      report.transport = "response"; report.httpStatus = response.status;
      if (Number(response.headers.get("content-length") ?? 0) > 2 * 1024 * 1024) {
        report.body = "too-large"; await response.body?.cancel(); return report;
      }
      if (!response.body) { report.body = "invalid"; return report; }
      const reader = response.body.getReader(); const chunks: Uint8Array[] = [];
      // Abort even when a mocked/remote stream never resolves a read.
      const abort = (): void => { void reader.cancel().catch(() => undefined); };
      active.addEventListener("abort", abort, { once: true });
      try {
        while (true) {
          active.throwIfAborted(); const part = await reader.read(); active.throwIfAborted(); if (part.done) break;
          report.bytes += part.value.byteLength;
          if (report.bytes > 2 * 1024 * 1024) { report.body = "too-large"; return report; }
          chunks.push(part.value);
        }
      } finally { active.removeEventListener("abort", abort); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      let payload: unknown;
      try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { report.body = "invalid"; return report; }
      if (!object(payload)) { report.body = "invalid"; return report; }
      const secrets = [token, encodeURIComponent(token), Buffer.from(token).toString("base64")];
      const sanitize = (value: string): string => secrets.reduce((text, secret) => text.split(secret).join("[redacted]"), value)
        .replace(/https?:\/\/[^\s]+/gu, "[URL omitted]").replace(/Bearer\s+\S+/giu, "Bearer [redacted]").slice(0, 1000);
      if (payload.errors !== undefined && !Array.isArray(payload.errors)) { report.body = "invalid"; return report; }
      report.graphqlErrorCount = Array.isArray(payload.errors) ? payload.errors.length : 0;
      report.errorsTruncated = report.graphqlErrorCount > 100;
      report.errors = Array.isArray(payload.errors) ? payload.errors.slice(0, 100).map(error => ({ message: sanitize(object(error) && typeof error.message === "string" ? error.message : "GraphQL error (message unavailable)") })) : [];
      const data = object(payload.data) ? payload.data : undefined;
      report.body = "valid";
      report.graphql = report.errors.length ? data ? "partial" : "errors" : data ? "success" : "unknown";
      if (!data || !response.ok) return report;
      if (operation === "schema") {
        if (object(data.__schema) && object(data.__schema.queryType) && Array.isArray(data.__schema.queryType.fields) && object(data.__type) && Array.isArray(data.__type.fields) && !report.errors.length) {
          const has = (values: unknown[], name: string) => values.some(value => object(value) && value.name === name);
          report.schemaSupported = has(data.__schema.queryType.fields, "item") && ["id", "path", "fields"].every(name => has((data.__type as { fields: unknown[] }).fields, name));
        }
        return report;
      }
      if (operation === "rendering") {
        if (secrets.some(secret => JSON.stringify(data).includes(secret))) { report.body = "credential-material"; return report; }
        if (report.errors.length) return report;
        if (data.item === null) { report.renderingDefinition = { status: "item-unavailable" }; return report; }
        if (!object(data.item) || typeof data.item.id !== "string" || !Array.isArray(data.item.fields)) return report;
        if (data.item.id.replace(/[{}-]/gu, "").toLowerCase() !== renderingId.replace(/-/gu, "").toLowerCase()) {
          report.renderingDefinition = { status: "identity-mismatch" }; return report;
        }
        const fields = data.item.fields.filter(field => object(field) && field.name === "ComponentQuery");
        report.renderingDefinition = { status: fields.length === 1 && object(fields[0]) && typeof fields[0].value === "string" ? "published-value" : "field-unavailable", item: data.item };
        if (report.renderingDefinition.status === "published-value") report.renderingDefinition.componentQuery = (fields[0] as { value: string }).value;
        return report;
      }
      const layout = data.layout;
      if (layout === null || (object(layout) && layout.item === null)) { report.routePresence = report.errors.length ? "unknown" : "absent"; return report; }
      if (!object(layout) || !object(layout.item) || !("rendered" in layout.item)) return report;
      let rendered: unknown = layout.item.rendered;
      if (typeof rendered === "string") { try { rendered = JSON.parse(rendered); } catch { report.body = "invalid"; return report; } }
      if (secrets.some(secret => JSON.stringify(rendered)?.includes(secret))) { report.body = "credential-material"; return report; }
      report.rendered = rendered;
      const route = object(rendered) && object(rendered.sitecore) ? rendered.sitecore.route : undefined;
      report.routePresence = object(route) ? "present" : route === null && !report.errors.length ? "absent" : "unknown";
      return report;
    } catch {
      if (active.aborted) report.transport = signal.aborted ? "cancelled" : "timeout";
      else if (report.transport === "response") report.body = "invalid";
      else report.transport = "network-error";
      return report;
    } finally { clearTimeout(timer); report.finishedAt = new Date().toISOString(); }
  }
}
