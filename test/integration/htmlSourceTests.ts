import * as vscode from "vscode";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strictEqual, deepStrictEqual, rejects } from "node:assert/strict";
import { mock } from "node:test";
import { ItemEditorProvider, type ItemDocument } from "../../src/editor/itemEditorProvider";
import { editorKey, type EditorState } from "../../src/editor/itemEditorModel";
import type { ConnectionStore } from "../../src/connections/connectionStore";
import type { AuthoringContentClient, UpdateAuthoringItemInput } from "../../src/sitecore/authoringClient";
import type { IntegrationTest } from "./testSupport";
const id = "22222222222222222222222222222222";
function fixture(): EditorState {
  const itemId = "11111111111111111111111111111111";
  return { formatVersion: 1, target: { connectionId: "test", serverUrl: "https://example.test", itemId, language: "en", version: 1 }, drafts: {},
    base: { itemId, name: "Component", displayName: "Component", path: "/sitecore/content/Test", language: "en", version: 1, hasChildren: false,
      template: { templateId: "33333333333333333333333333333333", name: "Component" }, availableVersions: [{ language: "en", version: 1 }],
      fields: [{ fieldId: id, name: "Text", label: "Text", type: "Rich Text", typeKey: "rich text", value: "<P>A\r\nB\nC\r</P>", scope: "SHARED", sortOrder: 0,
        sectionSortOrder: 0, sectionName: "Data", isStandardTemplate: false, containsFallbackValue: false, containsInheritedValue: false, containsStandardValue: false, textual: true }] } };
}
export const htmlSourceTests: readonly IntegrationTest[] = [{
  name: "HTML source freeze is panel/revision pinned, records pending history and restores exact backups and undo after Save",
  async execute() {
    const directory = await mkdtemp(join(tmpdir(), "xm-html-save-"));
    const initial = fixture(); let remote = initial.base; let writes = 0; let failComposition = false;
    let snapshot = "<P>A\r\nBX\nC\r</P><!--pending-->";
    const provider = new ItemEditorProvider({ globalStorageUri: vscode.Uri.file(directory) } as vscode.ExtensionContext,
      { get: () => ({ id: "test", name: "Test", serverUrl: "https://example.test" }), getClientSecret: async () => "fixture-secret" } as unknown as ConnectionStore,
      { loadItem: async () => remote, updateEditorFields: async (_c: unknown, _s: unknown, input: UpdateAuthoringItemInput) => {
        writes++; strictEqual(input.version, 1); strictEqual(input.language, "en");
        remote = { ...remote, fields: remote.fields.map(f => ({ ...f, value: input.fields[f.name] ?? f.value })) };
      } } as unknown as AuthoringContentClient);
    const harness = provider as unknown as { message(doc: ItemDocument, raw: unknown, source?: vscode.WebviewPanel): Promise<void> };
    let doc: ItemDocument | undefined; let restored: ItemDocument | undefined;
    const edits: vscode.CustomDocumentEditEvent<ItemDocument>[] = [];
    const subscription = provider.onDidChangeCustomDocument(e => edits.push(e));
    const token = new vscode.CancellationTokenSource();
    const warning = mock.method(vscode.window, "showWarningMessage", async (_message: string, options: { detail: string }) => {
      strictEqual(options.detail.includes("Shared changes affect all languages"), true); return "Save to Sitecore";
    });
    try {
      await vscode.workspace.fs.createDirectory(provider.directory);
      const uri = vscode.Uri.joinPath(provider.directory, editorKey(initial.target) + ".xmitem");
      await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(initial)));
      doc = await provider.openCustomDocument(uri, { backupId: undefined, untitledDocumentData: undefined });
      const panel = { active: true, visible: true, webview: { postMessage: async (m: Record<string, unknown>) => {
        if (m.type === "freeze") {
          await harness.message(doc!, { type: "frozen", id: m.id, revision: Number(m.revision) - 1, drafts: {} }, panel);
          await harness.message(doc!, { type: "frozen", id: m.id, revision: m.revision, drafts: {} }, {} as vscode.WebviewPanel);
          await harness.message(doc!, { type: "frozen", id: m.id, revision: m.revision, error: failComposition,
            drafts: { [id]: { input: snapshot, clear: false } } }, panel);
        }
        return true;
      } } } as unknown as vscode.WebviewPanel;
      doc.panels.add(panel);
      failComposition = true;
      await rejects(provider.saveCustomDocument(doc, token.token), /Finish composing/); strictEqual(writes, 0);
      failComposition = false;
      await provider.saveCustomDocument(doc, token.token);
      strictEqual(writes, 1); strictEqual(remote.fields[0].value, snapshot);
      strictEqual(edits.length, 1, "Final freeze snapshot must participate in native history");
      await edits[0].undo(); strictEqual(doc.state.drafts[id].input, initial.base.fields[0].value);
      strictEqual(remote.fields[0].value, snapshot, "Undo after Save only changes the local draft");
      await edits[0].redo(); deepStrictEqual(doc.state.drafts, {});
      snapshot += "\r\n<!--next-->";
      await harness.message(doc, { type: "change", revision: doc.revision, id, input: snapshot, clear: false });
      const backup = await provider.backupCustomDocument(doc, { destination: vscode.Uri.file(join(directory, "backup")) });
      restored = await provider.openCustomDocument(uri, { backupId: backup.id, untitledDocumentData: undefined });
      strictEqual(restored.state.drafts[id].input, snapshot);
      await backup.delete();
    } finally { warning.mock.restore(); subscription.dispose(); token.dispose(); doc?.dispose(); restored?.dispose(); provider.dispose(); await rm(directory, { recursive: true, force: true }); }
  },
}, {
  name: "HTML source real webview keeps raw newlines, isolated preview, pending composition and frozen snapshots",
  async execute() {
    const directory = await mkdtemp(join(tmpdir(), "xm-html-webview-"));
    const extension = vscode.extensions.getExtension("OzrenTK.sitecore-xm-cloud-sync")!;
    const media = vscode.Uri.joinPath(extension.extensionUri, "media", "itemEditor");
    const shared = vscode.Uri.joinPath(extension.extensionUri, "media", "shared");
    const panel = vscode.window.createWebviewPanel("htmlSourceSmoke", "HTML source smoke", vscode.ViewColumn.Active, { enableScripts: true });
    let listener: vscode.Disposable | undefined; let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      panel.webview.options = { enableScripts: true, localResourceRoots: [media, shared, vscode.Uri.file(directory)] };
      const script = String.raw`
        const assert = (value, label) => { if (!value) throw Error(label); };
        const wait = () => new Promise(resolve=>setTimeout(resolve,20));
        (async()=>{
          const raw="<P>A\r\nB\nC\r</P><!--keep--><script>window.pwned=1<\/script>";
          const field={id:"html",label:"Text",name:"Text",section:"Data",type:"Rich Text",scope:"SHARED",source:"Exact locale",kind:"html",original:raw,input:raw,clear:false,raw};
          const state={type:"state",revision:7,busy:false,pending:false,item:{name:"Fixture",path:"/sitecore/content/Fixture"},target:{language:"en",version:1,itemId:"fixture"},connection:"Test",fields:[field],status:"Ready"};
          window.dispatchEvent(new MessageEvent("message",{data:state}));
          let control=document.getElementById("html");
          assert(control.value===htmlSourceTools.normalize(raw),"Textarea projection");
          assert(htmlSources.get("html").read()===raw,"Untouched raw");
          const button=name=>[...document.querySelectorAll(".html-source-actions button")].find(b=>b.textContent===name);
          button("Preview").click(); await wait();
          const frame=document.querySelector("iframe");
          assert(frame && frame.getAttribute("sandbox")==="","Isolated preview");
          assert(!document.querySelector("#fields script") && !window.pwned,"Host remains inert");
          assert(htmlSources.get("html").read()===raw,"Preview must not serialize raw");
          button("HTML").click(); assert(!document.querySelector("iframe"),"Preview disposed");
          control.setSelectionRange(6,7);
          const clipboardData=new DataTransfer(); clipboardData.setData("text/plain","X\r\nY\nZ\r");
          control.dispatchEvent(new ClipboardEvent("paste",{clipboardData,bubbles:true,cancelable:true}));
          const expected=htmlSourceTools.replace(raw,6,7,"X\r\nY\nZ\r");
          assert(htmlSources.get("html").read()===expected,"Pasted newlines preserved");
          control.dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true}));
          window.dispatchEvent(new MessageEvent("message",{data:{type:"freeze",id:"test-freeze",revision:7}}));
          await wait(); assert(!control.disabled,"Wait for IME before freeze");
          control.value+="FINISH"; control.dispatchEvent(new InputEvent("input",{inputType:"insertCompositionText",bubbles:true}));
          control.dispatchEvent(new CompositionEvent("compositionend",{bubbles:true}));
          await wait(); assert(control.disabled,"Freeze after composition"); assert(htmlSources.get("html").read()===expected+"FINISH","Final composition retained");
          window.dispatchEvent(new MessageEvent("message",{data:{type:"unfreeze",revision:8,error:""}}));
          assert(!control.disabled,"Unfreeze restores control");
          window.dispatchEvent(new MessageEvent("message",{data:{...state,revision:9,fields:[{...field,input:expected+"FINISH"}],focus:{id:"html"}}}));
          control=document.getElementById("html"); assert(document.activeElement===control,"Focus restored");
          assert(htmlSources.get("html").read()===expected+"FINISH","Rerender raw");
          const tooLarge=new DataTransfer(); tooLarge.setData("text/plain","x".repeat(1048577));
          control.dispatchEvent(new ClipboardEvent("paste",{clipboardData:tooLarge,bubbles:true,cancelable:true}));
          assert(htmlSources.get("html").read()===expected+"FINISH","Oversize edit preserves prior draft");
          control.focus(); control.dispatchEvent(new CompositionEvent("compositionstart"));
          control.addEventListener("blur",()=>{
            control.dispatchEvent(new CompositionEvent("compositionend"));
            setTimeout(()=>{control.value+="LATE";control.dispatchEvent(new InputEvent("input"));},0);
          },{once:true});
          assert(await htmlSources.get("html").finishComposition()===expected+"FINISHLATE","Blur must await final input after synchronous compositionend");
          button("Clear").click(); assert(htmlSources.get("html").read()==="" && control.dataset.explicitClear==="true","Explicit empty");
          api.postMessage({type:"html-test",ok:true,expected:expected+"FINISH"});
        })().catch(error=>api.postMessage({type:"html-test",error:String(error)}));
      `;
      await writeFile(join(directory, "smoke.js"), script);
      let frozen: { revision: number; drafts: Record<string, { input: string }> } | undefined;
      const completed = new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(Error("HTML source webview timed out")), 20000);
        listener = panel.webview.onDidReceiveMessage(message => {
          if (message.type === "frozen") frozen = message;
          if (message.type === "html-test") {
            try { strictEqual(message.ok, true, message.error); strictEqual(frozen?.revision, 7); strictEqual(frozen?.drafts.html.input, message.expected); resolve(); } catch (error) { reject(error); }
          }
        });
      });
      const scriptTag = (uri: vscode.Uri) => `<script nonce="html-test" src="${panel.webview.asWebviewUri(uri)}"></script>`;
      panel.webview.html = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src data:; style-src ${panel.webview.cspSource} 'nonce-html-test'; script-src 'nonce-html-test';"><link rel="stylesheet" href="${panel.webview.asWebviewUri(vscode.Uri.joinPath(media,"editor.css"))}"><body><h1 id="title"></h1><p id="identity"></p><p id="path"></p><p id="status"></p><button id="save">Save</button><button id="revert">Revert</button><button id="reconcile">Reconcile</button><button id="locale">Locale</button><main id="fields"></main>${scriptTag(vscode.Uri.joinPath(shared,"readOnlyField.js"))}${scriptTag(vscode.Uri.joinPath(media,"htmlSource.js"))}${scriptTag(vscode.Uri.joinPath(media,"editor.js"))}${scriptTag(vscode.Uri.file(join(directory,"smoke.js")))}</body>`;
      await completed;
    } finally { clearTimeout(timer); listener?.dispose(); panel.dispose(); await rm(directory, { recursive: true, force: true }); }
  },
}];
