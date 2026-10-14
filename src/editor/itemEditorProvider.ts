import { parseMultipleSelection, validateMultipleSelection } from "./multipleSelection";
import { isMultipleSelection } from "./singleSelection";
import { orderEditorFields } from "./fieldOrder";
import { loadSelectionMetadata, selectionIO } from "./selectionClient";
import { loadSelectionPage, selectionKind, selectionValue, validateSelection } from "./singleSelection";
import { editorFailure } from "./editorFailure";
import * as vscode from "vscode";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { ConnectionStore } from "../connections/connectionStore";
import { AuthoringContentClient } from "../sitecore/authoringClient";
import { assertItem, editorKey, fieldInput, fieldKind, isGuid, isLocale, normalizeId, parseEditorState,
  EditorValidationError, planChanges, readOnlyReason, reconcileEditor, saveEditor, type EditorIO, type EditorState, type EditorTarget } from "./itemEditorModel";

function localKey(uri: vscode.Uri): string {
  const path = resolve(uri.fsPath);
  return process.platform === "win32" ? path.toLowerCase() : path;
}
export const itemEditorViewType = "xmCloudSync.itemEditor";
export class ItemDocument implements vscode.CustomDocument {
  labelRequest: AbortController | undefined;
  readonly selections = new Map<string, AbortController>();
  cancelSelections(): void { this.labelRequest?.abort(); for (const request of this.selections.values()) request.abort(); this.selections.clear(); }
  readonly panels = new Set<vscode.WebviewPanel>();
  busy = false;
  error: string | undefined;
  stage = "Editor operation";
  revision = 0;
  flush: { id: string; finish: (value: unknown) => void } | undefined;
  readonly lifetime = new AbortController();
  private readonly disposed = new vscode.EventEmitter<void>();
  readonly onDidDispose = this.disposed.event;
  constructor(readonly uri: vscode.Uri, public state: EditorState) {}
  dispose(): void { this.cancelSelections(); this.lifetime.abort(); this.disposed.fire(); this.disposed.dispose(); }
}

/** VS Code owns dirty/close/backup handling; the document owns its immutable remote target. */
export class ItemEditorProvider implements vscode.CustomEditorProvider<ItemDocument>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.CustomDocumentContentChangeEvent<ItemDocument>>();
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
    panel.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = randomBytes(16).toString("hex");
    panel.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${panel.webview.asWebviewUri(vscode.Uri.joinPath(media, "editor.css"))}"></head><body><header><h1 id="title"></h1><p id="identity"></p><p id="path"></p><button id="save">Save</button> <button id="revert">Revert</button> <button id="reconcile">Check save outcome</button> <button id="locale">Open existing locale/version…</button><p id="status" role="status"></p></header><main id="fields"></main><script nonce="${nonce}" src="${panel.webview.asWebviewUri(vscode.Uri.joinPath(media, "editor.js"))}"></script></body></html>`;
    const subscription = panel.webview.onDidReceiveMessage(message => {
      void this.message(doc, message).catch(error => {
        if (error instanceof vscode.CancellationError) return;
        void vscode.window.showErrorMessage(doc.error ?? editorFailure(error, doc.stage, Boolean(doc.state.attempt)));
      });
    });
    panel.onDidDispose(() => { subscription.dispose(); doc.panels.delete(panel); });
    if (Object.keys(doc.state.drafts).length || doc.state.attempt) this.changed.fire({ document: doc });
  }

  private async message(doc: ItemDocument, raw: unknown): Promise<void> {
    if (doc.lifetime.signal.aborted || !raw || typeof raw !== "object") return;
    const message = raw as Record<string, unknown>;
    if (message.type === "frozen" && message.id === doc.flush?.id) { doc.flush?.finish(message.drafts); return; }
    if (message.type === "ready") { await this.render(doc); return; }
    if (doc.busy || message.revision !== doc.revision) return;
    if (message.type === "choices") {
      await this.choices(doc, message);
      return;
    }
    if (message.type === "change" && typeof message.id === "string" && typeof message.input === "string" && message.input.length <= 1024 * 1024 && typeof message.clear === "boolean") {
      const field = doc.state.base.fields.find(f => normalizeId(f.fieldId) === message.id);
      if (!field || readOnlyReason(doc.state.base, field) || doc.state.attempt) return;
      doc.state = { ...doc.state, drafts: { ...doc.state.drafts, [message.id]: { input: message.input, clear: message.clear } } };
      this.changed.fire({ document: doc });
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

  private async choices(doc: ItemDocument, message: Record<string, unknown>): Promise<void> {
    if (typeof message.id !== "string" || typeof message.request !== "string" || message.request.length > 100
      || (message.parent !== undefined && !isGuid(message.parent))) return;
    const field = doc.state.base.fields.find(f => normalizeId(f.fieldId) === message.id);
    if (!field || !selectionKind(field) || readOnlyReason(doc.state.base, field)) return;
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
      const io = selectionIO(this.client, connection, secret, doc.state.target.language, signal);
      const page = await loadSelectionPage(field, io, message.parent as string | undefined);
      let currentLabel = field.value ? "Unresolved or outside allowed Source (original value preserved)" : "No selection";
      const current = page.choices.find(choice => selectionKind(field)!.includes("droplist") ? choice.name === field.value : normalizeId(choice.itemId) === normalizeId(field.value));
      let currentName = current ? current.displayName || current.name : undefined;
      let currentPath = current?.path;
      if (current) currentLabel = `${current.displayName || current.name} · ${current.path}${current.disabled ? " · ambiguous name" : ""}`;
      else if (isGuid(field.value)) {
        try { const item = await io.item({ itemId: field.value }); currentName = item.displayName || item.name; currentPath = item.path; currentLabel = `${currentName} · ${item.path} (not in this choice list; original preserved)`; } catch { /* Keep raw current reference visible. */ }
      }
      response = { page: { ...page, choices: page.choices.map(choice => ({ ...choice, value: selectionValue(selectionKind(field)!, choice) })) }, currentLabel, currentName, currentPath };
    } catch (error) {
      response = { error: error instanceof EditorValidationError ? error.message : "Could not load verified choices. Check source access or limits, then retry; the current value is preserved." };
    }
    const liveConnection = this.connections.get(doc.state.target.connectionId);
    if (!liveConnection || new URL(liveConnection.serverUrl).origin !== doc.state.target.serverUrl) controller.abort();
    if (doc.selections.get(id) !== controller || controller.signal.aborted || doc.lifetime.signal.aborted || doc.revision !== revision || doc.busy) return;
    doc.selections.delete(id);
    await Promise.all([...doc.panels].map(panel => panel.webview.postMessage({ type: "choices", id, request: message.request, revision, ...response })));
  }

  private async render(doc: ItemDocument): Promise<void> {
    let status = "";
    try { status = `${planChanges(doc.state).length} changed field(s)`; } catch (error) { status = error instanceof Error ? error.message : "Invalid draft"; }
    if (doc.state.attempt) status = "Save outcome needs reconciliation. Draft preserved; further writes are blocked.";
    if (!doc.state.target.version) status = "No exact-locale version exists. Open an existing locale/version to edit; no version will be created.";
    const payload = { type: "state", revision: doc.revision, busy: doc.busy, status, pending: Boolean(doc.state.attempt),
      connection: this.connections.get(doc.state.target.connectionId)?.name ?? "Unavailable connection", target: doc.state.target,
      item: { name: doc.state.base.displayName || doc.state.base.name, path: doc.state.base.path },
      error: doc.error,
      fields: orderEditorFields(doc.state.base.fields).map(field => ({
        id: normalizeId(field.fieldId), label: field.name, name: field.name, section: field.sectionName || "Fields", type: field.type,
        sectionId: field.sectionId ? normalizeId(field.sectionId) : undefined, isStandardTemplate: field.isStandardTemplate,
        scope: field.scope, source: field.containsFallbackValue ? "Fallback (unverified source)" : field.containsInheritedValue ? "Inherited" : field.containsStandardValue ? "Standard Value" : "Exact locale",
        selectionKind: selectionKind(field),
        kind: fieldKind(field), reason: readOnlyReason(doc.state.base, field), input: doc.state.drafts[normalizeId(field.fieldId)]?.input ?? fieldInput(field),
        original: fieldInput(field),
        clear: doc.state.drafts[normalizeId(field.fieldId)]?.clear ?? false, raw: field.value,
      })) };
    await Promise.all([...doc.panels].map(panel => panel.webview.postMessage(payload)));
    doc.labelRequest?.abort();
    if (!doc.busy && !doc.lifetime.signal.aborted) {
      const controller = new AbortController(); doc.labelRequest = controller;
      void this.resolveFieldTitles(doc, doc.revision, controller).catch(() => { /* Internal names remain usable when optional titles fail. */ });
      void this.resolveLabels(doc, doc.revision, controller).catch(() => { /* Labels never affect drafts or save state. */ });
    }
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
      return kind && !kind.includes("droplist");
    }).flatMap(field => {
      const snapshot = doc.state.drafts[normalizeId(field.fieldId)]?.clear ? "" : doc.state.drafts[normalizeId(field.fieldId)]?.input ?? field.value;
      const multi = isMultipleSelection(selectionKind(field));
      let values: readonly string[];
      try { values = multi ? parseMultipleSelection(snapshot) : [snapshot]; } catch { values = []; }
      return values.filter(Boolean).map(value => ({ id: normalizeId(field.fieldId), value, snapshot, multi }));
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
        const current = draft?.clear ? "" : draft?.input ?? doc.state.base.fields.find(f => normalizeId(f.fieldId) === field.id)?.value;
        if (field.multi ? !current?.split("|").includes(field.value) : current !== field.snapshot) continue;
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
        const io = selectionIO(this.client, connection, secret, doc.state.target.language, AbortSignal.any([signal, AbortSignal.timeout(30_000)]));
        for (const change of changes) {
          const field = item.fields.find(f => normalizeId(f.fieldId) === change.fieldId)!;
          if (isMultipleSelection(selectionKind(field))) await validateMultipleSelection(field, change.value, io);
          else if (selectionKind(field)) await validateSelection(field, change.value, io);
        }
      },
      persist: state => { doc.stage = "Local save journal"; return this.persist(doc.uri, state); },
    };
  }
  private async flushInputs(doc: ItemDocument): Promise<void> {
    const panel = [...doc.panels][0];
    // Hidden webviews can be suspended; their canonical draft already lives in the document.
    if (!panel || !panel.visible || doc.state.attempt) return;
    const id = randomBytes(12).toString("hex");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const drafts = await new Promise<unknown>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Editor inputs could not be synchronized. Keep the tab open and retry.")), 5000);
        doc.flush = { id, finish: resolve };
        void panel.webview.postMessage({ type: "freeze", id }).then(delivered => { if (!delivered) reject(new Error("Editor is not available.")); }, reject);
      });
      if (!drafts || typeof drafts !== "object" || Array.isArray(drafts)) throw new Error("Invalid editor draft snapshot.");
      const parsed = parseEditorState(JSON.stringify({ ...doc.state, drafts }));
      // Validate eligibility as well as structure, without rejecting invalid text inputs:
      // validation errors must remain drafts that the user can correct.
      for (const key of Object.keys(parsed.drafts)) {
        const field = parsed.base.fields.find(f => normalizeId(f.fieldId) === key)!;
        if (readOnlyReason(parsed.base, field)) throw new Error("Read-only field was included in an editor draft.");
      }
      doc.state = parsed;
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
      await this.persist(doc.uri, state); doc.state = state;
    }); } finally { cancellation.dispose(); }
  }
  saveCustomDocumentAs(): Promise<void> { return Promise.reject(new Error("Save As is unavailable for a pinned Sitecore item. Use Save.")); }
  async backupCustomDocument(doc: ItemDocument, context: vscode.CustomDocumentBackupContext, token?: vscode.CancellationToken): Promise<vscode.CustomDocumentBackup> {
    if (token?.isCancellationRequested) throw new vscode.CancellationError();
    await this.persist(context.destination, doc.state);
    return { id: context.destination.toString(), delete: async () => { await vscode.workspace.fs.delete(context.destination); } };
  }
}
