import { normalizeServerUrl } from "../connections/connection";
import { SitecoreHttpClient } from "./sitecoreHttpClient";
import { isGuid, isLocale } from "../editor/itemEditorModel";

export const referenceId = (value: string): string => value.replace(/[{}-]/gu, "").toLowerCase();
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export interface PreviewReferenceField { id: string; name: string; targets: readonly string[]; issue?: string; }
export interface PreviewReferenceItem { id: string; label: string; fields: readonly PreviewReferenceField[]; }
const query = `query XmCloudSyncReferenceItem($id: String!, $language: String!) {
  item(path: $id, language: $language) {
    id name displayName language { name } version
    fields(ownFields: false) {
      __typename id name value
      definition { type }
      ... on MultilistField { count targetIds }
      ... on LookupField { targetId }
    }
  }
}`;

/** Only typed stored lists/lookups are verified. Never scan arbitrary JSON for GUIDs. */
export function parsePreviewReferenceItem(value: unknown, id: string, language: string): PreviewReferenceItem | null {
  if (value === null) return null;
  if (!record(value) || !isGuid(value.id) || referenceId(value.id) !== referenceId(id)
    || !record(value.language) || value.language.name !== language || !Number.isSafeInteger(value.version) || Number(value.version) < 1
    || typeof value.name !== "string" || value.name.length > 8192 || typeof value.displayName !== "string" || value.displayName.length > 8192
    || !Array.isArray(value.fields) || value.fields.length > 500) throw Error("Invalid Preview item identity, locale or field limit.");
  const fields: PreviewReferenceField[] = [];
  const ids = new Set<string>();
  for (const field of value.fields) {
    if (!record(field) || !isGuid(field.id) || ids.has(referenceId(field.id)) || typeof field.name !== "string" || field.name.length > 8192
      || typeof field.value !== "string" || !record(field.definition) || typeof field.definition.type !== "string") throw Error("Invalid Preview field.");
    ids.add(referenceId(field.id));
    if (field.__typename === "MultilistField" || field.__typename === "LookupField") {
      const targets = field.value.trim() ? field.value.split("|").map(part => part.trim()) : [];
      if (targets.length > 500) throw Error("Reference field exceeds occurrence limit.");
      const valid = targets.every(isGuid);
      const typed = field.__typename === "MultilistField" ? field.targetIds : field.targetId ? [field.targetId] : [];
      const agrees = Array.isArray(typed) && typed.every(isGuid) && typed.length === targets.length
        && typed.every((entry, index) => referenceId(entry) === referenceId(targets[index]))
        && (field.__typename !== "MultilistField" || field.count === targets.length);
      fields.push({ id: field.id, name: field.name, targets,
        issue: !valid ? "Malformed stored reference; occurrences retained." : !agrees ? "Raw and typed Preview references disagree; unresolved." : undefined });
    } else if (field.value.trim() && /^(?:General Link|Image|File)$/iu.test(field.definition.type)) {
      fields.push({ id: field.id, name: field.name, targets: [], issue: "Reference extraction for this field type is not verified in Preview." });
    }
  }
  return { id: referenceId(value.id), label: value.displayName || value.name, fields };
}

/** Separate effective reader: no Authoring fallback, redirects, retries or editable-version claims. */
export class PreviewReferenceClient {
  constructor(private readonly http = new SitecoreHttpClient({ trace() {}, debug() {}, info() {}, warn() {} })) {}
  async read(origin: string, token: string, id: string, language: string, signal: AbortSignal): Promise<PreviewReferenceItem | null> {
    if (!isGuid(id) || !isLocale(language) || !token || /[\r\n]/u.test(token)) throw Error("Invalid Preview reference request.");
    const active = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    try {
      active.throwIfAborted();
      const response = await this.http.request(`${normalizeServerUrl(origin)}/sitecore/api/graph/edge`, {
        method: "POST", redirect: "error", headers: { "content-type": "application/json", sc_apikey: token },
        body: JSON.stringify({ query, variables: { id, language } }),
      }, { name: "CM Preview reference", signal: active, retryable: false });
      if (!response.ok || !response.body || Number(response.headers.get("content-length") ?? 0) > 2 * 1024 * 1024) {
        await response.body?.cancel(); throw Error("Unavailable response.");
      }
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
      try {
        while (true) {
          active.throwIfAborted(); const part = await reader.read(); if (part.done) break;
          bytes += part.value.byteLength; if (bytes > 2 * 1024 * 1024) throw Error("Response limit.");
          chunks.push(part.value);
        }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      active.throwIfAborted();
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.includes(token)) throw Error("Credential material.");
      const payload: unknown = JSON.parse(text);
      if (!record(payload) || payload.errors !== undefined || !record(payload.data)) throw Error("Incomplete result.");
      return parsePreviewReferenceItem(payload.data.item, id, language);
    } catch {
      active.throwIfAborted();
      throw Error("Preview references unavailable: response invalid, inaccessible or over limits. Refresh to retry.");
    }
  }
}
