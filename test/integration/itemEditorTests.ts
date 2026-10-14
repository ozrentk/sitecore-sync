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
      const fields = ["Single-Line Text", "Multi-Line Text", "Checkbox", "Integer", "Number", "Date", "Datetime", "Rich Text"].map((type, index) => ({ ...state.base.fields[0], fieldId: (index + 4).toString(16).padStart(32, "0"), name: `Field${index}`, label: type, type, value: type === "Rich Text" ? "<img src=x onerror=alert(1)>" : "" }));
      const expanded = { ...state, base: { ...state.base, fields } };
      await vscode.workspace.fs.createDirectory(provider.directory);
      const uri = vscode.Uri.joinPath(provider.directory, `${editorKey(state.target)}.xmitem`);
      await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(expanded)));
      doc = await provider.openCustomDocument(uri, { backupId: undefined, untitledDocumentData: undefined });
      await provider.resolveCustomEditor(doc, panel);
      const script = `window.addEventListener("message", event => { if (event.data.type !== "state") return; try {
        if (document.querySelectorAll("input").length !== 6 || document.querySelectorAll("textarea").length !== 1) throw Error("Missing controls");
        if (document.querySelector("img") || !document.body.textContent.includes("visual and HTML")) throw Error("Unsafe or editable Rich Text");
        if (!document.body.textContent.includes("UTC (no local-time conversion)")) throw Error("Missing explicit timezone");
        const text = document.querySelector('input[type="text"]'); text.value = "  draft  "; text.dispatchEvent(new Event("input"));
        text.parentElement.querySelector("button").click();
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
