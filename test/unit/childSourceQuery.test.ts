import { test } from "node:test";
import { deepStrictEqual, strictEqual, rejects, match } from "node:assert/strict";
import { childQueryTemplate, loadSelectionPage, selectionSourceReason, validateSelection, type SelectionIO } from "../../src/editor/singleSelection";
import { validateMultipleSelection } from "../../src/editor/multipleSelection";
import { planChanges, readOnlyReason, saveEditor, type EditorState } from "../../src/editor/itemEditorModel";
import { selectionIO } from "../../src/editor/selectionClient";
import { AuthoringContentClient, type AuthoringItemField } from "../../src/sitecore/authoringClient";
import { QueuedHttpRuntime, jsonResponse, tokenResponse, noOpLogger, testConnection, requestBody } from "./sitecoreClientTestHelpers";

const id = (n: number) => n.toString(16).padStart(32, "0");
const template = "f8fa08624c8b4aa19433a9b409dfeb5e";
const source = "query:./child::*[@@templateid= '{F8FA0862-4C8B-4AA1-9433-A9B409DFEB5E}']";
const root = { itemId: id(1), name: "Panel", displayName: "Panel", path: "/sitecore/content/Panel", hasChildren: true };
const child = { ...root, itemId: id(2), name: "Hotspot", path: root.path + "/Hotspot", templateId: template };
const other = { ...child, itemId: id(3), name: "Other", path: root.path + "/Other", templateId: id(98) };
const field: AuthoringItemField = { fieldId: id(10), name: "hotspots", label: "hotspots", value: id(99), type: "Multilist", typeKey: "multilist", scope: "VERSIONED", sortOrder: 0, sectionSortOrder: 0, sectionName: "Content", isStandardTemplate: false, containsFallbackValue: false, containsInheritedValue: false, containsStandardValue: false, textual: false, selectionSource: source };
const io: SelectionIO = { contextItemId: root.itemId, item: async locator => { deepStrictEqual(locator, { itemId: root.itemId }); return root; }, children: async locator => { deepStrictEqual(locator, { itemId: root.itemId }); return { item: root, children: [other, child] }; } };
const state: EditorState = { formatVersion: 1, target: { connectionId: testConnection.id, serverUrl: testConnection.serverUrl, itemId: root.itemId, language: "en", version: 1 }, base: { ...root, language: "en", version: 1, template: { templateId: id(50), name: "Panel" }, availableVersions: [], fields: [field] }, drafts: {} };

test("child Source parser accepts the reported query and equivalent GUIDs/whitespace only", () => {
  for (const value of [source, `query:./*[@@templateid='${template}']`, ` \nquery: . / child :: * [ @@templateid = "f8fa0862-4c8b-4aa1-9433-a9b409dfeb5e" ] \n`]) strictEqual(childQueryTemplate(value), template);
  for (const value of [source + "|query:./*", source + " garbage", source.replace("=", "!="), source.replace("child", "descendant"), source.replace("./", ".//"), source.replace("@@templateid", "@@templatename"), source.replace("']", "' or @x='1']"), source.replace("}", ""), "query:./*", `query:./*[@@templateid='${template}' ][1]`, "query:ancestor::*"]) {
    strictEqual(childQueryTemplate(value), undefined, value); strictEqual(Boolean(selectionSourceReason(value, "multilist")), true);
  }
  for (const type of ["Droplist", "Droplink", "Checklist", "Multilist"]) strictEqual(readOnlyReason(state.base, { ...field, type }), undefined);
  for (const type of ["Grouped Droplist", "Grouped Droplink", "Droptree", "Treelist", "TreelistEx"]) match(readOnlyReason(state.base, { ...field, type })!, /Grouped and tree/);
});

test("child queries use edited context and exact direct template equality without descending", async () => {
  deepStrictEqual((await loadSelectionPage(field, io)).choices, [child]);
  await rejects(loadSelectionPage(field, { ...io, contextItemId: undefined }), /context/);
  await rejects(loadSelectionPage(field, { ...io, item: async () => ({ ...root, itemId: id(8) }) }), /different edited item/);
  await rejects(loadSelectionPage(field, io, child.itemId), /branch/);
  await rejects(loadSelectionPage(field, { ...io, children: async () => ({ item: root, children: [{ ...child, path: child.path + "/Nested" }] }) }), /inconsistent/);
  await rejects(validateSelection({ ...field, type: "Droplink" }, other.itemId, io), /outside/);
  await validateSelection({ ...field, type: "Droplink" }, child.itemId, io);
  await validateSelection({ ...field, type: "Droplist" }, child.name, io);
});

test("missing template metadata and permission errors fail closed; empty result stays empty", async () => {
  await rejects(loadSelectionPage(field, { ...io, children: async () => ({ item: root, children: [{ ...child, templateId: undefined }] }) }), /metadata/);
  await rejects(loadSelectionPage(field, { ...io, children: async () => { throw Error("permission denied"); } }), /permission/);
  deepStrictEqual((await loadSelectionPage(field, { ...io, children: async () => ({ item: root, children: [other] }) })).choices, []);
});

test("query lists preserve retained outside-source IDs and unchanged bytes, including additions/reorders", async () => {
  deepStrictEqual(planChanges(state), []);
  await validateMultipleSelection(field, `${field.value}|${child.itemId}`, io);
  await validateMultipleSelection({ ...field, value: `${field.value}|${child.itemId}` }, `${child.itemId}|${field.value}`, io);
  await validateMultipleSelection(field, "", io);
  await rejects(validateMultipleSelection(field, `${field.value}|${other.itemId}`, io), /outside/);
});

test("query Save rejects Source or child-template drift before intent or mutation", async () => {
  const draft = { ...state, drafts: { [field.fieldId]: { input: `${field.value}|${child.itemId}`, clear: false } } };
  for (const sourceChanged of [true, false]) {
    let writes = 0; let persists = 0;
    await rejects(saveEditor(draft, {
      read: async () => sourceChanged ? { ...state.base, fields: [{ ...field, selectionSource: source.replace("F8FA0862", "A8FA0862") }] } : state.base,
      validateSelections: async (fresh, changes) => validateMultipleSelection(fresh.fields[0], changes[0].value, { ...io, children: async () => ({ item: root, children: [{ ...child, templateId: other.templateId }] }) }),
      persist: async () => { persists++; }, write: async () => { writes++; },
    }, () => {}), sourceChanged ? /Conflict/ : /outside/);
    strictEqual(writes, 0); strictEqual(persists, 0);
  }
});

test("query resolution follows all Authoring child pages in the captured connection and locale", async () => {
  const raw = (item: typeof root & { templateId?: string }) => ({ ...item, language: { name: "en-AU" }, template: { templateId: item.templateId } });
  const page = (item: typeof child, more: boolean) => jsonResponse({ data: { item: { ...raw(root), children: { nodes: [raw(item)], pageInfo: { hasNextPage: more, endCursor: more ? "next" : null } } } } });
  const runtime = new QueuedHttpRuntime([tokenResponse(), jsonResponse({ data: { item: raw(root) } }), page(other, true), page(child, false)]);
  const client = new AuthoringContentClient(noOpLogger, runtime);
  const abort = new AbortController();
  const bound = selectionIO(client, testConnection, "secret", "en-AU", abort.signal, root.itemId);
  deepStrictEqual((await loadSelectionPage(field, bound)).choices.map(c => c.itemId), [child.itemId]);
  for (const index of [1, 2, 3]) {
    deepStrictEqual((requestBody(runtime, index).variables as { where: unknown }).where, { database: "master", itemId: root.itemId, language: "en-AU" });
    strictEqual(new URL(runtime.requests[index].input).origin, testConnection.serverUrl);
  }
  match(String(requestBody(runtime, 2).query), /template\s*\{\s*templateId/u);
  strictEqual((requestBody(runtime, 3).variables as { after: string }).after, "next");
  abort.abort(); await rejects(loadSelectionPage(field, bound));
});
