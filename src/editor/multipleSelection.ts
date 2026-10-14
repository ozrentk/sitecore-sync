import type { AuthoringItemField } from "../sitecore/authoringClient";
import { EditorValidationError, normalizeId } from "./itemEditorModel";
import { isTreeSelection, loadSelectionPage, selectionKind, selectionSourceReason, validateSelection, type SelectionIO } from "./singleSelection";

export const multipleSelectionLimit = 256;
/** Retain each original token exactly; never repair duplicates or malformed legacy values. */
export function parseMultipleSelection(value: string): readonly string[] {
  if (!value) return [];
  const tokens = value.split("|");
  const guid = /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|\{[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\})$/iu;
  if (tokens.length > multipleSelectionLimit || tokens.some(token => !guid.test(token))
    || new Set(tokens.map(normalizeId)).size !== tokens.length) {
    throw new EditorValidationError("Stored selection is malformed, duplicated or exceeds 256 references; it is preserved read-only.");
  }
  return tokens;
}
export function validateMultipleDraft(field: AuthoringItemField, value: string): readonly string[] {
  const original = parseMultipleSelection(field.value);
  const next = parseMultipleSelection(value);
  const originals = new Map(original.map(token => [normalizeId(token), token]));
  for (const token of next) {
    const previous = originals.get(normalizeId(token));
    if (previous !== undefined && previous !== token) throw new EditorValidationError("Existing reference representations must be preserved.");
  }
  if (selectionKind(field) === "checklist") {
    const retained = next.filter(token => originals.has(normalizeId(token)));
    if (retained.join("|") !== original.filter(token => retained.includes(token)).join("|")) throw new EditorValidationError("Checklist selections cannot be reordered.");
  }
  return next;
}
/** Retained legacy/out-of-source references are not additions. Validate only new IDs against fresh Source. */
export async function validateMultipleSelection(field: AuthoringItemField, value: string, io: SelectionIO): Promise<void> {
  const reason = selectionSourceReason(field.selectionSource, selectionKind(field));
  if (reason) throw new EditorValidationError(reason);
  const next = validateMultipleDraft(field, value);
  const original = new Set(parseMultipleSelection(field.value).map(normalizeId));
  const additions = next.filter(token => !original.has(normalizeId(token)));
  const kind = selectionKind(field)!;
  if (isTreeSelection(kind)) {
    await validateSelection(field, "", io);
    for (const token of additions) await validateSelection(field, token, io);
  } else {
    const page = await loadSelectionPage(field, io);
    const allowed = new Set(page.choices.filter(choice => !choice.disabled).map(choice => normalizeId(choice.itemId)));
    if (additions.some(token => !allowed.has(normalizeId(token)))) throw new EditorValidationError("A newly added selection is unavailable or outside the current Source. Reload choices.");
  }
}
