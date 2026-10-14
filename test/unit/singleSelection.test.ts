import { test } from "node:test";
import { deepStrictEqual, strictEqual, rejects, throws, match } from "node:assert/strict";
import { loadSelectionPage, selectionSourceReason, selectionValue, validateSelection, type SelectionIO } from "../../src/editor/singleSelection";
import { loadSelectionMetadata, selectionIO } from "../../src/editor/selectionClient";
import { checkConflicts, planChanges, saveEditor, serializeDraft, type EditorState } from "../../src/editor/itemEditorModel";
import type { AuthoringContentClient, AuthoringItemField, AuthoringTreeItem } from "../../src/sitecore/authoringClient";
import { testConnection } from "./sitecoreClientTestHelpers";
const id = (n: number) => n.toString(16).padStart(32, "0");
const node = (n: number, name: string, path: string): AuthoringTreeItem => ({ itemId: id(n), name, displayName: name, path, hasChildren: true });
const root = node(1, "Root", "/sitecore/content/Root");
const group = node(2, "Group", root.path + "/Group");
const first = node(3, "First", group.path + "/First");
const second = node(4, "Second", group.path + "/Second");
const field = (type = "Droplink"): AuthoringItemField => ({ fieldId: id(10), name: "Choice", label: "Choice", type, typeKey: type, value: "missing-original",
  scope: "VERSIONED", sortOrder: 0, sectionSortOrder: 0, sectionName: "Content", isStandardTemplate: false, containsFallbackValue: false, containsInheritedValue: false, containsStandardValue: false, textual: false, selectionSource: root.path });
const nodes = [root, group, first, second];
const io: SelectionIO = { item: async locator => {
  const item = nodes.find(n => "itemId" in locator ? n.itemId === locator.itemId.replace(/[{}-]/g, "").toLowerCase() : n.path === locator.path);
  if (!item) throw Error("not found"); return item;
}, children: async locator => { const item = await io.item(locator); return { item, children: nodes.filter(n => n.path.slice(0, n.path.lastIndexOf("/")) === item.path) }; } };
function state(f = field()): EditorState { return { formatVersion: 1, target: { connectionId: "test", serverUrl: "https://example.test", itemId: id(20), language: "en", version: 1 }, drafts: {}, base: {
  itemId: id(20), name: "Item", displayName: "Item", path: "/sitecore/content/Item", language: "en", version: 1, hasChildren: false, template: { templateId: id(21), name: "Component" }, availableVersions: [], fields: [f] } }; }

test("selection source allowlist never broadens queries, relative paths, tokens, parameters or empty sources", () => {
  for (const value of [undefined, "", " ", "query:./*", "./Data", "$site/Data", "DataSource=/sitecore/content", "/sitecore/content/*", "/sitecore/content/../Other", "/sitecore/content?filter=x", "https://other.test", "/sitecore//content"]) strictEqual(Boolean(selectionSourceReason(value)), true, String(value));
  for (const value of [root.path, id(1), "{00000000-0000-0000-0000-000000000001}"]) strictEqual(selectionSourceReason(value), undefined);
});
test("flat children, grouped grandchildren and lazy tree branches obey Source boundaries", async () => {
  deepStrictEqual((await loadSelectionPage(field(), io)).choices.map(c => c.itemId), [group.itemId]);
  const grouped = await loadSelectionPage(field("Grouped Droplist"), io);
  deepStrictEqual(grouped.choices.map(c => c.name), ["First", "Second"]); match(grouped.choices[0].group!, /Group/);
  deepStrictEqual((await loadSelectionPage(field("Droptree"), io, group.itemId)).choices.map(c => c.itemId), [first.itemId, second.itemId]);
  await rejects(loadSelectionPage(field(), io, group.itemId), /branch/);
  await rejects(loadSelectionPage(field("Droptree"), { ...io, item: async l => "itemId" in l ? { ...group, path: "/sitecore/content/Elsewhere" } : root }, group.itemId), /outside/);
});
test("selection stores names or canonical single IDs while untouched unresolved values stay byte-for-byte", async () => {
  strictEqual(selectionValue("droplist", first), "First"); strictEqual(selectionValue("grouped droplist", first), "First");
  strictEqual(selectionValue("droplink", first), "{00000000-0000-0000-0000-000000000003}");
  for (const type of ["Droplist", "Droplink", "Grouped Droplist", "Grouped Droplink", "Droptree"]) {
    const f = field(type); strictEqual(serializeDraft(f, { input: f.value, clear: false }), f.value);
    deepStrictEqual(planChanges(state(f)), []);
    deepStrictEqual(planChanges({ ...state(f), drafts: { [f.fieldId]: { input: f.value, clear: false } } }), []);
  }
  await validateSelection(field(), selectionValue("droplink", group), io);
  await rejects(validateSelection(field(), first.itemId, io), /outside/);
  await validateSelection(field("Grouped Droplist"), "First", io);
  await rejects(validateSelection(field("Grouped Droplist"), first.itemId, io), /outside/);
  await validateSelection(field("Droptree"), first.itemId, io);
  await rejects(validateSelection(field("Droptree"), root.itemId, io), /outside/);
  await validateSelection(field(), "", io);
});
test("duplicate names are disabled, missing and inconsistent children are rejected, limits fail closed", async () => {
  const duplicateIO = { ...io, children: async () => ({ item: root, children: [group, { ...group, itemId: id(9) }] }) };
  strictEqual((await loadSelectionPage(field("Droplist"), duplicateIO)).choices.every(c => !!c.disabled), true);
  await rejects(validateSelection(field("Droplist"), "Group", duplicateIO), /ambiguous/);
  await rejects(loadSelectionPage(field(), { ...io, children: async () => ({ item: root, children: [first] }) }), /inconsistent/);
  await rejects(loadSelectionPage(field(), { ...io, children: async () => ({ item: root, children: Array(1001).fill(group) }) }), /1,000/);
  await rejects(loadSelectionPage(field(), { ...io, item: async () => { throw Error("inaccessible"); } }), /inaccessible/);
});
test("save rejects changed Source, forged choices, missing validator and fallback before persisting intent", async () => {
  const initial = state(); const draft = { ...initial, drafts: { [field().fieldId]: { input: group.itemId, clear: false } } };
  throws(() => checkConflicts(draft, { ...initial.base, fields: [{ ...field(), selectionSource: "/sitecore/content/Other" }] }, planChanges(draft)), /Conflict/);
  throws(() => planChanges({ ...draft, base: { ...initial.base, fields: [{ ...field(), containsFallbackValue: true }] } }), /Fallback/);
  let writes = 0; let persisted = 0;
  const saveIO = { read: async () => initial.base, persist: async () => { persisted++; }, write: async () => { writes++; } };
  await rejects(saveEditor(draft, saveIO, () => {}), /validation is unavailable/);
  await rejects(saveEditor(draft, { ...saveIO, validateSelections: async () => { throw Error("Source changed"); } }, () => {}), /Source changed/);
  strictEqual(writes, 0); strictEqual(persisted, 0);
});
test("unresolved selections do not participate when another field is saved", async () => {
  const initial = state({ ...field(), selectionSource: "query:unsupported" });
  const other = { ...field("Single-Line Text"), fieldId: id(11), name: "Other", value: "old" };
  const draft = { ...initial, base: { ...initial.base, fields: [...initial.base.fields, other] }, drafts: { [other.fieldId]: { input: "new", clear: false } } };
  let reads = 0;
  const saved = await saveEditor(draft, { read: async () => ++reads === 1 ? draft.base : { ...draft.base, fields: [draft.base.fields[0], { ...other, value: "new" }] },
    write: async changes => deepStrictEqual(changes.map(c => c.fieldId), [other.fieldId]), persist: async () => {} }, () => {});
  strictEqual(saved.base.fields[0].value, "missing-original");
});
test("Source metadata uses the edited connection and locale; unavailable definitions affect only that field", async () => {
  const initial = state(); const calls: unknown[][] = [];
  const client = { loadItem: async (...args: unknown[]) => { calls.push(args); return { ...initial.base, itemId: field().fieldId, path: "/sitecore/templates/Example/Choice", fields: [
    { ...field(), name: "Source", scope: "SHARED", value: root.path }, { ...field(), name: "Type", value: "Droplink", scope: "SHARED" }] }; } } as unknown as AuthoringContentClient;
  const result = await loadSelectionMetadata(client, testConnection, "secret", initial.base, new AbortController().signal);
  strictEqual(result.fields[0].selectionSource, root.path); strictEqual(calls[0][0], testConnection); strictEqual(calls[0][3], "en"); strictEqual(calls[0][7], true);
  const unavailable = await loadSelectionMetadata({ loadItem: async () => { throw Error("denied"); } } as unknown as AuthoringContentClient, testConnection, "secret", initial.base, new AbortController().signal);
  strictEqual(unavailable.fields[0].selectionSource, undefined);
  const abort = new AbortController(); abort.abort();
  await rejects(loadSelectionMetadata(client, testConnection, "secret", initial.base, abort.signal));
});
test("selection clients isolate locale/connection identity and propagate cancellation and bounded paging", async () => {
  const calls: unknown[][] = [];
  const client = { loadSelectionItem: async (...args: unknown[]) => { calls.push(args); return root; }, loadTreeLevel: async (...args: unknown[]) => { calls.push(args); return { item: root, children: [] }; } } as unknown as AuthoringContentClient;
  const signal = new AbortController().signal;
  await selectionIO(client, testConnection, "secret", "en-AU", signal).item({ itemId: root.itemId });
  await selectionIO(client, { ...testConnection, id: "other" }, "other-secret", "en-NZ", signal).children({ itemId: root.itemId });
  strictEqual(calls[0][3], "en-AU"); strictEqual(calls[1][3], "en-NZ"); strictEqual(calls[1][4], signal); strictEqual(calls[1][5], 1000);
  strictEqual((calls[1][0] as { id: string }).id, "other");
});

test("version-zero template definitions use an advertised existing version only for shared metadata", async () => {
  const initial = state(); const calls: unknown[][] = [];
  const client = { loadItem: async (...args: unknown[]) => { calls.push(args); return calls.length === 1
    ? { ...initial.base, itemId: field().fieldId, version: 0, fields: [], availableVersions: [{ language: "en", version: 1 }] }
    : { ...initial.base, itemId: field().fieldId, language: "en", path: "/sitecore/templates/Example/Choice", fields: [
      { ...field(), name: "Source", scope: "SHARED", value: root.path }, { ...field(), name: "Type", scope: "SHARED", value: "Droplink" }] }; } } as unknown as AuthoringContentClient;
  const result = await loadSelectionMetadata(client, testConnection, "secret", { ...initial.base, language: "en-AU" }, new AbortController().signal);
  strictEqual(calls[0][3], "en-AU"); strictEqual(calls[1][3], "en"); strictEqual(calls[1][4], 1);
  strictEqual(result.language, "en-AU"); strictEqual(result.fields[0].selectionSource, root.path);
});

test("successful selection save validates fresh membership before intent and preserves reference encoding", async () => {
  for (const type of ["Droplist", "Droplink", "Grouped Droplist", "Grouped Droplink", "Droptree"]) {
    const f = field(type); const selected = type.startsWith("Grouped") || type === "Droptree" ? first : group;
    const value = type.includes("Droplist") ? selected.name : selectionValue("droplink", selected);
    const initial = state(f); const draft = { ...initial, drafts: { [f.fieldId]: { input: value, clear: false } } };
    let reads = 0; const order: string[] = [];
    const saved = await saveEditor(draft, {
      read: async () => ++reads === 1 ? initial.base : { ...initial.base, fields: [{ ...f, value }] },
      validateSelections: async (fresh, changes) => { order.push("validate"); await validateSelection(fresh.fields[0], changes[0].value, io); },
      persist: async state => { order.push(state.attempt?.phase ?? "clean"); },
      write: async changes => { order.push("write"); strictEqual(changes[0].value, value); },
    }, () => {});
    deepStrictEqual(order, ["validate", "sent", "write", "acknowledged", "clean"]);
    deepStrictEqual(saved.drafts, {});
  }
});
