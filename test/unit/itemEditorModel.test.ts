import { test } from "node:test";
import { strictEqual, deepStrictEqual, throws, rejects } from "node:assert/strict";
import { editorKey, fieldInput, readOnlyReason, serializeDraft, parseEditorState, planChanges, checkConflicts, saveEditor, reconcileEditor, type EditorState } from "../../src/editor/itemEditorModel";
import type { AuthoringItemField, AuthoringItemDetails } from "../../src/sitecore/authoringClient";
const id = "11111111111111111111111111111111";
const fieldId = "22222222222222222222222222222222";
const field = (type = "Single-Line Text", value = "original"): AuthoringItemField => ({ fieldId, name: "Title", label: "Title", value, type, typeKey: type,
  scope: "VERSIONED", sortOrder: 0, sectionSortOrder: 0, sectionName: "Content", isStandardTemplate: false,
  containsFallbackValue: false, containsInheritedValue: false, containsStandardValue: false, textual: true });
const item = (f = field()): AuthoringItemDetails => ({ itemId: id, name: "Item", displayName: "Item", path: "/sitecore/content/Test", language: "en-AU", version: 2,
  hasChildren: false, template: { templateId: "33333333333333333333333333333333", name: "Component" }, availableVersions: [{ language: "en-AU", version: 2 }], fields: [f] });
const state = (): EditorState => ({ formatVersion: 1, target: { connectionId: "dev", serverUrl: "https://example.test", itemId: id, language: "en-AU", version: 2 }, base: item(), drafts: { [fieldId]: { input: "changed", clear: false } } });

test("editor preserves untouched representations and numeric precision", () => {
  for (const f of [field("Checkbox", "0"), field("Number", "0001.230000000000000000000"), field("Multi-Line Text", " a\r\nb "), field("Date", "20261014T000000"), field("Datetime", "20261014T123456Z")]) {
    strictEqual(serializeDraft(f, { input: fieldInput(f), clear: false }), f.value);
  }
  strictEqual(serializeDraft(field("Number"), { input: "900719925474099312345.000001", clear: false }), "900719925474099312345.000001");
  strictEqual(serializeDraft(field("Multi-Line Text", "a\r\nb"), { input: "c\nd", clear: false }), "c\r\nd");
  strictEqual(serializeDraft(field(), { input: "  x  ", clear: false }), "  x  ");
});
test("editor validates calendar/time/integer values without browser timezone conversion", () => {
  strictEqual(serializeDraft(field("Date", ""), { input: "2024-02-29", clear: false }), "20240229T000000Z");
  strictEqual(serializeDraft(field("Datetime", ""), { input: "2026-10-14T12:34", clear: false }), "20261014T123400Z");
  for (const [type, input] of [["Integer", "1.2"], ["Number", "NaN"], ["Date", "2025-02-29"], ["Datetime", "2026-10-14T24:01"]]) {
    throws(() => serializeDraft(field(type, ""), { input, clear: false }));
  }
  strictEqual(serializeDraft(field(), { input: "ignored", clear: true }), "");
  strictEqual(Boolean(readOnlyReason(item(field("Datetime", "20261014T123456")), field("Datetime", "20261014T123456"))), true);
});
test("unsupported/system/fallback and absent versions cannot produce writes", () => {
  for (const f of [field("Rich Text"), field("Image"), { ...field(), containsFallbackValue: true }, { ...field(), name: "__Title" }]) {
    throws(() => planChanges({ ...state(), base: item(f) }));
  }
  throws(() => planChanges({ ...state(), target: { ...state().target, version: 0 }, base: { ...item(), version: 0 } }));
});
test("editor identity separates connection locale version and rejects malformed backups", () => {
  const original = state(); deepStrictEqual(parseEditorState(JSON.stringify(original)), original);
  strictEqual(editorKey(original.target), editorKey({ ...original.target, itemId: "{11111111-1111-1111-1111-111111111111}", language: "EN-au" }));
  for (const patch of [{ connectionId: "other" }, { language: "en" }, { version: 3 }]) strictEqual(editorKey(original.target) === editorKey({ ...original.target, ...patch }), false);
  throws(() => parseEditorState(JSON.stringify({ ...original, base: { ...item(), language: "en" } })));
  throws(() => parseEditorState(JSON.stringify({ ...original, attempt: { phase: "sent", changes: [{ ...planChanges(original)[0], value: "tampered" }] } })));
});
test("conflicts include source, scope, template and identity changes", () => {
  for (const fresh of [{ ...item(), language: "en" }, { ...item(), version: 3 }, item({ ...field(), value: "other" }), item({ ...field(), scope: "SHARED" }), item({ ...field(), containsStandardValue: true })]) {
    throws(() => checkConflicts(state(), fresh, planChanges(state())));
  }
});
test("save persists intent before one write, acknowledgement before pinned readback", async () => {
  const sequence: string[] = []; let reads = 0; let current = state();
  const result = await saveEditor(current, {
    read: async () => { sequence.push("read"); return ++reads === 1 ? item() : item(field("Single-Line Text", "changed")); },
    write: async changes => { sequence.push("write"); strictEqual(changes.length, 1); },
    persist: async value => { sequence.push(value.attempt?.phase ?? "clean"); },
  }, value => { current = value; });
  deepStrictEqual(sequence, ["read", "sent", "write", "acknowledged", "read", "clean"]);
  deepStrictEqual(result.drafts, {}); strictEqual(current.attempt, undefined);
});
test("persistence failure prevents mutation; unknown outcome survives backup and blocks replay", async () => {
  let writes = 0; let current = state();
  await rejects(saveEditor(current, { read: async () => item(), persist: async () => { throw Error("disk"); }, write: async () => { writes++; } }, () => {}));
  strictEqual(writes, 0);
  const io = { read: async () => item(), persist: async () => {}, write: async () => { writes++; throw Error("timeout"); } };
  await rejects(saveEditor(current, io, value => { current = value; }));
  current = parseEditorState(JSON.stringify(current)); strictEqual(current.attempt?.phase, "sent");
  await rejects(saveEditor(current, io, () => {}), /reconciliation/);
  await rejects(reconcileEditor(current, io), /still unknown/); strictEqual(writes, 1);
  const recovered = await reconcileEditor(current, { ...io, read: async () => item(field("Single-Line Text", "changed")) });
  deepStrictEqual(recovered.drafts, {});
});
test("acknowledged but unconfirmed save preserves draft for explicit reconciliation", async () => {
  let current = state();
  const io = { read: async () => item(), persist: async () => {}, write: async () => {} };
  await rejects(saveEditor(current, io, value => { current = value; }), /partial/);
  strictEqual(current.attempt?.phase, "acknowledged");
  const reconciled = await reconcileEditor(current, io);
  strictEqual(reconciled.attempt, undefined); strictEqual(planChanges(reconciled).length, 1);
});


test("clearing inherited empty content requests explicit empty, while untouched inherited fields do not write", () => {
  const original = state();
  const inherited = { ...field("Single-Line Text", ""), containsStandardValue: true };
  strictEqual(planChanges({ ...original, base: item(inherited), drafts: {} }).length, 0);
  strictEqual(planChanges({ ...original, base: item(inherited), drafts: { [fieldId]: { input: "", clear: true } } })[0].value, "");
});


test("partial acknowledgement reconciles applied fields and retains only the remaining write", async () => {
  const secondId = "44444444444444444444444444444444";
  const original = state();
  const base = { ...item(), fields: [field(), { ...field(), fieldId: secondId, name: "Other" }] };
  const draft = { ...original, base, drafts: { ...original.drafts, [secondId]: { input: "other change", clear: false } } };
  const pending: EditorState = { ...draft, attempt: { phase: "acknowledged", changes: planChanges(draft) } };
  const fresh = { ...base, fields: [{ ...field(), value: "changed" }, base.fields[1]] };
  const reconciled = await reconcileEditor(pending, { read: async () => fresh, write: async () => { throw Error("must not write"); }, persist: async () => {} });
  deepStrictEqual(planChanges(reconciled).map(c => c.fieldId), [secondId]);
});
test("cancelled pre-save read cannot persist intent or mutate", async () => {
  let writes = 0; let persisted = 0;
  await rejects(saveEditor(state(), { read: async () => { throw new DOMException("Cancelled", "AbortError"); },
    write: async () => { writes++; }, persist: async () => { persisted++; } }, () => {}));
  strictEqual(writes, 0); strictEqual(persisted, 0);
});
