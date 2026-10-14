import { test } from "node:test";
import { deepStrictEqual, strictEqual, rejects, throws } from "node:assert/strict";
import { parseMultipleSelection, validateMultipleDraft, validateMultipleSelection } from "../../src/editor/multipleSelection";
import { loadSelectionPage, selectionValue, type SelectionIO } from "../../src/editor/singleSelection";
import { checkConflicts, planChanges, readOnlyReason, saveEditor, serializeDraft, type EditorState } from "../../src/editor/itemEditorModel";
import type { AuthoringItemField, AuthoringTreeItem } from "../../src/sitecore/authoringClient";
const id = (n: number) => n.toString(16).padStart(32, "0");
const node = (n: number, path: string): AuthoringTreeItem => ({ itemId:id(n), name:`Item${n}`, displayName:`Item ${n}`, path, hasChildren:true });
const root = node(1,"/sitecore/content/Root"), child = node(2,root.path+"/Child"), leaf = node(3,child.path+"/Leaf"), outside = node(4,"/sitecore/content/Other");
const old = id(99);
const field = (type = "Multilist", value = old): AuthoringItemField => ({fieldId:id(10),name:"Items",label:"Items",value,type,typeKey:type,scope:"VERSIONED",sortOrder:0,sectionSortOrder:0,sectionName:"Content",isStandardTemplate:false,containsFallbackValue:false,containsInheritedValue:false,containsStandardValue:false,textual:false,selectionSource:root.path});
const io: SelectionIO = {item: async locator => { const found = [root,child,leaf,outside].find(item => "itemId" in locator ? item.itemId === locator.itemId.replace(/[{}-]/g,"").toLowerCase() : item.path === locator.path); if (!found) throw Error("Unavailable"); return found; }, children: async locator => { const item = await io.item(locator); return {item,children:item === root ? [child] : item === child ? [leaf] : []}; }};
const state = (f = field()): EditorState => ({formatVersion:1,target:{connectionId:"test",serverUrl:"https://example.test",itemId:id(20),language:"en",version:1},drafts:{},base:{itemId:id(20),name:"Component",displayName:"Component",path:"/sitecore/content/Component",language:"en",version:1,hasChildren:false,template:{templateId:id(21),name:"Component"},availableVersions:[],fields:[f]}});

test("multi values preserve exact tokens/order and reject ambiguous legacy values", () => {
 const braced = selectionValue("multilist",child); const raw = `${old}|${braced}`;
 deepStrictEqual(parseMultipleSelection(raw),[old,braced]); strictEqual(serializeDraft(field("Multilist",raw),{input:raw,clear:false}),raw);
 for (const value of [`${old}|`, `|${old}`, `${old}||${braced}`, `${old}|${old}`, "bad", `{${old}`, ` ${old}`, Array(257).fill(old).join("|")]) throws(()=>parseMultipleSelection(value));
 deepStrictEqual(parseMultipleSelection(""),[]);
});
test("retained unavailable references survive add/remove/reorder without revalidation", async () => {
 const added = selectionValue("multilist",child);
 await validateMultipleSelection(field(),`${old}|${added}`,io);
 await validateMultipleSelection(field("Multilist",`${old}|${added}`),`${added}|${old}`,io);
 await validateMultipleSelection(field(),"",io);
 await rejects(validateMultipleSelection(field(),`${old}|${id(4)}`,io),/outside/);
 throws(()=>validateMultipleDraft(field("Multilist",added),child.itemId));
});
test("checklist allows explicit removal and addition but not reorder", async () => {
 const f = field("Checklist",`${old}|${child.itemId}`);
 throws(()=>validateMultipleDraft(f,`${child.itemId}|${old}`),/cannot be reordered/);
 await validateMultipleSelection(f,old,io);
 await validateMultipleSelection(field("Checklist"),`${old}|${child.itemId}`,io);
});
test("tree choices and new references stay under Source while flat lists require children", async () => {
 for (const type of ["Treelist","TreelistEx"]) {
  const f=field(type); deepStrictEqual((await loadSelectionPage(f,io,child.itemId)).choices,[leaf]);
  await validateMultipleSelection(f,`${old}|${leaf.itemId}`,io);
  await rejects(validateMultipleSelection(f,`${old}|${root.itemId}`,io),/outside/);
  await rejects(loadSelectionPage(f,io,outside.itemId),/outside/);
 }
 await rejects(validateMultipleSelection(field(),`${old}|${leaf.itemId}`,io),/outside/);
});
test("unsupported constraints and malformed stored values are read-only without broadening", () => {
 for (const selectionSource of ["", "query:./*", "DataSource=/sitecore/content&IncludeTemplatesForSelection=Page", "./Data", "$site/Data"]) {
  const f={...field("Treelist"),selectionSource}; strictEqual(Boolean(readOnlyReason(state(f).base,f)),true);
 }
 const f=field("Multilist",`${old}|${old}`); strictEqual(Boolean(readOnlyReason(state(f).base,f)),true);
});
test("partial page failures and cancellation cannot produce a cleared draft or write", async () => {
 const current={...state(),drafts:{[id(10)]:{input:`${old}|${child.itemId}`,clear:false}}}; let writes=0;
 await rejects(saveEditor(current,{read:async()=>current.base,validateSelections:async()=>validateMultipleSelection(field(),`${old}|${child.itemId}`,{...io,children:async()=>{throw Error("Incomplete page or aborted");}}),write:async()=>{writes++;},persist:async()=>{}},()=>{}),/Incomplete/);
 strictEqual(writes,0); strictEqual(current.drafts[id(10)].input,`${old}|${child.itemId}`);
});
test("Source drift and fallback-derived fields block writes; untouched fields stay unchanged", () => {
 const initial=state(); const dirty={...initial,drafts:{[id(10)]:{input:`${old}|${child.itemId}`,clear:false}}};
 throws(()=>checkConflicts(dirty,{...initial.base,fields:[{...field(),selectionSource:outside.path}]},planChanges(dirty)),/Conflict/);
 const fallback={...field(),containsFallbackValue:true}; strictEqual(Boolean(readOnlyReason(state(fallback).base,fallback)),true);
 deepStrictEqual(planChanges(initial),[]);
});
