import { normalizeServerUrl } from "../connections/connection";
import { SitecoreHttpClient, type SitecoreHttpAttempt } from "./sitecoreHttpClient";

export interface PreviewSelection { site: string; route: string; language: string; }
const query = `query XmCloudSyncPreviewDiagnostic($site: String!, $route: String!, $language: String!) {
  layout(site: $site, routePath: $route, language: $language) { item { rendered } }
}`;
const maximumBytes = 2 * 1024 * 1024;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** One fixed CM query; no redirects, retries, content crawling or credential fallback. */
export class PreviewDiagnosticClient {
  constructor(private readonly http = new SitecoreHttpClient({ trace() {}, debug() {}, info() {}, warn() {} })) {}
  async collect(origin: string, token: string, selection: PreviewSelection, signal: AbortSignal): Promise<unknown> {
    const endpoint = `${normalizeServerUrl(origin)}/sitecore/api/graph/edge`;
    if (!token || /[\r\n]/u.test(token)) throw Error("Configure a valid Preview token in Connection settings.");
    if (!selection.site.trim() || selection.site.length > 256 || selection.route.length > 2048 || !selection.route.startsWith("/") || /[\r\n?#]/u.test(selection.route)
      || !/^[a-z]{2,8}(?:-[a-z\d]{1,8})*$/iu.test(selection.language)) throw Error("Invalid Preview site, route or language.");
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const timeout = setTimeout(() => controller.abort(), 30_000);
    const startedAt = new Date().toISOString();
    const attempts: SitecoreHttpAttempt[] = [];
    try {
      const response = await this.http.request(endpoint, { method: "POST", redirect: "error",
        headers: { "content-type": "application/json", sc_apikey: token }, body: JSON.stringify({ query, variables: selection }) },
      { name: "CM Preview diagnostic", signal: combined, retryable: false, onAttempt: attempt => attempts.push(attempt) });
      if (!response.ok) { await response.body?.cancel(); throw Error(`Preview returned HTTP ${response.status}.`); }
      if (!response.body || Number(response.headers.get("content-length") ?? 0) > maximumBytes) {
        await response.body?.cancel(); throw Error("Preview response exceeds the diagnostic limit.");
      }
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
      try {
        while (true) {
          combined.throwIfAborted(); const part = await reader.read(); if (part.done) break;
          bytes += part.value.byteLength; if (bytes > maximumBytes) throw Error("Preview response exceeds the diagnostic limit.");
          chunks.push(part.value);
        }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      combined.throwIfAborted();
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.includes(token)) throw Error("Preview response contains credential material.");
      const payload: unknown = JSON.parse(text);
      if (!record(payload) || payload.errors !== undefined || !record(payload.data)) throw Error("Preview returned an invalid or incomplete GraphQL result.");
      const layout = payload.data.layout;
      if (!record(layout) || !record(layout.item) || layout.item.rendered === undefined || layout.item.rendered === null)
        return { formatVersion: 1, status: "unresolved", startedAt, finishedAt: new Date().toISOString(), selection, attempts, bytes };
      const rendered: unknown = typeof layout.item.rendered === "string" ? JSON.parse(layout.item.rendered) : layout.item.rendered;
      if (JSON.stringify(rendered)?.includes(token)) throw Error("Preview response contains credential material.");
      if (!record(rendered)) throw Error("Preview returned invalid rendered content.");
      return { formatVersion: 1, status: "collected", startedAt, finishedAt: new Date().toISOString(), endpointRole: "cm-preview",
        selection, query, attempts, bytes, provenance: "unverified", devicePolicy: "provider-implicit",
        notice: "Read-only effective content, not a snapshot or writable locale. Collection does not prove unpublished freshness or complete layout coverage. Contains item content; review before sharing.", rendered };
    } catch {
      if (combined.aborted) throw Error("Preview diagnostic cancelled or timed out.");
      throw Error("Preview diagnostic failed. Check its separate Preview token and CM endpoint; the response may be invalid, incomplete or exceed 2 MiB. No content was changed.");
    } finally { clearTimeout(timeout); }
  }
}
