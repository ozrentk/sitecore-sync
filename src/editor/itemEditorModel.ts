import { parseMultipleSelection, validateMultipleDraft } from "./multipleSelection";
import { isMultipleSelection, selectionKind, selectionSourceReason } from "./singleSelection";
import { createHash } from "node:crypto";
import type { AuthoringItemDetails, AuthoringItemField } from "../sitecore/authoringClient";
import { hasPagePresentation } from "../publicPages/publicPageUrl";

export class EditorValidationError extends Error {}

export interface EditorTarget {
  readonly connectionId: string;
  readonly serverUrl: string;
  readonly itemId: string;
  readonly language: string;
  readonly version: number;
}
export interface FieldDraft { readonly input: string; readonly clear: boolean }
export interface EditorChange { readonly fieldId: string; readonly name: string; readonly value: string; readonly scope: string }
export interface EditorState {
  readonly formatVersion: 1;
  readonly target: EditorTarget;
  readonly base: AuthoringItemDetails;
  readonly drafts: Readonly<Record<string, FieldDraft>>;
  readonly attempt?: { readonly phase: "sent" | "acknowledged"; readonly changes: readonly EditorChange[] };
}
export type EditorFieldKind = "text" | "multiline" | "checkbox" | "integer" | "number" | "date" | "datetime" | "selection" | "multiselection";
export const normalizeId = (value: string): string => value.replace(/[{}-]/gu, "").toLowerCase();
export const isGuid = (value: unknown): value is string => typeof value === "string" && /^(?:[0-9a-f]{32}|\{?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\}?)$/iu.test(value);
export const isLocale = (value: unknown): value is string => typeof value === "string" && /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/iu.test(value);

export function editorKey(target: EditorTarget): string {
  return createHash("sha256").update(JSON.stringify([target.connectionId, normalizeId(target.itemId), target.language.toLowerCase(), target.version])).digest("hex");
}

export function fieldKind(field: AuthoringItemField): EditorFieldKind | undefined {
  if (isMultipleSelection(selectionKind(field))) return "multiselection";
  if (selectionKind(field)) return "selection";
  const types: Record<string, EditorFieldKind> = { "single-line text": "text", "multi-line text": "multiline",
    checkbox: "checkbox", integer: "integer", number: "number", date: "date", datetime: "datetime" };
  return Object.hasOwn(types, field.type.toLowerCase()) ? types[field.type.toLowerCase()] : undefined;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || value.startsWith("0000")) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** No local timezone conversion. Ambiguous legacy Datetime values are not editable. */
function dateInput(value: string, kind: "date" | "datetime"): string | undefined {
  if (!value) return "";
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/u.exec(value);
  if (!match || (kind === "datetime" && match[7] !== "Z")) return undefined;
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  if (!validDate(date) || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) return undefined;
  if (kind === "date") return match[4] === "00" && match[5] === "00" && match[6] === "00" ? date : undefined;
  return `${date}T${match[4]}:${match[5]}:${match[6]}`;
}

export function fieldInput(field: AuthoringItemField): string {
  switch (fieldKind(field)) {
    case "date": return dateInput(field.value, "date") ?? field.value;
    case "datetime": return dateInput(field.value, "datetime") ?? field.value;
    case "checkbox": return field.value === "1" ? "1" : "";
    case "multiline": return field.value.replace(/\r\n/gu, "\n");
    default: return field.value;
  }
}

export function readOnlyReason(item: AuthoringItemDetails, field: AuthoringItemField): string | undefined {
  if (item.version < 1) return "No exact-locale version exists. Choose an existing locale/version; this editor creates no versions.";
  if (!item.path.toLowerCase().startsWith("/sitecore/content/") || hasPagePresentation(item)) return "Stage A edits ordinary content items only; page editing is deferred.";
  if (field.containsFallbackValue) return "Fallback source is unverified. This editor only writes exact-locale values.";
  if (field.name.startsWith("__") || field.isStandardTemplate) return "System and Standard Template fields are read-only in Stage A.";
  if (item.fields.filter(other => other.name.toLowerCase() === field.name.toLowerCase()).length !== 1) return "Ambiguous field name; cannot safely target the Authoring mutation.";
  const kind = fieldKind(field);
  if (!kind) return field.type.toLowerCase() === "rich text"
    ? "Rich Text is deferred until visual and HTML source editors can preserve content when switching."
    : "This field type is read-only in Stage A.";
  if (kind === "multiselection") {
    try { parseMultipleSelection(field.value); } catch (error) { return (error as Error).message; }
    return selectionSourceReason(field.selectionSource);
  }
  if (kind === "selection") return selectionSourceReason(field.selectionSource);
  if (kind === "checkbox" && !["", "0", "1"].includes(field.value)) return "Unrecognized stored checkbox representation.";
  if ((kind === "date" || kind === "datetime") && dateInput(field.value, kind) === undefined) return "Unrecognized or timezone-ambiguous stored date. The original value is preserved.";
  if (kind === "text" && /[\r\n]/u.test(field.value)) return "Stored single-line text contains line breaks; original value is preserved.";
  if (kind === "multiline" && (/\r(?!\n)/u.test(field.value) || (/\r\n/u.test(field.value) && /(?<!\r)\n/u.test(field.value)))) return "Mixed or legacy newline convention; original value is preserved.";
  return undefined;
}

export function serializeDraft(field: AuthoringItemField, draft: FieldDraft): string {
  if (draft.clear) return ""; // Explicit empty, never reset/inheritance.
  if (draft.input === fieldInput(field)) return field.value;
  const value = draft.input;
  switch (fieldKind(field)) {
    case "multiselection": validateMultipleDraft(field, value); return value;
    case "selection": return value; // Membership is revalidated by the host immediately before writing.
    case "text": if (/[\r\n]/u.test(value)) throw new EditorValidationError("Single-Line Text cannot contain line breaks."); return value;
    case "multiline": return field.value.includes("\r\n") ? value.replace(/\r\n/gu, "\n").replace(/\n/gu, "\r\n") : value;
    case "checkbox": if (!["", "1"].includes(value)) throw new EditorValidationError("Invalid checkbox value."); return value;
    case "integer": if (value && !/^[+-]?\d+$/u.test(value)) throw new EditorValidationError("Enter a whole integer or clear the field."); return value;
    case "number": if (value && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(value)) throw new EditorValidationError("Enter a decimal number or clear the field (no commas, NaN or Infinity)."); return value;
    case "date":
      if (!value) return "";
      if (!validDate(value)) throw new EditorValidationError("Enter a valid date.");
      return `${value.replace(/-/gu, "")}T000000Z`;
    case "datetime": {
      if (!value) return "";
      const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/u.exec(value);
      if (!match || !validDate(match[1]) || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4] ?? 0) > 59) throw new EditorValidationError("Enter a valid date and time in UTC.");
      return `${match[1].replace(/-/gu, "")}T${match[2]}${match[3]}${match[4] ?? "00"}Z`;
    }
    default: throw new EditorValidationError("Unsupported field type.");
  }
}

export function assertItem(target: EditorTarget, item: AuthoringItemDetails): void {
  if (normalizeId(target.itemId) !== normalizeId(item.itemId) || target.language.toLowerCase() !== item.language.toLowerCase()
    || target.version !== item.version) throw new EditorValidationError("Authoring returned a different item, locale or numbered version.");
  const ids = item.fields.map(field => normalizeId(field.fieldId));
  if (new Set(ids).size !== ids.length) throw new EditorValidationError("Authoring returned duplicate field IDs.");
}

export function planChanges(state: EditorState): readonly EditorChange[] {
  assertItem(state.target, state.base);
  const changes: EditorChange[] = [];
  for (const [id, draft] of Object.entries(state.drafts)) {
    const field = state.base.fields.find(candidate => normalizeId(candidate.fieldId) === id);
    if (!field) throw new EditorValidationError("A draft field no longer exists.");
    const reason = readOnlyReason(state.base, field);
    if (reason) throw new EditorValidationError(reason);
    const value = serializeDraft(field, draft);
    if (value !== field.value || (draft.clear && (field.containsInheritedValue || field.containsStandardValue))) changes.push({ fieldId: id, name: field.name, value, scope: field.scope });
  }
  return changes;
}

function fingerprint(field: AuthoringItemField): string {
  return JSON.stringify([normalizeId(field.fieldId), field.name, field.type.toLowerCase(), field.scope, field.value,
    field.containsFallbackValue, field.containsInheritedValue, field.containsStandardValue, field.isStandardTemplate, field.selectionSource]);
}

export function checkConflicts(state: EditorState, fresh: AuthoringItemDetails, changes: readonly EditorChange[]): void {
  assertItem(state.target, fresh);
  if (normalizeId(state.base.template.templateId) !== normalizeId(fresh.template.templateId)) throw new EditorValidationError("Item template changed. Revert/reload before editing again.");
  for (const change of changes) {
    const old = state.base.fields.find(field => normalizeId(field.fieldId) === change.fieldId);
    const current = fresh.fields.find(field => normalizeId(field.fieldId) === change.fieldId);
    if (!old || !current || readOnlyReason(fresh, current) || fingerprint(old) !== fingerprint(current)) {
      throw new EditorValidationError(`Conflict in ${change.name}. Your draft is preserved; review the current saved values before retrying.`);
    }
  }
}

export function appliedChanges(fresh: AuthoringItemDetails, changes: readonly EditorChange[]): readonly EditorChange[] {
  return changes.filter(change => fresh.fields.some(field => normalizeId(field.fieldId) === change.fieldId && field.name === change.name
    && field.scope === change.scope && field.value === change.value && !field.containsFallbackValue
    && !field.containsInheritedValue && !field.containsStandardValue));
}

export interface EditorIO {
  read(): Promise<AuthoringItemDetails>;
  write(changes: readonly EditorChange[]): Promise<void>;
  validateSelections?(item: AuthoringItemDetails, changes: readonly EditorChange[]): Promise<void>;
  persist(state: EditorState): Promise<void>;
}

/** Persist the write intent before a non-retried mutation; readback is mandatory. */
export async function saveEditor(state: EditorState, io: EditorIO, update: (state: EditorState) => void): Promise<EditorState> {
  if (state.attempt) throw new EditorValidationError("The previous save needs reconciliation. No automatic retry is allowed.");
  const changes = planChanges(state);
  if (!changes.length) return state;
  const fresh = await io.read();
  checkConflicts(state, fresh, changes);
  if (changes.some(change => fresh.fields.some(field => normalizeId(field.fieldId) === change.fieldId && selectionKind(field)))) {
    if (!io.validateSelections) throw new EditorValidationError("Selection source validation is unavailable.");
    await io.validateSelections(fresh, changes);
  }
  let current: EditorState = { ...state, attempt: { phase: "sent", changes } };
  await io.persist(current);
  update(current);
  await io.write(changes);
  current = { ...current, attempt: { phase: "acknowledged", changes } };
  update(current);
  await io.persist(current);
  const readback = await io.read();
  assertItem(state.target, readback);
  if (appliedChanges(readback, changes).length !== changes.length) throw new EditorValidationError("Readback did not confirm every changed field. Save may be partial; reconcile before retrying.");
  current = { ...state, base: readback, drafts: {} };
  await io.persist(current);
  update(current);
  return current;
}

export async function reconcileEditor(state: EditorState, io: EditorIO): Promise<EditorState> {
  if (!state.attempt) return state;
  const fresh = await io.read();
  assertItem(state.target, fresh);
  const applied = appliedChanges(fresh, state.attempt.changes);
  if (applied.length === state.attempt.changes.length) return { ...state, base: fresh, drafts: {}, attempt: undefined };
  if (state.attempt.phase === "sent") throw new EditorValidationError("Remote outcome is still unknown. Readback does not prove a timed-out write has finished. Drafts remain blocked; inspect Sitecore before discarding/reloading.");
  const pending = state.attempt.changes.filter(change => !applied.includes(change));
  checkConflicts(state, fresh, pending);
  // An acknowledged, partially applied request can be reviewed and saved again explicitly.
  return { ...state, base: fresh, attempt: undefined };
}

/** Backups and local state are untrusted; reject malformed or excessive payloads. */
export function parseEditorState(text: string): EditorState {
  if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new EditorValidationError("Editor backup exceeds its size limit.");
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object") throw new EditorValidationError("Invalid editor backup.");
  const state = value as EditorState;
  const target = state.target;
  if (state.formatVersion !== 1 || !target || typeof target.connectionId !== "string" || !isGuid(target.itemId) || !isLocale(target.language)
    || !Number.isInteger(target.version) || target.version < 0 || typeof target.serverUrl !== "string") throw new EditorValidationError("Invalid editor target.");
  const url = new URL(target.serverUrl);
  if (url.protocol !== "https:" || url.origin !== target.serverUrl || url.username || url.password) throw new EditorValidationError("Invalid editor server.");
  const item = state.base;
  if (!item || !isGuid(item.itemId) || !isLocale(item.language) || typeof item.name !== "string" || typeof item.displayName !== "string"
    || typeof item.path !== "string" || !item.template || !isGuid(item.template.templateId) || typeof item.template.name !== "string"
    || !Array.isArray(item.fields) || item.fields.length > 4096 || !Array.isArray(item.availableVersions)) throw new EditorValidationError("Invalid editor item.");
  for (const field of item.fields) {
    if (field?.sectionId !== undefined && (typeof field.sectionId !== "string" || field.sectionId.length > 256)) throw new EditorValidationError("Invalid field section identity.");
    if (field?.selectionSource !== undefined && (typeof field.selectionSource !== "string" || field.selectionSource.length > 8192)) throw new EditorValidationError("Invalid field Source metadata.");
    if (!field || !isGuid(field.fieldId) || [field.name, field.label, field.value, field.type, field.typeKey, field.sectionName].some(v => typeof v !== "string")
      || !["SHARED", "UNVERSIONED", "VERSIONED"].includes(field.scope)
      || [field.containsFallbackValue, field.containsStandardValue, field.containsInheritedValue, field.isStandardTemplate].some(v => typeof v !== "boolean")
      || !Number.isFinite(field.sortOrder) || !Number.isFinite(field.sectionSortOrder)) throw new EditorValidationError("Invalid editor field.");
  }
  if (item.availableVersions.some(v => !v || !isLocale(v.language) || !Number.isInteger(v.version) || v.version < 1)) throw new EditorValidationError("Invalid editor versions.");
  assertItem(target, item);
  if (!state.drafts || typeof state.drafts !== "object" || Array.isArray(state.drafts)) throw new EditorValidationError("Invalid editor draft.");
  for (const [id, draft] of Object.entries(state.drafts)) {
    if (!/^[a-f0-9]{32}$/iu.test(id) || !draft || typeof draft.input !== "string" || draft.input.length > 1024 * 1024 || typeof draft.clear !== "boolean"
      || !item.fields.some(field => normalizeId(field.fieldId) === id)) throw new EditorValidationError("Invalid editor field draft.");
  }
  if (state.attempt) {
    if (!["sent", "acknowledged"].includes(state.attempt.phase) || !Array.isArray(state.attempt.changes) || !state.attempt.changes.length
      || state.attempt.changes.length > item.fields.length || state.attempt.changes.some(c => !c || !isGuid(c.fieldId)
        || typeof c.name !== "string" || typeof c.value !== "string" || !["SHARED", "UNVERSIONED", "VERSIONED"].includes(c.scope))) throw new EditorValidationError("Invalid editor save journal.");
  }
  if (state.attempt) {
    const planned = planChanges({ ...state, attempt: undefined });
    if (JSON.stringify(planned) !== JSON.stringify(state.attempt.changes)) throw new EditorValidationError("Save journal does not match the retained draft.");
  }
  return state;
}
