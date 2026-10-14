import { EditorValidationError } from "./itemEditorModel";

/** Sitecore's URL-parameter representation. Keep individual raw segments until edited. */
export interface NameValueEntry { readonly raw: string | null; readonly key: string; readonly value: string }
const limit = 256;
function decode(value: string): string {
  try { return decodeURIComponent(value.replace(/\+/gu, " ")); }
  catch { throw new EditorValidationError("Name Value List contains invalid percent encoding; original value is preserved."); }
}
function text(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 65536 || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  try { encodeURIComponent(value); return true; } catch { return false; }
}
export function parseNameValues(raw: string): readonly NameValueEntry[] {
  if (!raw) return [];
  const segments = raw.split("&");
  if (segments.length > limit) throw new EditorValidationError("Name Value List exceeds 256 entries.");
  return segments.map((segment) => {
    const separator = segment.indexOf("=");
    if (separator < 1) throw new EditorValidationError("Name Value List contains a missing/empty key or missing separator; original value is preserved.");
    const key = decode(segment.slice(0, separator)); const value = decode(segment.slice(separator + 1));
    if (!key || !text(key) || !text(value)) throw new EditorValidationError("Name Value List contains unsupported text; original value is preserved.");
    return { raw: segment, key, value };
  });
}
export function serializeNameValues(raw: string, input: string): string {
  parseNameValues(raw);
  const rows: unknown = JSON.parse(input);
  if (!Array.isArray(rows) || rows.length > limit) throw new EditorValidationError("Enter at most 256 name/value rows.");
  const keys = new Map<string, boolean[]>();
  const result = rows.map((row: unknown) => {
    if (!row || typeof row !== "object") throw new EditorValidationError("Invalid name/value row.");
    const entry = row as NameValueEntry;
    if (!text(entry.key) || !entry.key || !text(entry.value)) throw new EditorValidationError("Each row needs a non-empty key and valid text. Empty values are allowed.");
    if (entry.raw !== null && (typeof entry.raw !== "string" || !entry.raw || entry.raw.includes("&"))) throw new EditorValidationError("Invalid original row representation.");
    const previous = entry.raw === null ? undefined : parseNameValues(entry.raw)[0];
    const identity = entry.key.toLowerCase();
    const retained = keys.get(identity) ?? []; retained.push(previous?.key === entry.key); keys.set(identity, retained);
    if (previous?.key === entry.key && previous.value === entry.value) return entry.raw!;
    // Each row carries its original representation through backup and Undo after Save.
    const split = entry.raw?.indexOf("=") ?? -1;
    const key = previous?.key === entry.key ? entry.raw!.slice(0, split) : encodeURIComponent(entry.key);
    const value = previous?.value === entry.value ? entry.raw!.slice(split + 1) : encodeURIComponent(entry.value);
    return `${key}=${value}`;
  });
  for (const retained of keys.values()) {
    if (retained.length > 1 && retained.some(value => !value)) throw new EditorValidationError("New duplicate keys are not supported. Existing duplicate entries are preserved separately.");
  }
  return result.join("&");
}
