import { withActionIcons } from "../ui/webviewActions";
import { parseMultipleSelection, validateMultipleSelection, validateReorder } from "./multipleSelection";
import { newRichLinkTargets } from "./richTextLinks";
import { fieldPresentation, fieldAssetUrl, fieldPreviewFailure } from "../sitecore/fieldPresentation";
import { isMultipleSelection } from "./singleSelection";
import { orderEditorFields } from "./fieldOrder";
import { loadSelectionMetadata, selectionIO } from "./selectionClient";
import { loadSelectionPage, selectionKind, selectionValue, validateSelection } from "./singleSelection";
import { editorFailure } from "./editorFailure";
import { isGeneralLink, linkSelectionField, parseGeneralLink, validateLinkTarget } from "./generalLink";
import * as vscode from "vscode";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { ConnectionStore } from "../connections/connectionStore";
import { AuthoringContentClient } from "../sitecore/authoringClient";
import { assertItem, editorKey, fieldInput, fieldKind, isGuid, isLocale, normalizeId, parseEditorState,
  EditorValidationError, planChanges, readOnlyReason, reconcileEditor, saveEditor, serializeDraft, type FieldDraft, type EditorIO, type EditorState, type EditorTarget } from "./itemEditorModel";

function localKey(uri: vscode.Uri): string {
  const path = resolve(uri.fsPath);
  return process.platform === "win32" ? path.toLowerCase() : path;
}
function draftValidation(field: EditorState["base"]["fields"][number], draft: FieldDraft | undefined): string {
  if (!draft) return "";
  try { serializeDraft(field, draft); return ""; }
  catch (error) { return error instanceof EditorValidationError ? error.message : "Invalid structured field draft."; }
}
function hasCustomLinkMetadata(field: EditorState["base"]["fields"][number], draft: FieldDraft | undefined): boolean {
  if (!isGeneralLink(field)) return false;
  try {
    if (parseGeneralLink(field.value).custom) return true;
    const template = draft && (JSON.parse(draft.input) as { _xml?: unknown })._xml;
    return typeof template === "string" && parseGeneralLink(template).custom;
  } catch { return false; }
}
export const itemEditorViewType = "xmCloudSync.itemEditor";
export class ItemDocument implements vscode.CustomDocument {
  readonly assets = new Map<string, { revision: number; source: string; url: string }>();
  readonly assetRequests = new Map<string, AbortController>();
  labelRequest: AbortController | undefined;
  readonly selections = new Map<string, AbortController>();
  cancelSelections(): void { this.labelRequest?.abort(); for (const request of this.selections.values()) request.abort(); this.selections.clear(); for (const request of this.assetRequests.values()) request.abort(); this.assetRequests.clear(); this.assets.clear(); }
  readonly panels = new Set<vscode.WebviewPanel>();
  busy = false;
  error: string | undefined;
  stage = "Editor operation";
  revision = 0;
  historyEpoch = 0;
  restoredEditRegistered = false;
  flush: { id: string; revision: number; panel: vscode.WebviewPanel; finish: (value: unknown) => void; fail: () => void } | undefined;
  readonly lifetime = new AbortController();
  private readonly disposed = new vscode.EventEmitter<void>();
  readonly onDidDispose = this.disposed.event;
  constructor(readonly uri: vscode.Uri, public state: EditorState) {}
  dispose(): void { this.cancelSelections(); this.lifetime.abort(); this.disposed.fire(); this.disposed.dispose(); }
}

/** VS Code owns dirty/close/backup handling; the document owns its immutable remote target. */
export class ItemEditorProvider implements vscode.CustomEditorProvider<ItemDocument>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<ItemDocument>>();
  readonly onDidChangeCustomDocument = this.changed.event;
  private readonly saved = new vscode.EventEmitter<EditorTarget>();
  readonly onDidSave = this.saved.event;
  private readonly documents = new Map<string, ItemDocument>();
  private readonly opening = new Map<string, Promise<void>>();
  private readonly lifetime = new AbortController();
  readonly directory: vscode.Uri;
  constructor(private readonly context: vscode.ExtensionContext, private readonly connections: ConnectionStore,
    private readonly client: AuthoringContentClient) {
    this.directory = vscode.Uri.joinPath(context.globalStorageUri, "item-editors");
  }
  dispose(): void { this.lifetime.abort(); for (const doc of this.documents.values()) doc.dispose(); this.changed.dispose(); this.saved.dispose(); }

  async open(args: unknown): Promise<void> {
    if (!args || typeof args !== "object") throw new Error("Choose Edit… from an item context menu.");
    const value = args as Record<string, unknown>;
    if (typeof value.connectionId !== "string" || !isGuid(value.itemId) || !isLocale(value.language)
      || (value.version !== undefined && (!Number.isInteger(value.version) || Number(value.version) < 1))) throw new Error("Invalid editor target.");
    const connection = this.connections.get(value.connectionId);
    if (!connection) throw new Error("Connection no longer exists.");
    const secret = await this.connections.getClientSecret(connection.id);
    if (!secret) throw new Error("Configure the connection credentials first.");
    let base = await this.client.loadItem(connection, secret, { itemId: value.itemId }, value.language,
      value.version as number | undefined, AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(30_000)]), false, true);
    base = await loadSelectionMetadata(this.client, connection, secret, base, AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(30_000)]));
    const target: EditorTarget = { connectionId: connection.id, serverUrl: new URL(connection.serverUrl).origin,
      itemId: value.itemId, language: value.language, version: base.version };
    assertItem(target, base);
    const key = editorKey(target);
    const existing = this.opening.get(key);
    if (existing) return existing;
    const operation = (async () => {
      await vscode.workspace.fs.createDirectory(this.directory);
      const uri = vscode.Uri.joinPath(this.directory, `${key}.xmitem`);
      const document = this.documents.get(localKey(uri));
      if (document) {
        const panel = [...document.panels][0];
        if (panel) { panel.reveal(); return; }
      }
      let state: EditorState | undefined;
      try { state = await this.readState(uri); }
      catch (error) { if (!(error instanceof vscode.FileSystemError && error.code === "FileNotFound")) throw error; }
      if (!state || (!Object.keys(state.drafts).length && !state.attempt)) {
        state = { formatVersion: 1, target, base, drafts: {} };
      }
      await this.persist(uri, state);
      await vscode.commands.executeCommand("vscode.openWith", uri, itemEditorViewType, { preview: false });
    })();
    this.opening.set(key, operation);
    try { await operation; } finally { this.opening.delete(key); }
  }

  async openCustomDocument(uri: vscode.Uri, context: vscode.CustomDocumentOpenContext): Promise<ItemDocument> {
    if (uri.scheme !== this.directory.scheme || dirname(localKey(uri)) !== localKey(this.directory)
      || !/^[a-f0-9]{64}\.xmitem$/u.test(uri.path.split("/").at(-1) ?? "")) throw new Error("Only extension-managed item drafts can be opened.");
    let state = await this.readState(context.backupId ? vscode.Uri.parse(context.backupId) : uri);
    if (context.backupId) {
      // VS Code can checkpoint a draft just before the remote-save intent is persisted.
      // Never let that older backup erase a newer unresolved write journal.
      const durable = await this.readState(uri);
      if (durable.attempt) state = durable;
    }
    if (!uri.path.endsWith(`/${editorKey(state.target)}.xmitem`)) throw new Error("Editor target does not match its document.");
    const doc = new ItemDocument(uri, state);
    this.documents.set(localKey(uri), doc);
    doc.onDidDispose(() => { if (this.documents.get(localKey(uri)) === doc) this.documents.delete(localKey(uri)); });
    return doc;
  }

  async resolveCustomEditor(doc: ItemDocument, panel: vscode.WebviewPanel): Promise<void> {
    doc.panels.add(panel);
    panel.title = `${doc.state.base.displayName || doc.state.base.name} · ${doc.state.target.language} v${doc.state.target.version}`;
    const media = vscode.Uri.joinPath(this.context.extensionUri, "media", "itemEditor");
    const shared = vscode.Uri.joinPath(this.context.extensionUri, "media", "shared");
    panel.webview.options = { enableScripts: true, localResourceRoots: [media, shared, vscode.Uri.joinPath(this.context.extensionUri, "out", "webview")] };
    const nonce = randomBytes(16).toString("hex");
    panel.webview.html = withActionIcons(panel.webview, `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; frame-src data:; style-src ${panel.webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${panel.webview.asWebviewUri(vscode.Uri.joinPath(media, "editor.css"))}"><link rel="stylesheet" href="${panel.webview.asWebviewUri(vscode.Uri.joinPath(shared, "readOnlyField.css"))}"></head><body><header><h1 id="title"></h1><p id="identity"></p><p id="path"></p><button id="save">Save</button> <button id="revert">Revert</button> <button id="reconcile">Check save outcome</button> <button id="locale">Open existing locale/version…</button><p id="status" role="status"></p></header><main id="fields"></main><script nonce="${nonce}" src="${panel.webview.asWebviewUri(vscode.Uri.joinPath(shared, "readOnlyField.js"))}"></script><script nonce="${nonce}" src="${panel.webview.asWebviewUri(vscode.Uri.joinPath(media, "htmlSource.js"))}"></script><script nonce="${nonce}" src="${panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "out", "webview", "richTextVisual.js"))}"></script><script nonce="${nonce}" src="${panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "out", "webview", "richTextFrame.js"))}"></script><script nonce="${nonce}" src="${panel.webview.asWebviewUri(vscode.Uri.joinPath(media, "editor.js"))}"></script></body></html>`, this.context.extensionUri);
    const subscription = panel.webview.onDidReceiveMessage(message => {
      void this.message(doc, message, panel).catch(error => {
        if (error instanceof vscode.CancellationError) return;
        void vscode.window.showErrorMessage(doc.error ?? editorFailure(error, doc.stage, Boolean(doc.state.attempt)));
      });
    });
    panel.onDidDispose(() => { subscription.dispose(); doc.panels.delete(panel); });
    if (!doc.restoredEditRegistered) {
      doc.restoredEditRegistered = true;
      for (const [id, draft] of Object.entries(doc.state.drafts)) {
        const field = doc.state.base.fields.find(f => normalizeId(f.fieldId) === id)!;
        this.recordEdit(doc, id, { input: fieldInput(field), clear: false }, draft, `Restore ${field.name} draft`);
      }
    }
  }

  private async message(doc: ItemDocument, raw: unknown, source?: vscode.WebviewPanel): Promise<void> {
    if (doc.lifetime.signal.aborted || !raw || typeof raw !== "object") return;
    const message = raw as Record<string, unknown>;
    if (message.type === "frozen") {
      if (doc.flush && message.id === doc.flush.id && message.revision === doc.flush.revision && source === doc.flush.panel) {
        if (message.error) doc.flush.fail(); else doc.flush.finish(message.drafts);
      }
      return;
    }
    if (message.type === "ready") { await this.render(doc); return; }
    if (doc.busy || message.revision !== doc.revision) return;
    if (message.type === "previewAsset" || message.type === "openAsset") {
      await this.asset(doc, message); return;
    }
    if (message.type === "choices") {
      await this.choices(doc, message);
      return;
    }
    if (["change", "reorder"].includes(String(message.type)) && typeof message.id === "string" && typeof message.input === "string" && message.input.length <= 1024 * 1024 && typeof message.clear === "boolean") {
      const field = doc.state.base.fields.find(f => normalizeId(f.fieldId) === message.id);
      if (!field || readOnlyReason(doc.state.base, field) || doc.state.attempt) return;
      const before = doc.state.drafts[message.id] ?? { input: fieldInput(field), clear: false };
      if (message.type === "reorder") {
        if (!["multilist", "treelist", "treelistex"].includes(selectionKind(field) ?? "") || message.clear || before.clear || message.before !== before.input) return;
        validateReorder(before.input, message.input);
      }
      const after = { input: message.input, clear: message.clear };
      if (before.input === after.input && before.clear === after.clear) return;
      const focusValue = message.type === "reorder" && typeof message.focusValue === "string" && before.input.split("|").includes(message.focusValue) ? message.focusValue : undefined;
      this.recordEdit(doc, message.id, before, after, `${message.type === "reorder" ? "Reorder" : "Edit"} ${field.name}`, focusValue);
      if (["namevalues", "generallink"].includes(fieldKind(field) ?? "")) {
        let error = "";
        try { serializeDraft(field, after); } catch (failure) { error = failure instanceof SyntaxError ? "Invalid structured field draft." : (failure as Error).message; }
        await Promise.all([...doc.panels].map(panel => panel.webview.postMessage({ type: "draftValidation", revision: doc.revision, id: message.id, input: after.input, error })));
        if (isGeneralLink(field)) {
          try {
            const previous = JSON.parse(before.input) as { id?: unknown; linktype?: unknown };
            const next = JSON.parse(after.input) as { id?: unknown; linktype?: unknown };
            if (next.linktype === "internal" && isGuid(next.id) && (previous.linktype !== next.linktype || previous.id !== next.id)) {
              const controller = doc.labelRequest && !doc.labelRequest.signal.aborted ? doc.labelRequest : new AbortController();
              doc.labelRequest = controller;
              void this.resolveLabels(doc, doc.revision, controller).catch(() => { /* Destination remains unchanged when optional labels fail. */ });
            }
          } catch { /* Invalid intermediate drafts remain available for correction. */ }
        }
      }
    } else if (message.type === "undo" || message.type === "redo") {
      if (!doc.state.attempt && [...doc.panels].some(panel => panel.active)) await vscode.commands.executeCommand(message.type);
    } else if (message.type === "save") {
      await vscode.workspace.save(doc.uri);
    } else if (message.type === "revert") {
      if (await vscode.window.showWarningMessage("Discard this draft and reload the pinned item version?", { modal: true }, "Discard and reload") === "Discard and reload") {
        const cancellation = new vscode.CancellationTokenSource();
        try { await this.revertCustomDocument(doc, cancellation.token); } finally { cancellation.dispose(); }
        await vscode.workspace.save(doc.uri);
      }
    } else if (message.type === "reconcile") {
      await this.exclusive(doc, async () => {
        doc.state = await reconcileEditor(doc.state, this.io(doc, doc.lifetime.signal));
        await this.persist(doc.uri, doc.state);
        this.saved.fire(doc.state.target);
      });
      // A clean reconciliation must also clear VS Code's native dirty marker.
      if (!doc.state.attempt && !planChanges(doc.state).length) await vscode.workspace.save(doc.uri);
    } else if (message.type === "locale") {
      const choice = await vscode.window.showQuickPick(doc.state.base.availableVersions.map(v => ({ label: `${v.language} · v${v.version}`, ...v })), { title: "Open an existing exact-locale version", ignoreFocusOut: true });
      if (choice) await this.open({ ...doc.state.target, language: choice.language, version: choice.version });
    }
  }

  private recordEdit(doc: ItemDocument, id: string, before: FieldDraft, after: FieldDraft, label: string, focusValue?: string): void {
    const epoch = doc.historyEpoch;
    const original = doc.state.base.fields.find(f => normalizeId(f.fieldId) === id)!;
    const templateId = normalizeId(doc.state.base.template.templateId);
    const apply = (draft: FieldDraft) => {
      const field = doc.state.base.fields.find(f => normalizeId(f.fieldId) === id);
      if (doc.lifetime.signal.aborted || doc.busy || doc.state.attempt || epoch !== doc.historyEpoch || !field || readOnlyReason(doc.state.base, field)
        || field.type !== original.type || field.scope !== original.scope || field.selectionSource !== original.selectionSource
        || normalizeId(doc.state.base.template.templateId) !== templateId) throw new Error("This edit cannot be restored in the current editor state.");
      const drafts = { ...doc.state.drafts };
      if (!draft.clear && draft.input === fieldInput(field)) delete drafts[id]; else drafts[id] = draft;
      doc.state = { ...doc.state, drafts };
    };
    // Initial application is already authorized by message validation (or recovered storage).
    doc.state = { ...doc.state, drafts: { ...doc.state.drafts, [id]: after } };
    const restore = async (draft: FieldDraft) => {
      apply(draft); doc.cancelSelections(); doc.revision++;
      await this.render(doc, { id, value: focusValue ?? draft.input.split("|")[0] });
    };
    this.changed.fire({ document: doc, label, undo: () => restore(before), redo: () => restore(after) });
  }

  private async choices(doc: ItemDocument, message: Record<string, unknown>): Promise<void> {
    if (typeof message.id !== "string" || typeof message.request !== "string" || message.request.length > 100
      || (message.parent !== undefined && !isGuid(message.parent))) return;
    const original = doc.state.base.fields.find(f => normalizeId(f.fieldId) === message.id);
    if (!original || (!selectionKind(original) && !isGeneralLink(original) && fieldKind(original) !== "html") || readOnlyReason(doc.state.base, original)) return;
    const richText = fieldKind(original) === "html";
    const field = richText ? { ...original, type: "Droptree", selectionSource: "/sitecore/content", value: "" } : isGeneralLink(original) ? linkSelectionField(original) : original;
    const id = message.id;
    doc.selections.get(id)?.abort();
    const controller = new AbortController(); doc.selections.set(id, controller);
    const revision = doc.revision;
    const signal = AbortSignal.any([controller.signal, doc.lifetime.signal, AbortSignal.timeout(30_000)]);
    let response: Record<string, unknown>;
    try {
      const connection = this.connections.get(doc.state.target.connectionId);
      if (!connection || new URL(connection.serverUrl).origin !== doc.state.target.serverUrl) throw new Error("Connection target changed.");
      const secret = await this.connections.getClientSecret(connection.id);
      if (!secret) throw new Error("Missing credentials.");
      const io = selectionIO(this.client, connection, secret, doc.state.target.language, signal, doc.state.target.itemId);
      const page = await loadSelectionPage(field, io, message.parent as string | undefined);
      const choices = isGeneralLink(original) || richText ? [{ ...page.parent, hasChildren: false }, ...page.choices].filter(choice => /^\/sitecore\/content(?:\/|$)/iu.test(choice.path)) : page.choices;
      let currentLabel = field.value ? "Unresolved or outside allowed Source (original value preserved)" : "No selection";
      const current = page.choices.find(choice => selectionKind(field)!.includes("droplist") ? choice.name === field.value : normalizeId(choice.itemId) === normalizeId(field.value));
      let currentName = current ? current.displayName || current.name : undefined;
      let currentPath = current?.path;
      if (current) currentLabel = `${current.displayName || current.name} · ${current.path}${current.disabled ? " · ambiguous name" : ""}`;
      else if (isGuid(field.value)) {
        try { const item = await io.item({ itemId: field.value }); currentName = item.displayName || item.name; currentPath = item.path; currentLabel = `${currentName} · ${item.path} (not in this choice list; original preserved)`; } catch { /* Keep raw current reference visible. */ }
      }
      response = { page: { ...page, choices: choices.map(choice => ({ ...choice, value: selectionValue(selectionKind(field)!, choice) })) }, currentLabel, currentName, currentPath };
    } catch (error) {
      response = { error: error instanceof EditorValidationError ? error.message : "Could not load verified choices. Check source access or limits, then retry; the current value is preserved." };
    }
    const liveConnection = this.connections.get(doc.state.target.connectionId);
    if (!liveConnection || new URL(liveConnection.serverUrl).origin !== doc.state.target.serverUrl) controller.abort();
    if (doc.selections.get(id) !== controller || controller.signal.aborted || doc.lifetime.signal.aborted || doc.revision !== revision || doc.busy) return;
    doc.selections.delete(id);
    await Promise.all([...doc.panels].map(panel => panel.webview.postMessage({ type: "choices", id, request: message.request, revision, ...response })));
  }

  private async render(doc: ItemDocument, focus?: { id: string; value: string }): Promise<void> {
    let status = "";
    try { status = `${planChanges(doc.state).length} changed field(s)`; } catch (error) { status = error instanceof Error ? error.message : "Invalid draft"; }
    if (doc.state.attempt) status = "Save outcome needs reconciliation. Draft preserved; further writes are blocked.";
    if (!doc.state.target.version) status = "No exact-locale version exists. Open an existing locale/version to edit; no version will be created.";
    const payload = { type: "state", revision: doc.revision, busy: doc.busy, status, pending: Boolean(doc.state.attempt),
      connection: this.connections.get(doc.state.target.connectionId)?.name ?? "Unavailable connection", target: doc.state.target,
      item: { name: doc.state.base.displayName || doc.state.base.name, path: doc.state.base.path },
      error: doc.error, focus,
      fields: orderEditorFields(doc.state.base.fields).map(field => ({
        id: normalizeId(field.fieldId), label: field.name, name: field.name, section: field.sectionName || "Fields", type: field.type,
        sectionId: field.sectionId ? normalizeId(field.sectionId) : undefined, isStandardTemplate: field.isStandardTemplate,
        scope: field.scope, source: field.containsFallbackValue ? "Fallback (unverified source)" : field.containsInheritedValue ? "Inherited" : field.containsStandardValue ? "Standard Value" : "Exact locale",
        selectionKind: selectionKind(field),
        selectionSource: field.selectionSource,
        linkCustom: hasCustomLinkMetadata(field, doc.state.drafts[normalizeId(field.fieldId)]),
        validation: isGeneralLink(field) ? draftValidation(field, doc.state.drafts[normalizeId(field.fieldId)]) : undefined,
        kind: fieldKind(field), reason: readOnlyReason(doc.state.base, field), input: doc.state.drafts[normalizeId(field.fieldId)]?.input ?? fieldInput(field),
        original: fieldInput(field),
        clear: doc.state.drafts[normalizeId(field.fieldId)]?.clear ?? false, raw: field.value,
        presentation: fieldPresentation(field.type, field.value),
      })) };
    await Promise.all([...doc.panels].map(panel => panel.webview.postMessage(payload)));
    doc.labelRequest?.abort();
    if (!doc.busy && !doc.lifetime.signal.aborted) {
      const controller = new AbortController(); doc.labelRequest = controller;
      void this.resolveFieldTitles(doc, doc.revision, controller).catch(() => { /* Internal names remain usable when optional titles fail. */ });
      void this.resolveLabels(doc, doc.revision, controller).catch(() => { /* Labels never affect drafts or save state. */ });
    }
  }

  private async asset(doc: ItemDocument, message: Record<string, unknown>): Promise<void> {
    if (typeof message.id !== "string" || !Number.isSafeInteger(message.request)) return;
    const id = message.id; const revision = doc.revision;
    const field = doc.state.base.fields.find(f => normalizeId(f.fieldId) === id);
    if (!field || !["image", "file"].includes(field.type.toLowerCase())) return;
    const presentation = fieldPresentation(field.type, field.value);
    const source = presentation.source;
    const target = doc.state.target; const connection = this.connections.get(target.connectionId);
    const current = () => doc.revision === revision && !doc.lifetime.signal.aborted
      && this.connections.get(target.connectionId)?.serverUrl === connection?.serverUrl;
    if (!connection || new URL(connection.serverUrl).origin !== target.serverUrl) return;
    if (message.type === "openAsset") {
      const asset = doc.assets.get(id);
      if (asset && asset.revision === revision && asset.source === source && fieldAssetUrl(connection.serverUrl, asset.url) && current()) await vscode.env.openExternal(vscode.Uri.parse(asset.url));
      return;
    }
    const reply = async (result: Record<string, unknown>) => {
      if (current()) await Promise.all([...doc.panels].map(panel => panel.webview.postMessage({ type: "assetPreview", revision, id, request: message.request, ...result })));
    };
    if ((!source || !fieldAssetUrl(connection.serverUrl, source)) && !presentation.mediaId) { await reply({ error: "Preview unavailable: the stored URL is absent, private or outside the supported media locations. Metadata and original value remain available." }); return; }
    if (doc.assetRequests.has(id) || doc.assetRequests.size >= 3) { await reply({ error: "Preview busy. Wait for the current requests, then retry." }); return; }
    const controller = new AbortController(); doc.assetRequests.set(id, controller);
    const signal = AbortSignal.any([controller.signal, doc.lifetime.signal, AbortSignal.timeout(20_000)]);
    try {
      if (!source || !fieldAssetUrl(connection.serverUrl, source)) {
        const secret = await this.connections.getClientSecret(connection.id);
        signal.throwIfAborted(); if (!current()) return;
        if (!secret || !presentation.mediaId) throw Error("Media credentials unavailable");
        const reference = await this.client.loadSelectionItem(connection, secret, { itemId: presentation.mediaId }, target.language, signal);
        signal.throwIfAborted(); if (!current()) return;
        if (!reference || normalizeId(reference.itemId) !== normalizeId(presentation.mediaId) || !reference.path.toLowerCase().startsWith("/sitecore/media library/")) throw Error("Media reference unavailable");
        await reply({ reference: `${reference.displayName || reference.name} · ${reference.path}`, error: "Media reference resolved. Preview unavailable: no supported asset URL was returned; no URL has been guessed." }); return;
      }
      const secret = fieldAssetUrl(connection.serverUrl, source)?.authenticated ? await this.connections.getClientSecret(connection.id) : "";
      signal.throwIfAborted(); if (!current()) return;
      if (secret === undefined) throw Error("Missing credentials");
      const result = await this.client.loadFieldAsset(connection, secret, source, field.type.toLowerCase() === "image", signal);
      signal.throwIfAborted(); if (!current()) return;
      doc.assets.set(id, { revision, source, url: result.url });
      await reply({ dataUri: result.dataUri, open: true });
    } catch (error) { if (!controller.signal.aborted) await reply({ error: fieldPreviewFailure(error) }); }
    finally { if (doc.assetRequests.get(id) === controller) doc.assetRequests.delete(id); }
  }

  private async resolveFieldTitles(doc: ItemDocument, revision: number, controller: AbortController): Promise<void> {
    const target = doc.state.target;
    const connection = this.connections.get(target.connectionId);
    if (!connection || new URL(connection.serverUrl).origin !== target.serverUrl) return;
    const secret = await this.connections.getClientSecret(connection.id);
    if (!secret) return;
    const signal = AbortSignal.any([controller.signal, doc.lifetime.signal, AbortSignal.timeout(30_000)]);
    const ids = doc.state.base.fields.map(field => field.fieldId);
    for (let start = 0; start < ids.length; start += 32) {
      signal.throwIfAborted();
      const titles = await this.client.loadFieldTitles(connection, secret, ids.slice(start, start + 32), target.language, signal);
      const live = this.connections.get(target.connectionId);
      if (signal.aborted || doc.revision !== revision || doc.labelRequest !== controller
        || !live || new URL(live.serverUrl).origin !== target.serverUrl) return;
      await Promise.all([...doc.panels].map(panel => panel.webview.postMessage({ type: "fieldTitles", revision, titles: Object.fromEntries(titles) })));
    }
  }

  private async resolveLabels(doc: ItemDocument, revision: number, controller: AbortController): Promise<void> {
    const fields = doc.state.base.fields.filter(field => {
      const kind = selectionKind(field);
      return (kind && !kind.includes("droplist")) || isGeneralLink(field);
    }).flatMap(field => {
      const snapshot = doc.state.drafts[normalizeId(field.fieldId)]?.clear ? "" : doc.state.drafts[normalizeId(field.fieldId)]?.input ?? (isGeneralLink(field) ? fieldInput(field) : field.value);
      const multi = isMultipleSelection(selectionKind(field));
      let values: readonly string[];
      try {
        if (isGeneralLink(field)) {
          const link = JSON.parse(snapshot || "{}") as { linktype?: string; id?: string };
          values = link.linktype === "internal" && typeof link.id === "string" ? [link.id] : [];
        } else values = multi ? parseMultipleSelection(snapshot) : [snapshot];
      } catch { values = []; }
      return values.filter(Boolean).map(value => ({ id: normalizeId(field.fieldId), value, snapshot, multi, link: isGeneralLink(field) }));
    });
    const connection = this.connections.get(doc.state.target.connectionId);
    const target = doc.state.target;
    const signal = AbortSignal.any([controller.signal, doc.lifetime.signal]);
    let secret: string | undefined;
    if (connection && new URL(connection.serverUrl).origin === target.serverUrl) {
      try { secret = await this.connections.getClientSecret(connection.id); } catch { /* Report unavailable labels below. */ }
    }
    const pending = fields.values();
    // Bound concurrent reads; each lookup uses the captured connection and locale.
    await Promise.all(Array.from({ length: Math.min(4, fields.length) }, async () => {
      for (const field of pending) {
        if (signal.aborted || doc.revision !== revision) return;
        let label = field.multi ? `Unavailable item (${field.value})` : "Unavailable item";
        let name: string | undefined; let path: string | undefined;
        if (connection && secret && isGuid(field.value)) {
          try {
            const item = await this.client.loadSelectionItem(connection, secret, { itemId: field.value }, target.language,
              AbortSignal.any([signal, AbortSignal.timeout(30_000)]));
            name = item.displayName || item.name; path = item.path;
            label = `${name} · ${path}`;
          } catch { /* Missing/inaccessible references retain their raw stored value. */ }
        }
        const live = this.connections.get(target.connectionId);
        if (signal.aborted || doc.revision !== revision || doc.labelRequest !== controller) return;
        if (!live || new URL(live.serverUrl).origin !== target.serverUrl) { label = "Unavailable item"; name = undefined; path = undefined; }
        const draft = doc.state.drafts[field.id];
        const original = doc.state.base.fields.find(f => normalizeId(f.fieldId) === field.id);
        const current = draft?.clear ? "" : draft?.input ?? (original && isGeneralLink(original) ? fieldInput(original) : original?.value);
        if (field.link) {
          try {
            const active = JSON.parse(current ?? "{}") as { linktype?: unknown; id?: unknown };
            if (active.linktype !== "internal" || active.id !== field.value) continue;
          } catch { continue; }
        } else if (field.multi ? !current?.split("|").includes(field.value) : current !== field.snapshot) continue;
        await Promise.all([...doc.panels].map(panel => panel.webview.postMessage({ type: "selectionLabel", revision, id: field.id, value: field.value, label, name, path })));
      }
    }));
  }

  private stateUri(uri: vscode.Uri): vscode.Uri {
    return uri.path.endsWith(".xmitem") ? uri.with({ path: `${uri.path}.state` }) : uri;
  }
  private async readState(uri: vscode.Uri): Promise<EditorState> {
    let source = this.stateUri(uri);
    try { await vscode.workspace.fs.stat(source); }
    catch (error) {
      if (!(error instanceof vscode.FileSystemError && error.code === "FileNotFound")) throw error;
      source = uri; // Existing 0.36.0 documents keep their original snapshot/journal.
    }
    if ((await vscode.workspace.fs.stat(source)).size > 8 * 1024 * 1024) throw new Error("Editor snapshot exceeds its size limit.");
    return parseEditorState(Buffer.from(await vscode.workspace.fs.readFile(source)).toString("utf8"));
  }
  private async persist(uri: vscode.Uri, state: EditorState): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(state));
    parseEditorState(bytes.toString("utf8"));
    const destination = this.stateUri(uri);
    // Never atomically replace the open custom-document resource. File replacement can
    // disturb VS Code's file-backed document lifecycle while its webview is alive.
    const temp = destination.with({ path: `${destination.path}.${randomBytes(8).toString("hex")}.tmp` });
    await vscode.workspace.fs.writeFile(temp, bytes);
    await vscode.workspace.fs.rename(temp, destination, { overwrite: true });
    if (destination.toString() !== uri.toString()) {
      try { await vscode.workspace.fs.stat(uri); }
      catch (error) {
        if (!(error instanceof vscode.FileSystemError && error.code === "FileNotFound")) throw error;
        await vscode.workspace.fs.writeFile(uri, bytes);
      }
    }
  }
  private io(doc: ItemDocument, signal: AbortSignal): EditorIO {
    const credentials = async () => {
      if (signal.aborted) throw new vscode.CancellationError();
      const connection = this.connections.get(doc.state.target.connectionId);
      if (!connection || new URL(connection.serverUrl).origin !== doc.state.target.serverUrl) throw new Error("Connection target changed. This draft cannot be saved to a different server.");
      const secret = await this.connections.getClientSecret(connection.id);
      if (!secret) throw new Error("Connection credentials are unavailable.");
      return { connection, secret };
    };
    return {
      read: async () => { doc.stage = doc.state.attempt ? "Save readback" : "Pre-save item read"; const { connection, secret } = await credentials(); const t = doc.state.target;
        const readSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
        const item = await this.client.loadItem(connection, secret, { itemId: t.itemId }, t.language, t.version, readSignal, false, true);
        return loadSelectionMetadata(this.client, connection, secret, item, readSignal); },
      write: async changes => { doc.stage = "Sitecore write"; const { connection, secret } = await credentials(); const t = doc.state.target;
        await this.client.updateEditorFields(connection, secret, { itemId: t.itemId, language: t.language, version: t.version,
          fields: Object.fromEntries(changes.map(c => [c.name, c.value])) }, AbortSignal.any([signal, AbortSignal.timeout(30_000)])); },
      validateSelections: async (item, changes) => {
        doc.stage = "Selection source validation";
        const { connection, secret } = await credentials();
        const io = selectionIO(this.client, connection, secret, doc.state.target.language, AbortSignal.any([signal, AbortSignal.timeout(30_000)]), doc.state.target.itemId);
        for (const change of changes) {
          const field = item.fields.find(f => normalizeId(f.fieldId) === change.fieldId)!;
          if (isGeneralLink(field)) await validateLinkTarget(field, change.value, io);
          else if (fieldKind(field) === "html") {
            for (const id of newRichLinkTargets(field.value, change.value))
              await validateLinkTarget({ ...field, type: "General Link", value: "", selectionSource: "" }, `<link linktype="internal" id="${id}" />`, io);
          }
          else if (isMultipleSelection(selectionKind(field))) await validateMultipleSelection(field, change.value, io);
          else if (selectionKind(field)) await validateSelection(field, change.value, io);
        }
      },
      persist: state => { doc.stage = "Local save journal"; return this.persist(doc.uri, state); },
    };
  }
  private async flushInputs(doc: ItemDocument): Promise<void> {
    const panel = [...doc.panels].find(candidate => candidate.active && candidate.visible) ?? [...doc.panels].find(candidate => candidate.visible);
    // Hidden webviews can be suspended; their canonical draft already lives in the document.
    if (!panel || !panel.visible || doc.state.attempt) return;
    const id = randomBytes(12).toString("hex");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const drafts = await new Promise<unknown>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Editor inputs could not be synchronized. Keep the tab open and retry.")), 5000);
        doc.flush = { id, revision: doc.revision, panel, finish: resolve,
          fail: () => reject(new EditorValidationError("Finish composing HTML before saving.")) };
        void panel.webview.postMessage({ type: "freeze", id, revision: doc.revision }).then(delivered => { if (!delivered) reject(new Error("Editor is not available.")); }, reject);
      });
      if (!drafts || typeof drafts !== "object" || Array.isArray(drafts)) throw new Error("Invalid editor draft snapshot.");
      const parsed = parseEditorState(JSON.stringify({ ...doc.state, drafts }));
      // Validate eligibility as well as structure, without rejecting invalid text inputs:
      // validation errors must remain drafts that the user can correct.
      for (const key of Object.keys(parsed.drafts)) {
        const field = parsed.base.fields.find(f => normalizeId(f.fieldId) === key)!;
        if (readOnlyReason(parsed.base, field)) throw new Error("Read-only field was included in an editor draft.");
      }
      // Final IME/pending edits may arrive after busy was set. Register them in native
      // history too, so undo after Save includes the synchronized source snapshot.
      for (const field of parsed.base.fields) {
        const key = normalizeId(field.fieldId);
        const before = doc.state.drafts[key] ?? { input: fieldInput(field), clear: false };
        const after = parsed.drafts[key] ?? { input: fieldInput(field), clear: false };
        if (before.input !== after.input || before.clear !== after.clear) this.recordEdit(doc, key, before, after, `Edit ${field.name}`);
      }
      doc.state = { ...doc.state, drafts: parsed.drafts };
    } finally { clearTimeout(timer); doc.flush = undefined; }
  }

  private async exclusive(doc: ItemDocument, action: () => Promise<void>): Promise<void> {
    if (doc.busy) throw new Error("Editor operation already in progress.");
    doc.cancelSelections();
    doc.error = undefined;
    doc.stage = "Editor input synchronization";
    doc.busy = true;
    let synchronized = false;
    try {
      await this.flushInputs(doc);
      synchronized = true;
      doc.revision++;
      await this.render(doc);
      await action();
    }
    catch (error) {
      if (error instanceof vscode.CancellationError && !doc.state.attempt) throw error;
      doc.error = editorFailure(error, doc.stage, Boolean(doc.state.attempt));
      throw new Error(doc.error);
    }
    finally {
      doc.busy = false; doc.revision++;
      if (synchronized) await this.render(doc);
      else await Promise.all([...doc.panels].map(panel => panel.webview.postMessage({ type: "unfreeze", revision: doc.revision, error: doc.error })));
    }
  }
  async saveCustomDocument(doc: ItemDocument, token: vscode.CancellationToken): Promise<void> {
    await this.exclusive(doc, async () => {
      doc.stage = "Save validation";
      const changes = planChanges(doc.state);
      if (doc.state.attempt) throw new Error("Check the previous save outcome before retrying.");
      if (!changes.length) { doc.state = { ...doc.state, drafts: {} }; await this.persist(doc.uri, doc.state); return; }
      const details = changes.map(c => `${c.name} (${c.scope.toLowerCase()})`).join(", ");
      const impact = [
        changes.some(c => c.scope === "SHARED") ? "Shared changes affect all languages and versions." : "",
        changes.some(c => c.scope === "UNVERSIONED") ? "Unversioned changes affect all versions in this locale." : "",
        changes.some(c => doc.state.base.fields.some(f => normalizeId(f.fieldId) === c.fieldId && (f.containsInheritedValue || f.containsStandardValue)))
          ? "Changed inherited or Standard Values become explicit overrides." : "",
        changes.some(c => c.value === "") ? "Clear stores an empty value, not a reset." : "",
        "Changed fields are checked again before writing; Sitecore does not provide an atomic conflict lock.",
      ].filter(Boolean).join("\n");
      const confirmed = await vscode.window.showWarningMessage(`Save ${changes.length} field(s) to ${doc.state.base.path} · ${doc.state.target.language} v${doc.state.target.version}?`,
        { modal: true, detail: `${details}\n${impact}` }, "Save to Sitecore");
      if (confirmed !== "Save to Sitecore" || token.isCancellationRequested) throw new vscode.CancellationError();
      const abort = new AbortController();
      const cancel = token.onCancellationRequested(() => abort.abort());
      const shutdown = () => abort.abort(); doc.lifetime.signal.addEventListener("abort", shutdown, { once: true });
      try { await saveEditor(doc.state, this.io(doc, abort.signal), state => { doc.state = state; }); this.saved.fire(doc.state.target); }
      finally { cancel.dispose(); doc.lifetime.signal.removeEventListener("abort", shutdown); }
    });
  }
  async revertCustomDocument(doc: ItemDocument, token: vscode.CancellationToken): Promise<void> {
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    if (doc.state.attempt && await vscode.window.showWarningMessage("The last save may have changed Sitecore. Reloading discards this draft and its save tracking; it does not undo or stop the remote write.", { modal: true }, "Discard tracking and reload") !== "Discard tracking and reload") throw new vscode.CancellationError();
    const abort = new AbortController();
    const cancellation = token.onCancellationRequested(() => abort.abort());
    try { await this.exclusive(doc, async () => {
      const fresh = await this.io(doc, AbortSignal.any([doc.lifetime.signal, abort.signal])).read(); assertItem(doc.state.target, fresh);
      const state: EditorState = { ...doc.state, base: fresh, drafts: {}, attempt: undefined };
      await this.persist(doc.uri, state); doc.state = state; doc.historyEpoch++;
    }); } finally { cancellation.dispose(); }
  }
  saveCustomDocumentAs(): Promise<void> { return Promise.reject(new Error("Save As is unavailable for a pinned Sitecore item. Use Save.")); }
  async backupCustomDocument(doc: ItemDocument, context: vscode.CustomDocumentBackupContext, token?: vscode.CancellationToken): Promise<vscode.CustomDocumentBackup> {
    if (token?.isCancellationRequested) throw new vscode.CancellationError();
    await this.persist(context.destination, doc.state);
    return { id: context.destination.toString(), delete: async () => { await vscode.workspace.fs.delete(context.destination); } };
  }
}
