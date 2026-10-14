import * as vscode from "vscode";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deepStrictEqual, strictEqual, rejects } from "node:assert/strict";
import { mock } from "node:test";
import { ItemEditorProvider, type ItemDocument } from "../../src/editor/itemEditorProvider";
import { editorKey, normalizeId, parseEditorState, planChanges, type EditorState } from "../../src/editor/itemEditorModel";
import type { ConnectionStore } from "../../src/connections/connectionStore";
import type { AuthoringContentClient, AuthoringItemDetails, UpdateAuthoringItemInput } from "../../src/sitecore/authoringClient";
import type { IntegrationTest } from "./testSupport";
const fieldId = "22222222222222222222222222222222";
function fixture(): EditorState {
  const itemId = "11111111111111111111111111111111";
  return { formatVersion: 1, target: { connectionId: "test", serverUrl: "https://example.test", itemId, language: "en-AU", version: 2 }, drafts: {},
    base: { itemId, name: "Component", displayName: "Component", path: "/sitecore/content/Fixture", language: "en-AU", version: 2, hasChildren: false,
      template: { templateId: "33333333333333333333333333333333", name: "Component" }, availableVersions: [{ language: "en-AU", version: 2 }],
      fields: [{ fieldId, name: "Title", label: "Title", type: "Single-Line Text", typeKey: "text", value: "old", scope: "VERSIONED", sortOrder: 0, sectionSortOrder: 0,
        sectionName: "Content", isStandardTemplate: false, containsFallbackValue: false, containsInheritedValue: false, containsStandardValue: false, textual: true }] } };
}

export const itemEditorTests: readonly IntegrationTest[] = [{
  name: "reorder host validates exact drafts and supports isolated undo redo backup and saved-base restoration",
  async execute(): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), "xm-reorder-host-"));
    const initial = fixture(); const first = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", second = "{BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB}";
    const extraId = "99999999999999999999999999999999";
    const state = { ...initial, base: { ...initial.base, fields: [{ ...initial.base.fields[0], type:"Multilist", value:`${first}|${second}`, selectionSource:"/sitecore/content/Choices" }, { ...initial.base.fields[0], fieldId:extraId, name:"Other" }] } };
    const provider = new ItemEditorProvider({ globalStorageUri:vscode.Uri.file(directory) } as vscode.ExtensionContext, { get:()=>undefined } as unknown as ConnectionStore, {} as AuthoringContentClient);
    const edits: vscode.CustomDocumentEditEvent<ItemDocument>[] = [];
    const subscription = provider.onDidChangeCustomDocument(edit => edits.push(edit));
    const harness = provider as unknown as { message(doc:ItemDocument, message:unknown):Promise<void> };
    let doc: ItemDocument | undefined;
    try {
      await vscode.workspace.fs.createDirectory(provider.directory);
      const uri = vscode.Uri.joinPath(provider.directory, `${editorKey(state.target)}.xmitem`);
      await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(state)));
      doc = await provider.openCustomDocument(uri,{backupId:undefined,untitledDocumentData:undefined});
      const current = () => doc!.state.drafts[fieldId];
      const reorder = (before:string,input:string,revision=doc!.revision) => harness.message(doc!,{type:"reorder",id:fieldId,before,input,clear:false,revision});
      await reorder(state.base.fields[0].value, `${second}|${first}`);
      strictEqual(edits.length,1); strictEqual(edits[0].label,"Reorder Title");
      await harness.message(doc,{type:"change",id:extraId,input:"keep",clear:false,revision:doc.revision});
      await edits[0].undo(); strictEqual(current(),undefined); strictEqual(doc.state.drafts[extraId].input,"keep");
      await edits[0].redo(); strictEqual(current().input,`${second}|${first}`);
      const count=edits.length;
      await reorder(`${first}|${second}`,`${second}|${first}`); // stale current value
      await reorder(`${second}|${first}`,`${first}|${second}`,-1); // stale document revision
      await reorder(`${second}|${first}`,`${second}|${first}`); // no-op
      strictEqual(edits.length,count);
      await rejects(reorder(`${second}|${first}`,first),/preserve/);
      const backup=await provider.backupCustomDocument(doc,{destination:vscode.Uri.file(join(directory,"backup"))});
      strictEqual(parseEditorState(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.parse(backup.id))).toString()).drafts[fieldId].input,`${second}|${first}`);
      // Save updates the base and clears drafts; Undo must recover the old order, not the old base.
      doc.state={...doc.state,base:{...doc.state.base,fields:[{...doc.state.base.fields[0],value:`${second}|${first}`},doc.state.base.fields[1]]},drafts:{[extraId]:{input:"keep",clear:false}}};
      await edits[0].undo(); strictEqual(doc.state.drafts[fieldId].input,`${first}|${second}`); strictEqual(doc.state.base.fields[0].value,`${second}|${first}`);
      await edits[0].redo(); strictEqual(doc.state.drafts[fieldId],undefined);
      doc.state={...doc.state,base:{...doc.state.base,fields:[{...doc.state.base.fields[0],type:"Checklist"},doc.state.base.fields[1]]}};
      await reorder(`${second}|${first}`,`${first}|${second}`); strictEqual(edits.length,count);
      doc.busy=true; await rejects(Promise.resolve().then(()=>edits[0].undo()),/current editor state/);
      doc.busy=false; doc.historyEpoch++; await rejects(Promise.resolve().then(()=>edits[0].undo()),/current editor state/);
    } finally { subscription.dispose(); doc?.dispose(); provider.dispose(); await rm(directory,{recursive:true,force:true}); }
  },
}, {
  name: "compact selection webview opens from textbox, closes on selection and preserves grouped/tree values",
  async execute(): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), "xm-selection-webview-"));
    const extension = vscode.extensions.getExtension("OzrenTK.sitecore-xm-cloud-sync")!;
    const root = { itemId: "44444444444444444444444444444444", name: "Root", displayName: "Root", path: "/sitecore/content/Root", hasChildren: true };
    const group = { ...root, itemId: "55555555555555555555555555555555", name: "Group", displayName: "Group", path: root.path + "/Group" };
    const leaf = { ...root, itemId: "66666666666666666666666666666666", name: "Choice {Base}", displayName: "Choice label", path: group.path + "/Choice {Base}", hasChildren: false };
    const secondGroup = { ...group, itemId:"88888888888888888888888888888888", name:"Other", path:root.path + "/Other" };
    const secondLeaf = { ...leaf, itemId:"99999999999999999999999999999999", name:"Other choice", path:secondGroup.path + "/Other choice" };
    const provider = new ItemEditorProvider({ globalStorageUri: vscode.Uri.file(directory), extensionUri: extension.extensionUri } as vscode.ExtensionContext,
      { get: () => ({ id: "test", name: "Test", serverUrl: "https://example.test" }), getClientSecret: async () => "secret" } as unknown as ConnectionStore,
      { loadSelectionItem: async (_c: unknown, _s: string, locator: { itemId?: string }) => locator.itemId === group.itemId ? group : root,
        loadTreeLevel: async (_c: unknown, _s: string, locator: { itemId: string }) => locator.itemId === group.itemId ? { item: group, children: [leaf] } : locator.itemId === secondGroup.itemId ? {item:secondGroup,children:[secondLeaf]} : { item: root, children: [group,secondGroup] } } as unknown as AuthoringContentClient);
    const panel = vscode.window.createWebviewPanel("selectionSmoke", "Selection smoke", vscode.ViewColumn.Active, { enableScripts: true });
    let doc: ItemDocument | undefined; let listener: vscode.Disposable | undefined; let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const state = fixture();
      const fields = ["Droplist", "Droplink", "Grouped Droplist", "Grouped Droplink", "Droptree"].map((type, index) => ({ ...state.base.fields[0], fieldId: (index + 10).toString(16).padStart(32, "0"), name: `Select${index}`, label: type, type, value: index === 1 ? group.itemId : "unresolved-original", selectionSource: root.path }));
      await vscode.workspace.fs.createDirectory(provider.directory);
      const uri = vscode.Uri.joinPath(provider.directory, `${editorKey(state.target)}.xmitem`);
      await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify({ ...state, base: { ...state.base, fields } })));
      doc = await provider.openCustomDocument(uri, { backupId: undefined, untitledDocumentData: undefined });
      await provider.resolveCustomEditor(doc, panel);
      const script = `
        let started = false;
        window.addEventListener("message", async event => {
          if (event.data.type !== "state" || started) return;
          started = true;
          const until = async fn => { for (let i=0;i<200;i++) { if(fn()) return; await new Promise(r=>setTimeout(r,25)); } throw Error("Picker did not settle"); };
          try {
            const rows = [...document.querySelectorAll(".field")];
            if (rows.length !== 5) throw Error("Missing selection controls");
            await until(()=>rows[1].querySelector("[data-selection-label]").value === "Group");
            if (!rows[1].querySelector(".field-info-content").textContent.includes("/sitecore/content/Root/Group")) throw Error("Path must be in information box");
            if (rows[1].querySelector(".selection-trigger").value.includes("/sitecore/")) throw Error("Textbox must show only item name");
            if (document.querySelector(".picker-choice")) throw Error("Label resolution must not load choices");
            if (rows[4].querySelector("[data-selection-label]").value !== "Unavailable item") throw Error("Missing unresolved reference feedback");
            if ([...document.querySelectorAll("button")].some(b=>/Load choices|Browse choices/.test(b.textContent))) throw Error("Legacy loading button remains");
            if (getComputedStyle(rows[0].querySelector(".field-info-content")).display !== "none") throw Error("Metadata should be collapsed");
            rows[0].querySelector(".field-info-button").click();
            if (getComputedStyle(rows[0].querySelector(".field-info-content")).display === "none" || !rows[0].querySelector(".field-info-content").textContent.includes("Stored value:")) throw Error("Missing field information");
            rows[0].querySelector(".field-info-button").click();
            for (const [index, row] of rows.entries()) {
              const expected = index === 1 ? "55555555555555555555555555555555" : "unresolved-original";
              if (row.querySelector("[data-field-id]").value !== expected) throw Error("Current value lost on open");
              row.querySelector(".selection-trigger").click();
              if (row.querySelector(".selection-trigger").nextElementSibling.textContent !== "Clear") throw Error("Clear is not right of textbox");
              await until(()=>row.querySelector(".picker-choice"));
              if (row.querySelector("[data-field-id]").value !== expected) throw Error("Loading changed current value");
            }
            if (!rows[2].querySelector(".picker-group") || !rows[3].querySelector(".picker-group")) throw Error("Missing groups");
            const duplicatePaths = [...rows[3].querySelectorAll(".picker-choice-path")].map(n=>n.textContent);
            if (duplicatePaths.length !== 2 || !duplicatePaths[0].startsWith("Group") || !duplicatePaths[1].startsWith("Other")) throw Error("Duplicate labels lack relative parent disambiguation");
            if (!rows[3].querySelector(".picker-choice").title.includes("/sitecore/content/Root/Group/Choice")) throw Error("Missing full choice tooltip");
            if (rows[3].querySelector(".picker-source").textContent !== "Root" || !rows[3].querySelector(".picker-source").title.includes("/sitecore/content/Root")) throw Error("Source breadcrumb or tooltip incorrect");
            rows[0].querySelector(".selection-trigger").dispatchEvent(new KeyboardEvent("keydown", {key:"ArrowDown", bubbles:true}));
            await until(()=>rows[0].querySelector(".picker-choice"));
            const filter = rows[0].querySelector("input[type=search]"); filter.value="not found"; filter.dispatchEvent(new Event("input"));
            if (rows[0].querySelectorAll(".picker-choice").length !== 0) throw Error("Filter failed");
            if (rows[0].querySelector("[data-field-id]").value !== "unresolved-original") throw Error("Filtering changed value");
            filter.value=""; filter.dispatchEvent(new Event("input"));
            filter.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true}));
            if (document.activeElement !== rows[0].querySelector(".picker-choice")) throw Error("Arrow navigation failed");
            const flat = rows[0].querySelector(".picker-choice"); flat.click();
            if (rows[0].querySelector("[data-field-id]").value !== "Group") throw Error("Droplist did not store name");
            if (!rows[0].querySelector(".selection-popup").hidden || rows[0].querySelector(".selection-trigger").getAttribute("aria-expanded") !== "false") throw Error("Selection must close popup");
            rows[1].querySelector(".selection-trigger").click(); await until(()=>rows[1].querySelector(".picker-choice"));
            rows[1].querySelector("input[type=search]").dispatchEvent(new KeyboardEvent("keydown", {key:"Escape", bubbles:true}));
            if (!rows[1].querySelector(".selection-popup").hidden) throw Error("Escape must close popup");
            rows[1].querySelector(".selection-trigger").click(); await until(()=>rows[1].querySelector(".picker-choice"));
            const linked = rows[1].querySelector(".picker-choice"); linked.click();
            if (rows[1].querySelector("[data-field-id]").value !== "{55555555-5555-5555-5555-555555555555}") throw Error("Droplink did not store ID");
            if (!rows[1].querySelector(".selection-popup").hidden) throw Error("Droplink selection must close popup");
            rows[4].querySelector(".selection-trigger").click(); await until(()=>rows[4].querySelector(".picker-children"));
            rows[4].querySelector(".picker-children").click();
            await until(()=>rows[4].querySelector(".picker-choice-name")?.textContent === "Choice label");
            if (rows[4].querySelector(".picker-source").textContent !== "Group") throw Error("Picker header must show only current level name");
            rows[4].querySelector('[aria-label="Back to parent"]').click();
            if (!rows[4].querySelector(".picker-children") || rows[4].querySelector(".picker-choice-name").textContent !== "Group") throw Error("Tree Back lost parent level");
            rows[4].querySelector(".picker-choice").focus(); rows[4].querySelector(".picker-choice").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true}));
            await until(()=>rows[4].querySelector(".picker-choice-name")?.textContent === "Choice label"); rows[4].querySelector(".picker-choice").click();
            if (rows[4].querySelector("[data-field-id]").value !== "{66666666-6666-6666-6666-666666666666}") throw Error("Tree selection failed");
            if (!rows[4].querySelector(".selection-popup").hidden) throw Error("Tree selection must close popup");
            rows[0].querySelector(".selection-trigger").click();
            document.body.dispatchEvent(new PointerEvent("pointerdown", {bubbles:true}));
            if (!rows[0].querySelector(".selection-popup").hidden) throw Error("Outside click must close popup");
            if (document.activeElement !== rows[0].querySelector(".selection-trigger")) throw Error("Outside blank click must restore focus");
            api.postMessage({type:"selectionSmoke",ok:true});
          } catch(error) { api.postMessage({type:"selectionSmoke",error:String(error)}); }
        });`;
      const scriptPath = join(directory, "smoke.js"); await writeFile(scriptPath, script);
      const result = new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Selection webview smoke timed out")), 30_000);
        listener = panel.webview.onDidReceiveMessage(message => { if (message.type === "selectionSmoke") { try { strictEqual(message.ok, true, message.error); resolve(); } catch (error) { reject(error); } } });
      });
      const nonce = /nonce="([a-f0-9]+)"/u.exec(panel.webview.html)![1];
      panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extension.extensionUri, "media", "itemEditor"), vscode.Uri.file(directory)] };
      panel.webview.html = panel.webview.html.replace("</body>", `<script nonce="${nonce}" src="${panel.webview.asWebviewUri(vscode.Uri.file(scriptPath))}"></script></body>`);
      await result;
      await (provider as unknown as { flushInputs(document: ItemDocument): Promise<void> }).flushInputs(doc);
      strictEqual(Object.keys(doc.state.drafts).length, 3, "Unchanged grouped selections must not become drafts");
      strictEqual(doc.state.drafts[fields[0].fieldId].input, "Group");
    } finally { clearTimeout(timer); listener?.dispose(); panel.dispose(); doc?.dispose(); provider.dispose(); await rm(directory, { recursive: true, force: true }); }
  },
}, {
  name: "multiple selection webview preserves unknown references and supports checklist/tree add remove reorder",
  async execute(): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), "xm-selection-webview-"));
    const extension = vscode.extensions.getExtension("OzrenTK.sitecore-xm-cloud-sync")!;
    const root = { itemId: "44444444444444444444444444444444", name: "Root", displayName: "Root", path: "/sitecore/content/Root", hasChildren: true };
    const group = { ...root, itemId: "55555555555555555555555555555555", name: "Group", displayName: "Group", path: root.path + "/Group", templateId: "f8fa08624c8b4aa19433a9b409dfeb5e" };
    const leaf = { ...root, itemId: "66666666666666666666666666666666", name: "Choice {Base}", displayName: "Choice label", path: group.path + "/Choice {Base}", hasChildren: false };
    const provider = new ItemEditorProvider({ globalStorageUri: vscode.Uri.file(directory), extensionUri: extension.extensionUri } as vscode.ExtensionContext,
      { get: () => ({ id: "test", name: "Test", serverUrl: "https://example.test" }), getClientSecret: async () => "secret" } as unknown as ConnectionStore,
      { loadSelectionItem: async (_c: unknown, _s: string, locator: { itemId?: string }) => locator.itemId === group.itemId ? group : root,
        loadTreeLevel: async (_c: unknown, _s: string, locator: { itemId: string }) => locator.itemId === group.itemId ? { item: group, children: [leaf] } : { item: root, children: [group] } } as unknown as AuthoringContentClient);
    const panel = vscode.window.createWebviewPanel("selectionSmoke", "Selection smoke", vscode.ViewColumn.Active, { enableScripts: true });
    let doc: ItemDocument | undefined; let listener: vscode.Disposable | undefined; let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const initial = fixture();
      const state = { ...initial, target: { ...initial.target, itemId: root.itemId }, base: { ...initial.base, ...root } };
      const fields = ["Checklist", "Multilist", "Treelist", "TreelistEx"].map((type, index) => ({ ...state.base.fields[0], fieldId: (index + 10).toString(16).padStart(32, "0"), name: `Select${index}`, label: type, type, value: index === 3 ? "77777777777777777777777777777777|" + leaf.itemId : "77777777777777777777777777777777", selectionSource: index < 2 ? "query:./child::*[@@templateid= '{F8FA0862-4C8B-4AA1-9433-A9B409DFEB5E}']" : root.path }));
      await vscode.workspace.fs.createDirectory(provider.directory);
      const uri = vscode.Uri.joinPath(provider.directory, `${editorKey(state.target)}.xmitem`);
      await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify({ ...state, base: { ...state.base, fields } })));
      doc = await provider.openCustomDocument(uri, { backupId: undefined, untitledDocumentData: undefined });
      await provider.resolveCustomEditor(doc, panel);
      const script = `
        let started = false;
        window.addEventListener("message", async event => {
          if (event.data.type !== "state" || started) return;
          started = true;
          const until = async fn => { for (let i=0;i<200;i++) { if(fn()) return; await new Promise(r=>setTimeout(r,25)); } throw Error("Picker did not settle"); };
          try {
            const rows = [...document.querySelectorAll(".field")];
            const unknown = "77777777777777777777777777777777";
            const raw = row => row.querySelector("[data-field-id]").value;
            if (rows.length !== 4) throw Error("Missing B2 controls");
            for (const [index,row] of rows.entries()) if (raw(row) !== unknown + (index === 3 ? "|66666666666666666666666666666666" : "")) throw Error("Lost stored reference");
            const open = row => row.querySelector(".selection-controls button").click();
            open(rows[0]); await until(()=>rows[0].querySelector(".picker-choice"));
            if (raw(rows[0]) !== unknown || rows[0].textContent.includes("Move up")) throw Error("Checklist mutated or has reorder controls");
            const checkbox = rows[0].querySelector(".picker-choice"); checkbox.focus(); checkbox.click();
            if (rows[0].querySelector(".selection-popup").hidden || document.activeElement !== checkbox) throw Error("Add closed picker or stole focus");
            if (checkbox.getAttribute("aria-disabled") !== "true" || !checkbox.textContent.includes("Added")) throw Error("Missing Added state");
            const afterAdd = raw(rows[0]); checkbox.click(); if (raw(rows[0]) !== afterAdd) throw Error("Added row changed draft");
            if (!rows[0].querySelector(".picker-source").title.includes("query:./child")) throw Error("Source expression missing from tooltip");
            rows[0].querySelector('[aria-label="Close choices"]').click();
            if (!rows[0].querySelector(".selection-popup").hidden || document.activeElement !== rows[0].querySelector(".selection-controls button")) throw Error("Close button focus failed");
            open(rows[0]); await until(()=>rows[0].querySelector(".picker-choice"));
            if (!raw(rows[0]).startsWith(unknown+"|")) throw Error("Checklist dropped unavailable reference");
            const filter = rows[0].querySelector("input[type=search]"); filter.value="missing"; filter.dispatchEvent(new Event("input"));
            if (!raw(rows[0]).startsWith(unknown+"|")) throw Error("Filtering changed selection");
            rows[0].querySelector(".multiple-selected li button").click();
            if (raw(rows[0]).includes(unknown) || !raw(rows[0]).includes("55555555-5555-5555-5555-555555555555")) throw Error("Explicit removal of unavailable reference failed");
            open(rows[1]); await until(()=>rows[1].querySelector(".picker-choice"));
            rows[1].querySelector(".picker-choice").click();
            if (!raw(rows[1]).startsWith(unknown+"|")) throw Error("Add lost unknown reference");
            const selected = rows[1].querySelector(".multiple-selected");
            selected.children[1].querySelector(".reorder-handle").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowUp",altKey:true,bubbles:true}));
            if (!raw(rows[1]).endsWith("|"+unknown)) throw Error("Reorder failed");
            if (document.activeElement !== selected.children[0].querySelector(".reorder-handle")) throw Error("Keyboard focus lost");
            const reordered = raw(rows[1]);
            selected.children[0].querySelector(".reorder-handle").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowUp",altKey:true,bubbles:true}));
            if (raw(rows[1]) !== reordered) throw Error("Boundary move changed order");
            if (!rows[1].querySelector("[aria-live]").textContent.includes("position 1")) throw Error("Missing move announcement");
            const startDrag = () => { const data = new DataTransfer(); selected.children[0].querySelector(".reorder-handle").dispatchEvent(new DragEvent("dragstart",{dataTransfer:data,bubbles:true,cancelable:true})); return data; };
            const drop = (list,data,y) => list.dispatchEvent(new DragEvent("drop",{dataTransfer:data,clientY:y,bubbles:true,cancelable:true}));
            let data = startDrag();
            const otherList = rows[2].querySelector(".multiple-selected"); const otherBefore = raw(rows[2]);
            drop(otherList,data,otherList.getBoundingClientRect().bottom);
            if (raw(rows[2]) !== otherBefore) throw Error("Cross-field drop accepted");
            document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));
            drop(selected,data,selected.getBoundingClientRect().bottom);
            if (raw(rows[1]) !== reordered) throw Error("Cancelled drag changed order");
            drop(selected,new DataTransfer(),selected.getBoundingClientRect().bottom);
            if (raw(rows[1]) !== reordered) throw Error("External drop accepted");
            data = startDrag(); drop(selected,data,selected.children[0].getBoundingClientRect().top);
            if (raw(rows[1]) !== reordered) throw Error("No-op drag changed order");
            data = startDrag(); drop(selected,data,selected.getBoundingClientRect().bottom);
            if (raw(rows[1]) === reordered) throw Error("Drag to last failed");
            const last = selected.children[1].querySelector(".reorder-handle"); data = new DataTransfer();
            last.dispatchEvent(new DragEvent("dragstart",{dataTransfer:data,bubbles:true,cancelable:true}));
            drop(selected,data,selected.children[0].getBoundingClientRect().top);
            if (raw(rows[1]) !== reordered) throw Error("Drag to first failed");
            rows[1].querySelector(".multiple-selected li .selection-remove").click();
            if (raw(rows[1]) !== unknown) throw Error("Remove dropped wrong reference");
            for (const row of rows.slice(2)) {
              open(row); await until(()=>row.querySelector(".picker-children"));
              row.querySelector(".picker-children").click();
              await until(()=>row.querySelector(".picker-choice-name")?.textContent === "Choice label"); const branch=row.querySelector(".picker-choice"); branch.click();
              if (!raw(row).startsWith(unknown+"|") || !raw(row).replace(/[{}-]/g, "").includes("66666666666666666666666666666666")) throw Error("Lazy tree add failed");
              row.querySelector(".selection-controls button:last-child").click();
              if (raw(row) !== "" || row.querySelector("[data-field-id]").dataset.explicitClear !== "true") throw Error("Explicit clear failed");
              if (row === rows[3]) {
                branch.click();
                if (raw(row) !== "66666666666666666666666666666666") throw Error("Re-add normalized an original token");
                row.querySelector(".selection-controls button:last-child").click();
              }
            }
            open(rows[0]); rows[0].dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));
            if (!rows[0].querySelector(".selection-popup").hidden) throw Error("Escape failed");
            api.postMessage({type:"selectionSmoke",ok:true});
          } catch(error) { api.postMessage({type:"selectionSmoke",error:String(error)}); }
        });`;
      const scriptPath = join(directory, "smoke.js"); await writeFile(scriptPath, script);
      const result = new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Selection webview smoke timed out")), 30_000);
        listener = panel.webview.onDidReceiveMessage(message => { if (message.type === "selectionSmoke") { try { strictEqual(message.ok, true, message.error); resolve(); } catch (error) { reject(error); } } });
      });
      const nonce = /nonce="([a-f0-9]+)"/u.exec(panel.webview.html)![1];
      panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extension.extensionUri, "media", "itemEditor"), vscode.Uri.file(directory)] };
      panel.webview.html = panel.webview.html.replace("</body>", `<script nonce="${nonce}" src="${panel.webview.asWebviewUri(vscode.Uri.file(scriptPath))}"></script></body>`);
      await result;
      await (provider as unknown as { flushInputs(document: ItemDocument): Promise<void> }).flushInputs(doc);
      strictEqual(doc.state.drafts[fields[1].fieldId], undefined, "Returning to the original list must not leave a draft");
      strictEqual(doc.state.drafts[fields[3].fieldId].clear, true);
    } finally { clearTimeout(timer); listener?.dispose(); panel.dispose(); doc?.dispose(); provider.dispose(); await rm(directory, { recursive: true, force: true }); }
  },
}, {
  name: "automatic reference labels preserve drafts and ignore results after selection changes or disposal",
  async execute(): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), "xm-label-host-"));
    const targetId = "44444444444444444444444444444444";
    const initial = fixture();
    const state = { ...initial, base: { ...initial.base, fields: [{ ...initial.base.fields[0], type: "Droplink", value: targetId, selectionSource: "/sitecore/content/Choices" }] } };
    let finish: ((item: unknown) => void) | undefined;
    const posted: Record<string, unknown>[] = []; const reads: unknown[][] = [];
    const provider = new ItemEditorProvider({ globalStorageUri: vscode.Uri.file(directory) } as vscode.ExtensionContext,
      { get: () => ({ id: "test", serverUrl: "https://example.test" }), getClientSecret: async () => "secret" } as unknown as ConnectionStore,
      { loadSelectionItem: async (...args: unknown[]) => { reads.push(args); return new Promise(resolve => { finish = resolve; }); } } as unknown as AuthoringContentClient);
    let doc: ItemDocument | undefined;
    try {
      await vscode.workspace.fs.createDirectory(provider.directory);
      const uri = vscode.Uri.joinPath(provider.directory, `${editorKey(state.target)}.xmitem`);
      await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(state)));
      doc = await provider.openCustomDocument(uri, { backupId: undefined, untitledDocumentData: undefined });
      doc.panels.add({ webview: { postMessage: async (message: Record<string, unknown>) => { posted.push(message); return true; } } } as unknown as vscode.WebviewPanel);
      const harness = provider as unknown as { resolveLabels(doc: ItemDocument, revision: number, controller: AbortController): Promise<void> };
      const resolved = { itemId: targetId, name: "Choice", displayName: "Choice label", path: "/sitecore/content/Choices/Choice", hasChildren: false };
      const waitRead = async () => { for (let i=0; !finish && i<100; i++) await new Promise(resolve => setTimeout(resolve, 5)); strictEqual(Boolean(finish), true); };
      let controller = new AbortController(); doc.labelRequest = controller;
      let request = harness.resolveLabels(doc, doc.revision, controller); await waitRead(); finish!(resolved); await request;
      strictEqual(posted[0].label, "Choice label · /sitecore/content/Choices/Choice");
      strictEqual(reads[0][3], "en-AU"); deepStrictEqual(doc.state.drafts, {});
      finish = undefined; posted.length = 0; controller = new AbortController(); doc.labelRequest = controller;
      request = harness.resolveLabels(doc, doc.revision, controller); await waitRead();
      doc.state = { ...doc.state, drafts: { [fieldId]: { input: "", clear: true } } }; finish!(resolved); await request;
      strictEqual(posted.length, 0, "Old label must not overwrite a changed selection");
      doc.state = state; finish = undefined; controller = new AbortController(); doc.labelRequest = controller;
      request = harness.resolveLabels(doc, doc.revision, controller); await waitRead(); doc.dispose(); finish!(resolved); await request;
      strictEqual(controller.signal.aborted, true); strictEqual(posted.length, 0);
    } finally { doc?.dispose(); provider.dispose(); await rm(directory, { recursive: true, force: true }); }
  },
}, {
  name: "selection requests reject superseded results and abort on document disposal",
  async execute(): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), "xm-selection-host-"));
    const root = { itemId: "44444444444444444444444444444444", name: "Root", displayName: "Root", path: "/sitecore/content/Root", hasChildren: true };
    let finish: ((value: typeof root) => void) | undefined; let calls = 0;
    const signals: AbortSignal[] = []; const posted: Record<string, unknown>[] = [];
    const provider = new ItemEditorProvider({ globalStorageUri: vscode.Uri.file(directory) } as vscode.ExtensionContext,
      { get: () => ({ id: "test", serverUrl: "https://example.test" }), getClientSecret: async () => "secret" } as unknown as ConnectionStore,
      { loadSelectionItem: async (_c: unknown, _s: string, _l: unknown, _lang: string, signal: AbortSignal) => { signals.push(signal); calls++; return calls === 1 ? new Promise<typeof root>(resolve => { finish = resolve; }) : root; },
        loadTreeLevel: async () => ({ item: root, children: [] }) } as unknown as AuthoringContentClient);
    let doc: ItemDocument | undefined;
    try {
      const initial = fixture(); const state = { ...initial, base: { ...initial.base, fields: [{ ...initial.base.fields[0], type: "Droplink", value: "", selectionSource: root.path }] } };
      await vscode.workspace.fs.createDirectory(provider.directory);
      const uri = vscode.Uri.joinPath(provider.directory, `${editorKey(state.target)}.xmitem`);
      await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(state)));
      doc = await provider.openCustomDocument(uri, { backupId: undefined, untitledDocumentData: undefined });
      doc.panels.add({ webview: { postMessage: async (value: Record<string, unknown>) => { posted.push(value); return true; } } } as unknown as vscode.WebviewPanel);
      const harness = provider as unknown as { message(doc: ItemDocument, value: unknown): Promise<void> };
      const old = harness.message(doc, { type: "choices", revision: 0, id: fieldId, request: "old" });
      for (let count = 0; !finish && count < 100; count++) await new Promise(resolve => setTimeout(resolve, 5));
      strictEqual(Boolean(finish), true);
      await harness.message(doc, { type: "choices", revision: 0, id: fieldId, request: "new" });
      finish!(root); await old;
      strictEqual(signals[0].aborted, true); deepStrictEqual(posted.map(p => p.request), ["new"]);
      const count = posted.length; doc.dispose();
      await harness.message(doc, { type: "choices", revision: 0, id: fieldId, request: "disposed" });
      strictEqual(posted.length, count);
    } finally { doc?.dispose(); provider.dispose(); await rm(directory, { recursive: true, force: true }); }
  },
}, {
  name: "child query requests use the pinned editor context, reject superseded results and abort on disposal",
  async execute(): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), "xm-selection-host-"));
    const root = { itemId: "44444444444444444444444444444444", name: "Root", displayName: "Root", path: "/sitecore/content/Root", hasChildren: true };
    let finish: ((value: typeof root) => void) | undefined; let calls = 0;
    const signals: AbortSignal[] = []; const posted: Record<string, unknown>[] = [];
    const provider = new ItemEditorProvider({ globalStorageUri: vscode.Uri.file(directory) } as vscode.ExtensionContext,
      { get: () => ({ id: "test", serverUrl: "https://example.test" }), getClientSecret: async () => "secret" } as unknown as ConnectionStore,
      { loadSelectionItem: async (_c: unknown, _s: string, locator: unknown, language: string, signal: AbortSignal) => { deepStrictEqual(locator, { itemId: root.itemId }); strictEqual(language, "en-AU"); signals.push(signal); calls++; return calls === 1 ? new Promise<typeof root>(resolve => { finish = resolve; }) : root; },
        loadTreeLevel: async () => ({ item: root, children: [] }) } as unknown as AuthoringContentClient);
    let doc: ItemDocument | undefined;
    try {
      const initial = fixture(); const state = { ...initial, target: { ...initial.target, itemId: root.itemId }, base: { ...initial.base, ...root, fields: [{ ...initial.base.fields[0], type: "Multilist", value: "", selectionSource: "query:./child::*[@@templateid= '{F8FA0862-4C8B-4AA1-9433-A9B409DFEB5E}']" }] } };
      await vscode.workspace.fs.createDirectory(provider.directory);
      const uri = vscode.Uri.joinPath(provider.directory, `${editorKey(state.target)}.xmitem`);
      await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(state)));
      doc = await provider.openCustomDocument(uri, { backupId: undefined, untitledDocumentData: undefined });
      doc.panels.add({ webview: { postMessage: async (value: Record<string, unknown>) => { posted.push(value); return true; } } } as unknown as vscode.WebviewPanel);
      const harness = provider as unknown as { message(doc: ItemDocument, value: unknown): Promise<void> };
      const old = harness.message(doc, { type: "choices", revision: 0, id: fieldId, request: "old" });
      for (let count = 0; !finish && count < 100; count++) await new Promise(resolve => setTimeout(resolve, 5));
      strictEqual(Boolean(finish), true);
      await harness.message(doc, { type: "choices", revision: 0, id: fieldId, request: "new" });
      finish!(root); await old;
      strictEqual(signals[0].aborted, true); deepStrictEqual(posted.map(p => p.request), ["new"]);
      const count = posted.length; doc.dispose();
      await harness.message(doc, { type: "choices", revision: 0, id: fieldId, request: "disposed" });
      strictEqual(posted.length, count);
    } finally { doc?.dispose(); provider.dispose(); await rm(directory, { recursive: true, force: true }); }
  },
}, {
  name: "native custom-editor tabs reuse the pinned document and track dirty/save state",
  async execute(): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), "xm-editor-native-"));
    const extension = vscode.extensions.getExtension("OzrenTK.sitecore-xm-cloud-sync")!;
    let remote = fixture().base;
    let writes = 0;
    const provider = new ItemEditorProvider({ globalStorageUri: vscode.Uri.file(directory), extensionUri: extension.extensionUri } as vscode.ExtensionContext,
      { get: () => ({ name: "Test", id: "test", serverUrl: "https://example.test" }), getClientSecret: async () => "fixture-secret" } as unknown as ConnectionStore,
      { loadItem: async () => remote, updateEditorFields: async (_connection: unknown, _secret: unknown, input: UpdateAuthoringItemInput, signal: AbortSignal) => {
        strictEqual(signal.aborted, false); writes++; remote = { ...remote, fields: remote.fields.map(f => ({ ...f, value: input.fields[f.name] ?? f.value })) };
      } } as unknown as AuthoringContentClient);
    const warning = mock.method(vscode.window, "showWarningMessage", async () => "Save to Sitecore");
    const type = "xmCloudSync.testItemEditor";
    const registration = vscode.window.registerCustomEditorProvider(type, provider, { supportsMultipleEditorsPerDocument: false });
    const harness = provider as unknown as { documents: Map<string, ItemDocument>; message(doc: ItemDocument, message: unknown): Promise<void> };
    const state = fixture(); const uri = vscode.Uri.joinPath(provider.directory, `${editorKey(state.target)}.xmitem`);
    const matchingTabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputCustom && tab.input.uri.toString().toLowerCase() === uri.toString().toLowerCase());
    const wait = async (predicate: () => boolean): Promise<void> => { for (let count = 0; count < 200; count++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); } throw new Error(`Native editor state did not settle: documents=${harness.documents.size}, tabs=${matchingTabs().length}, all=${vscode.window.tabGroups.all.flatMap(g => g.tabs).map(t => t.label).join(",")}`); };
    try {
      await vscode.workspace.fs.createDirectory(provider.directory);
      await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(state)));
      await vscode.commands.executeCommand("vscode.openWith", uri, type, { preview: false });
      await wait(() => harness.documents.size === 1 && matchingTabs().length === 1);
      const doc = [...harness.documents.values()][0]!;
      await harness.message(doc, { type: "change", revision: doc.revision, id: fieldId, input: "retained draft", clear: false });
      await wait(() => matchingTabs()[0].isDirty);
      await vscode.commands.executeCommand("vscode.openWith", uri, type, { preview: false });
      strictEqual(matchingTabs().length, 1); strictEqual([...harness.documents.values()][0], doc);
      strictEqual(doc.state.drafts[fieldId].input, "retained draft");
      await vscode.commands.executeCommand("undo");
      await wait(() => !doc.state.drafts[fieldId]);
      await vscode.commands.executeCommand("redo");
      await wait(() => doc.state.drafts[fieldId]?.input === "retained draft");
      // Save while hidden, then edit/save again after native journal persistence.
      const other = await vscode.workspace.openTextDocument({ content: "" });
      await vscode.window.showTextDocument(other);
      await vscode.workspace.save(uri);
      await wait(() => !matchingTabs()[0].isDirty);
      strictEqual(writes, 1);
      strictEqual(remote.fields[0].value, "retained draft");
      await harness.message(doc, { type: "change", revision: doc.revision, id: fieldId, input: "second draft", clear: false });
      await wait(() => matchingTabs()[0].isDirty);
      await vscode.workspace.save(uri);
      await wait(() => !matchingTabs()[0].isDirty);
      strictEqual(writes, 2);
      strictEqual(doc.lifetime.signal.aborted, false);
      strictEqual(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString(), JSON.stringify(state));
      strictEqual(await vscode.window.tabGroups.close(matchingTabs()), true);
    } finally { warning.mock.restore(); registration.dispose(); provider.dispose(); await rm(directory, { recursive: true, force: true }); }
  },
}, {
  name: "item editor protects pinned targets, drafts, backup/revert, cancellation and save readback",
  async execute(): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), "xm-editor-host-"));
    const extension = vscode.extensions.getExtension("OzrenTK.sitecore-xm-cloud-sync")!;
    let remote = fixture().base; const writes: UpdateAuthoringItemInput[] = []; const reads: unknown[][] = [];
    let serverUrl = "https://example.test";
    let failWrite = false;
    const store = { get: () => ({ id: "test", name: "Test", serverUrl }), getClientSecret: async () => "test-secret" } as unknown as ConnectionStore;
    const client = { loadItem: async (...args: unknown[]): Promise<AuthoringItemDetails> => { reads.push(args); return remote; },
      updateEditorFields: async (_connection: unknown, _secret: unknown, input: UpdateAuthoringItemInput) => {
        writes.push(input);
        if (failWrite) throw new Error("update Authoring item failed (403).");
        remote = { ...remote, fields: remote.fields.map(f => ({ ...f, value: input.fields[f.name] ?? f.value })) };
      } } as unknown as AuthoringContentClient;
    const provider = new ItemEditorProvider({ globalStorageUri: vscode.Uri.file(directory), extensionUri: extension.extensionUri } as vscode.ExtensionContext, store, client);
    const token = new vscode.CancellationTokenSource();
    const harness = provider as unknown as { message(doc: ItemDocument, message: unknown): Promise<void> };
    let doc: ItemDocument | undefined; let restored: ItemDocument | undefined;
    let confirm = false;
    const warning = mock.method(vscode.window, "showWarningMessage", async () => confirm ? "Save to Sitecore" : undefined);
    try {
      await vscode.workspace.fs.createDirectory(provider.directory);
      const state = fixture(); const uri = vscode.Uri.joinPath(provider.directory, `${editorKey(state.target)}.xmitem`);
      await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(state)));
      doc = await provider.openCustomDocument(uri, { backupId: undefined, untitledDocumentData: undefined });
      let changes = 0; const subscription = provider.onDidChangeCustomDocument(() => changes++);
      await harness.message(doc, { type: "change", revision: 0, id: fieldId, input: "draft", clear: false });
      strictEqual(changes, 1);
      await harness.message(doc, { type: "change", revision: -1, id: fieldId, input: "stale", clear: false });
      strictEqual(doc.state.drafts[fieldId].input, "draft");
      const destination = vscode.Uri.file(join(directory, "backup"));
      const backup = await provider.backupCustomDocument(doc, { destination });
      restored = await provider.openCustomDocument(uri, { backupId: backup.id, untitledDocumentData: undefined });
      strictEqual(restored.state.drafts[fieldId].input, "draft");
      restored.dispose();
      await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify({ ...doc.state, attempt: { phase: "sent", changes: planChanges(doc.state) } })));
      restored = await provider.openCustomDocument(uri, { backupId: backup.id, untitledDocumentData: undefined });
      strictEqual(restored.state.attempt?.phase, "sent", "An older VS Code backup must not erase the durable write intent");
      await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(state)));
      await rejects(provider.saveCustomDocument(doc, token.token)); strictEqual(writes.length, 0);
      confirm = true;
      await provider.saveCustomDocument(doc, token.token);
      strictEqual(writes.length, 1); strictEqual(writes[0].version, 2); strictEqual(writes[0].language, "en-AU");
      deepStrictEqual(writes[0].fields, { Title: "draft" }); deepStrictEqual(doc.state.drafts, {});
      for (const read of reads) { strictEqual(read[4], 2); strictEqual(read[6], false); strictEqual(read[7], true); }
      await harness.message(doc, { type: "change", revision: doc.revision, id: fieldId, input: "later", clear: false });
      serverUrl = "https://other.test";
      await rejects(provider.saveCustomDocument(doc, token.token), /target changed/); strictEqual(writes.length, 1);
      serverUrl = "https://example.test";
      await provider.revertCustomDocument(doc, token.token); deepStrictEqual(doc.state.drafts, {});
      strictEqual(parseEditorState(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString()).base.fields[0].value, "old", "The open document file must remain stable");
      strictEqual(parseEditorState(Buffer.from(await vscode.workspace.fs.readFile(uri.with({ path: `${uri.path}.state` }))).toString()).base.fields[0].value, "draft");
      failWrite = true;
      await harness.message(doc, { type: "change", revision: doc.revision, id: fieldId, input: "denied", clear: false });
      await rejects(provider.saveCustomDocument(doc, token.token), /Sitecore write:.*HTTP 403/);
      strictEqual(doc.state.attempt?.phase, "sent");
      strictEqual(doc.state.drafts[fieldId].input, "denied");
      const failedWrites = writes.length;
      await rejects(provider.saveCustomDocument(doc, token.token));
      strictEqual(writes.length, failedWrites, "An unconfirmed write must not replay");
      restored?.dispose();
      restored = await provider.openCustomDocument(uri, { backupId: backup.id, untitledDocumentData: undefined });
      strictEqual(restored.state.attempt?.phase, "sent", "The sidecar intent takes priority over an older backup");
      strictEqual(restored.state.drafts[fieldId].input, "denied");
      await backup.delete(); subscription.dispose();
      await rejects(provider.openCustomDocument(vscode.Uri.file(join(directory, "foreign.xmitem")), { backupId: undefined, untitledDocumentData: undefined }));
    } finally { warning.mock.restore(); doc?.dispose(); restored?.dispose(); token.dispose(); provider.dispose(); await rm(directory, { recursive: true, force: true }); }
  },
}, {
  name: "real item-editor webview renders safe basic controls and sends explicit clear drafts",
  async execute(): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), "xm-editor-webview-"));
    const extension = vscode.extensions.getExtension("OzrenTK.sitecore-xm-cloud-sync")!;
    const provider = new ItemEditorProvider({ globalStorageUri: vscode.Uri.file(directory), extensionUri: extension.extensionUri } as vscode.ExtensionContext,
      { get: () => ({ name: "Test" }) } as unknown as ConnectionStore, {} as AuthoringContentClient);
    const panel = vscode.window.createWebviewPanel("editorSmoke", "Editor smoke", vscode.ViewColumn.Active, { enableScripts: true });
    let doc: ItemDocument | undefined; let listener: vscode.Disposable | undefined; let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const state = fixture();
      const fields = ["Single-Line Text", "Multi-Line Text", "Checkbox", "Integer", "Number", "Date", "Datetime", "Rich Text"].map((type, index) => ({ ...state.base.fields[0], fieldId: (index + 4).toString(16).padStart(32, "0"), name: `Field${index}`, label: type, type, sortOrder: index % 2 ? -100 : 100, sectionName: index === 7 ? "Statistics" : index % 2 ? "Options" : "Content", sectionId: (index + 20).toString(16).padStart(32, "0"), isStandardTemplate: index === 7, value: type === "Rich Text" ? "<img src=x onerror=alert(1)>" : "" }));
      const expanded = { ...state, base: { ...state.base, fields } };
      await vscode.workspace.fs.createDirectory(provider.directory);
      const uri = vscode.Uri.joinPath(provider.directory, `${editorKey(state.target)}.xmitem`);
      await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(expanded)));
      doc = await provider.openCustomDocument(uri, { backupId: undefined, untitledDocumentData: undefined });
      await provider.resolveCustomEditor(doc, panel);
      const script = `let checked = false; window.addEventListener("message", event => { if (event.data.type !== "state" || checked) return; checked = true; try {
        const sections = [...document.querySelectorAll(".field-section")];
        if (sections.length !== 3) throw Error("Interleaved fields must form three unique sections");
        if (sections.map(s => s.querySelector("summary").textContent).join(",") !== "Content,Options,Statistics") throw Error("Field order must not determine section order");
        const content = sections.find(s => s.querySelector("summary").textContent === "Content");
        const standard = sections.find(s => s.querySelector("summary").textContent === "Statistics");
        if (!content.open || standard.open || content.querySelectorAll(".field").length !== 4) throw Error("Incorrect grouping/default collapse");
        content.open = false; content.dispatchEvent(new Event("toggle"));
        standard.open = true; standard.dispatchEvent(new Event("toggle"));
        window.dispatchEvent(new MessageEvent("message", {data:event.data}));
        const refreshed = [...document.querySelectorAll(".field-section")];
        if (refreshed.find(s => s.querySelector("summary").textContent === "Content").open || !refreshed.find(s => s.querySelector("summary").textContent === "Statistics").open) throw Error("Section state lost on render");
        for (const section of refreshed) section.open = true;
        if (document.querySelectorAll("input").length !== 6 || document.querySelectorAll("textarea").length !== 1) throw Error("Missing controls");
        if (document.querySelector("img") || !document.body.textContent.includes("Read-only:")) throw Error("Unsafe or editable Rich Text");
        if (!document.body.textContent.includes("UTC (no local-time conversion)")) throw Error("Missing explicit timezone");
        for (const row of document.querySelectorAll(".field")) {
          const info = row.querySelector(".field-info-content");
          if (!info || getComputedStyle(info).display !== "none") throw Error("Missing collapsed field information");
          row.querySelector(".field-info-button").click();
          if (getComputedStyle(info).display === "none" || !info.textContent.includes("Stored value:")) throw Error("Missing information");
          row.querySelector(".field-info-button").dispatchEvent(new KeyboardEvent("keydown", {key:"Escape", bubbles:true}));
          if (getComputedStyle(info).display !== "none") throw Error("Escape must dismiss information");
        }
        const heading = document.querySelector(".field > label");
        const originalName = heading.textContent;
        window.dispatchEvent(new MessageEvent("message", {data:{type:"fieldTitles",revision:event.data.revision-1,titles:{[heading.htmlFor]:"Stale"}}}));
        if (heading.textContent !== originalName) throw Error("Stale title accepted");
        window.dispatchEvent(new MessageEvent("message", {data:{type:"fieldTitles",revision:event.data.revision,titles:{[heading.htmlFor]:"Block Eyebrow"}}}));
        if (heading.textContent !== "Block Eyebrow" || !heading.parentElement.querySelector(".field-info-content").textContent.includes(originalName)) throw Error("Title/internal name separation failed");
        const checkbox = document.querySelector('input[type="checkbox"]');
        if ([...checkbox.parentElement.querySelectorAll("button")].some(b => b.textContent === "Clear")) throw Error("Checkbox must not have a Clear button");
        checkbox.checked = true; checkbox.dispatchEvent(new Event("input"));
        checkbox.checked = false; checkbox.dispatchEvent(new Event("input"));
        const text = document.querySelector('input[type="text"]'); text.value = "  draft  "; text.dispatchEvent(new Event("input"));
        [...text.parentElement.querySelectorAll("button")].find(b => b.textContent === "Clear").click();
        api.postMessage({ type: "smokeResult", ok: true });
      } catch (error) { api.postMessage({ type: "smokeResult", error: String(error) }); } });`;
      const scriptPath = join(directory, "smoke.js"); await writeFile(scriptPath, script);
      let clear = false;
      const result = new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Editor webview smoke timed out")), 20_000);
        listener = panel.webview.onDidReceiveMessage(message => {
          if (message.type === "change" && message.clear) clear = true;
          if (message.type === "smokeResult") { try { strictEqual(message.ok, true, message.error); strictEqual(clear, true); resolve(); } catch (error) { reject(error); } }
        });
      });
      const nonce = /nonce="([a-f0-9]+)"/u.exec(panel.webview.html)![1];
      panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extension.extensionUri, "media", "itemEditor"), vscode.Uri.file(directory)] };
      panel.webview.html = panel.webview.html.replace("</body>", `<script nonce="${nonce}" src="${panel.webview.asWebviewUri(vscode.Uri.file(scriptPath))}"></script></body>`);
      await result;
      await (provider as unknown as { flushInputs(document: ItemDocument): Promise<void> }).flushInputs(doc);
      strictEqual(doc.state.drafts[normalizeId(fields[0].fieldId)].clear, true);
    } finally { clearTimeout(timer); listener?.dispose(); panel.dispose(); doc?.dispose(); provider.dispose(); await rm(directory, { recursive: true, force: true }); }
  },
}];
