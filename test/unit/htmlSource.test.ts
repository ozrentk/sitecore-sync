import { test } from "node:test";
import { strictEqual, deepStrictEqual, rejects } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { fieldInput, readOnlyReason, serializeDraft, parseEditorState, planChanges, saveEditor, reconcileEditor, type EditorState } from "../../src/editor/itemEditorModel";
interface Range { start: number; end: number }
interface Tools {
  normalize(raw: string): string;
  offset(raw: string, position: number): number;
  replace(raw: string, start: number, end: number, inserted: string): string;
  reconcile(raw: string, value: string, before?: Range, after?: Range, inputType?: string): string;
}
const context: { htmlSourceTools?: Tools } = {};
runInNewContext(readFileSync("media/itemEditor/htmlSource.js", "utf8"), context);
const tools = context.htmlSourceTools!;
const fieldId = "22222222222222222222222222222222";
function fixture(raw: string): EditorState {
  const itemId = "11111111111111111111111111111111";
  return { formatVersion: 1, target: { connectionId: "test", serverUrl: "https://example.test", itemId, language: "en", version: 1 }, drafts: {},
    base: { itemId, name: "Component", displayName: "Component", path: "/sitecore/content/Test", language: "en", version: 1, hasChildren: false,
      template: { templateId: "33333333333333333333333333333333", name: "Component" }, availableVersions: [{ language: "en", version: 1 }],
      fields: [{ fieldId, name: "Text", label: "Text", type: "Rich Text", typeKey: "rich text", value: raw, scope: "VERSIONED", sortOrder: 0,
        sectionSortOrder: 0, sectionName: "Data", isStandardTemplate: false, containsFallbackValue: false, containsInheritedValue: false, containsStandardValue: false, textual: true }] } };
}
test("HTML textarea projection maps edits without normalizing untouched newline sequences", () => {
  const raw = "A\r\nB\nC\rD";
  strictEqual(tools.normalize(raw), "A\nB\nC\nD");
  strictEqual(tools.reconcile(raw, tools.normalize(raw)), raw);
  strictEqual(tools.reconcile(raw, "A\nBX\nC\nD", { start: 3, end: 3 }, { start: 4, end: 4 }, "insertText"), "A\r\nBX\nC\rD");
  strictEqual(tools.reconcile(raw, "A\nB\nC\n\nD", { start: 6, end: 6 }, { start: 7, end: 7 }, "insertLineBreak"), "A\r\nB\nC\r\rD");
  strictEqual(tools.replace(raw, 2, 3, "<p>\r\nX\nY\r</p>"), "A\r\n<p>\r\nX\nY\r</p>\nC\rD");
  // Identical displayed newline runs must remove the selected raw break, not a different one.
  strictEqual(tools.reconcile("\r\n\n", "\n", { start: 1, end: 1 }, { start: 0, end: 0 }, "deleteContentBackward"), "\n");
  strictEqual(tools.reconcile("\r\n\n", "\n", { start: 0, end: 0 }, { start: 0, end: 0 }, "deleteContentForward"), "\n");
  strictEqual(tools.reconcile("\r\n\n", "\n", { start: 1, end: 2 }, { start: 1, end: 1 }, "deleteContentBackward"), "\r\n");
  strictEqual(tools.replace("😀\r\nZ", 2, 3, ""), "😀Z");
});
test("HTML source preserves empty malformed hostile and large values through drafts and backups", () => {
  for (const raw of ["", "<P x='a' x='b'>&amp;\r\n<!--keep-->\n<br>\r", '<script>alert(1)</script><style>@import "https://example.test";</style>', "x".repeat(300000)]) {
    const state = fixture(raw); const field = state.base.fields[0];
    strictEqual(readOnlyReason(state.base, field), undefined);
    strictEqual(fieldInput(field), raw); strictEqual(serializeDraft(field, { input: raw, clear: false }), raw);
    deepStrictEqual(planChanges({ ...state, drafts: { [fieldId]: { input: raw, clear: false } } }), []);
    const input = raw + "\r\n<!--edit-->\r";
    const draft = parseEditorState(JSON.stringify({ ...state, drafts: { [fieldId]: { input, clear: false } } }));
    strictEqual(planChanges(draft)[0].value, input);
    strictEqual(serializeDraft(field, { input, clear: true }), "");
  }
  const tooLarge = fixture("x".repeat(1024 * 1024 + 1));
  strictEqual(readOnlyReason(tooLarge.base, tooLarge.base.fields[0])?.includes("limit"), true);
});
test("HTML uses existing conflict and unknown-outcome journal without normalization or mutation retries", async () => {
  const original = "<p>old\r\n</p>";
  const edited = "<P>new\r\n\n\r&amp;</P>";
  let state = { ...fixture(original), drafts: { [fieldId]: { input: edited, clear: false } } } as EditorState;
  let remote = fixture("<p>conflict</p>").base; let writes = 0;
  const io = { read: async () => remote, persist: async () => {},
    write: async (changes: readonly { value: string }[]) => { writes++; strictEqual(changes[0].value, edited); remote = fixture(edited).base; throw Error("timeout"); } };
  await rejects(saveEditor(state, io, next => { state = next; }), /Conflict/);
  strictEqual(writes, 0); strictEqual(state.drafts[fieldId].input, edited);
  remote = fixture(original).base;
  await rejects(saveEditor(state, io, next => { state = next; }), /timeout/);
  state = parseEditorState(JSON.stringify(state));
  await rejects(saveEditor(state, io, () => {}), /reconciliation/); strictEqual(writes, 1);
  state = await reconcileEditor(state, io);
  strictEqual(state.base.fields[0].value, edited); deepStrictEqual(state.drafts, {});
});

test("HTML and ordinary fields share one changed-only plan without rewriting untouched rich content", () => {
  const state = fixture("<P>raw\r\n\n\r&amp;</P>");
  const text = { ...state.base.fields[0], fieldId: "44444444444444444444444444444444", name: "Title", type: "Single-Line Text", typeKey: "single-line text", value: "Old" };
  const base = { ...state.base, fields: [...state.base.fields, text] };
  const titleDraft = { input: "New", clear: false };
  const titleOnly = planChanges({ ...state, base, drafts: { [text.fieldId]: titleDraft } });
  strictEqual(titleOnly.length, 1); strictEqual(titleOnly[0].value, "New");
  const edited = state.base.fields[0].value + "<!--edit-->";
  const both = planChanges({ ...state, base, drafts: { [text.fieldId]: titleDraft, [fieldId]: { input: edited, clear: false } } });
  strictEqual(both.length, 2); strictEqual(both.find(change => change.fieldId === fieldId)?.value, edited);
});
