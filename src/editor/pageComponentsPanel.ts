import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import type { ConnectionStore } from "../connections/connectionStore";
import type { AuthoringContentClient } from "../sitecore/authoringClient";
import { PreviewReferenceClient } from "../sitecore/previewReferences";
import { ComponentReferences } from "./componentReferences";
import { previewReferenceEvidence } from "./componentReferenceEvidence";
import { PreviewDiagnosticClient } from "../sitecore/previewDiagnostic";
import { isGuid, isLocale } from "./itemEditorModel";
import { componentRoute, componentDeviceName, escapeComponentHtml as esc, parsePageComponents, renderComponentTree, resolveComponentDatasources, type ComponentPlaceholder, type ComponentOccurrence, type PageComponents } from "./pageComponents";
import { actionIconSvg } from "../ui/actionIcons";

import { componentItemDetails } from "./componentDetails";
import type { AuthoringItemDetails } from "../sitecore/authoringClient";

interface ComponentActions {
  readonly extensionUri: vscode.Uri;
  reveal(connectionId: string, itemId: string, language: string, path: string): Promise<void>;
  edit(connectionId: string, itemId: string, language: string, version: number): Promise<void>;
}

type Connections = Pick<ConnectionStore, "get" | "getClientSecret" | "getPreviewToken" | "listVerifiedSites">;
type Authoring = Pick<AuthoringContentClient, "loadItem" | "loadLanguages" | "testConnection" | "loadSelectionItem">;

export class PageComponentsPanel implements vscode.Disposable {
  private readonly panels = new Set<vscode.WebviewPanel>();
  private readonly lifetime = new AbortController();
  constructor(private readonly connections: Connections, private readonly authoring: Authoring,
    private readonly preview: Pick<PreviewDiagnosticClient, "collect"> = new PreviewDiagnosticClient(),
    private readonly actions?: ComponentActions,
    private readonly referenceClient: Pick<PreviewReferenceClient, "read"> = new PreviewReferenceClient()) {}
  dispose(): void { this.lifetime.abort(); for (const panel of this.panels) panel.dispose(); this.panels.clear(); }

  async open(args: unknown): Promise<void> {
    if (!args || typeof args !== "object") throw Error("Choose View components… from a page's context menu.");
    const target = args as Record<string, unknown>;
    if (typeof target.connectionId !== "string" || !isGuid(target.itemId) || !isLocale(target.language)) throw Error("Invalid page target.");
    const savedConnection = this.connections.get(target.connectionId);
    if (!savedConnection) throw Error("Connection no longer exists.");
    const connection = { ...savedConnection };
    const initialLanguage = target.language, itemId = target.itemId;
    const validConnection = (): boolean => {
      const current = this.connections.get(connection.id);
      return current?.serverUrl === connection.serverUrl && current.clientId === connection.clientId;
    };
    const secret = await this.connections.getClientSecret(connection.id);
    if (!secret) throw Error("Configure connection credentials first.");
    if (!await this.connections.getPreviewToken(connection.id)) throw Error("Configure the CM Preview token in Connection settings first.");
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(30_000)]);
    const item = await this.authoring.loadItem(connection, secret, { itemId }, initialLanguage, undefined, signal);
    if (item.itemId.replace(/[{}-]/gu, "").toLowerCase() !== itemId.replace(/[{}-]/gu, "").toLowerCase()) throw Error("Authoring returned a different item.");
    if (!item.path.toLowerCase().startsWith("/sitecore/content/")) throw Error("Select a content page.");
    let sites = this.connections.listVerifiedSites(connection.id);
    if (!sites.length) sites = (await this.authoring.testConnection(connection, secret, signal)).sites;
    const candidates = sites.filter(site => item.path.toLowerCase().startsWith(site.rootPath.replace(/\/$/u, "").toLowerCase() + "/"));
    if (!candidates.length) throw Error("No site matches this item. Test the connection to discover its sites.");
    const longest = Math.max(...candidates.map(site => site.rootPath.length));
    const matches = candidates.filter(site => site.rootPath.length === longest);
    const site = matches.length === 1 ? matches[0] : (await vscode.window.showQuickPick(matches.map(value =>
      ({ label: value.name, description: value.rootPath, value })), { title: "Site for page components" }))?.value;
    if (!site) return;
    let route: string | undefined;
    try { route = componentRoute(item.path, site); } catch {
      route = await vscode.window.showInputBox({ title: "Site-relative Preview route", prompt: "For example / or /About Us", ignoreFocusOut: true,
        validateInput: value => value.startsWith("/") && !/[\r\n?#]/u.test(value) && value.length <= 2048 ? undefined : "Enter a site-relative path starting with /." });
    }
    if (route === undefined) return;
    const selectedRoute = route;
    const languages = (await this.authoring.loadLanguages(connection, secret, signal)).map(value => value.name);
    if (!languages.includes(initialLanguage)) languages.unshift(initialLanguage);
    signal.throwIfAborted();
    if (!validConnection()) throw Error("Connection changed. Open the page again.");
    const panel = vscode.window.createWebviewPanel("xmCloudSync.pageComponents", `${item.displayName || item.name} · Components`,
      vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [] });
    this.panels.add(panel);
    let graph: ComponentReferences | undefined;
    let graphRequest: AbortController | undefined;
    let request: AbortController | undefined, detailRequest: AbortController | undefined;
    let revision = 0, detailRevision = 0, disposed = false, language = initialLanguage;
    const targets = new Map<string, string>();
    const components = new Map<string, ComponentOccurrence>();
    let selectedItem: AuthoringItemDetails | undefined;
    let selectedKey: string | undefined;
    let lastIntent = 0;
    const references = new Map<string, string>();
    const extensionUri = this.actions?.extensionUri ?? vscode.extensions.getExtension("OzrenTK.sitecore-xm-cloud-sync")!.extensionUri;
    const media = vscode.Uri.joinPath(extensionUri, "media", "components");
    const shared = vscode.Uri.joinPath(extensionUri, "media", "shared");
    panel.webview.options = { enableScripts: true, localResourceRoots: [media, shared] };
    const html = (body: string, busy: boolean, layout?: PageComponents, deviceName?: string): string => {
      const nonce = randomBytes(18).toString("hex");
      const uri = (root: vscode.Uri, file: string): string => panel.webview.asWebviewUri(vscode.Uri.joinPath(root, file)).toString();
      return `<!DOCTYPE html><html><head><meta charset="utf-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src data:; style-src ${panel.webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <link rel="stylesheet" href="${uri(media, "components.css")}"><link rel="stylesheet" href="${uri(shared, "readOnlyField.css")}"><style id="pane-size" nonce="${nonce}">:root{--tree-width:50%}</style></head>
      <body data-revision="${revision}"><header id="page-header"><div class="header-controls"><h1>${esc(item.displayName || item.name)}</h1><label>Language <select id="language" ${busy ? "disabled" : ""}>${languages.map(value =>
        `<option ${value === language ? "selected" : ""}>${esc(value)}</option>`).join("")}</select></label><button id="refresh" ${busy ? "disabled" : ""}>Refresh</button></div>
      <p>${esc(connection.name)} · ${esc(site.name)} · Source locale: unknown (Preview)</p>
      ${layout ? `<div class="layout-summary"><span id="component-count">${layout.count} component occurrence(s)</span>
        <details id="layout-context"><summary title="Layout context" aria-label="Layout context">${actionIconSvg("info")}</summary><div class="layout-metadata">
        <p>Returned locale/version: ${esc(layout.returnedLanguage)} / ${layout.returnedVersion}</p>
        <p>Device: <span title="${esc(layout.device)}">${esc(deviceName ?? componentDeviceName(layout.device))}</span></p>
        <p class="device-id">Device ID: ${esc(layout.device)}</p></div></details></div>` : ""}</header>
      <div id="workspace"><section id="tree" aria-label="Components" aria-busy="${busy}">${body}</section>
      <div id="divider" role="separator" tabindex="0" aria-label="Resize details" aria-orientation="vertical" aria-valuemin="25" aria-valuemax="75" aria-valuenow="50"></div>
      <section id="details" aria-label="Selection details"><nav id="details-toolbar"><button id="back">Back to tree</button><button id="expand" class="icon-toggle" aria-pressed="false" aria-label="Expand details" title="Expand details" hidden disabled><span class="expand-icon">${actionIconSvg("expandPane")}</span><span class="restore-icon">${actionIconSvg("restorePane")}</span></button></nav><div id="detail-content" aria-live="polite"><p>Select a component or datasource.</p></div></section></div>
      <script nonce="${nonce}" src="${uri(shared, "readOnlyField.js")}"></script><script nonce="${nonce}" src="${uri(media, "components.js")}"></script></body></html>`;
    };
    const resetDetails = (): void => {
      detailRequest?.abort(); detailRevision++; selectedItem = undefined; selectedKey = undefined; references.clear();
    };
    const load = async (): Promise<void> => {
      request?.abort(); graphRequest?.abort(); graph = undefined; resetDetails(); request = new AbortController();
      graphRequest = new AbortController();
      const current = ++revision;
      targets.clear(); components.clear(); lastIntent = 0;
      const selectedLanguage = language;
      const active = AbortSignal.any([this.lifetime.signal, request.signal, AbortSignal.timeout(30_000)]);
      panel.webview.html = html("<p>Loading components…</p>", true);
      try {
        if (!validConnection()) throw Error("Connection changed.");
        const token = await this.connections.getPreviewToken(connection.id);
        if (!token) throw Error("Preview token unavailable.");
        active.throwIfAborted();
        const report = await this.preview.collect(connection.serverUrl, token, { site: site.name, route: selectedRoute, language: selectedLanguage }, active);
        const tree = parsePageComponents(report, { itemId, language: selectedLanguage, site: site.name }, active);
        const authoringSecret = await this.connections.getClientSecret(connection.id);
        const datasources = await resolveComponentDatasources(tree, async reference => {
          if (!authoringSecret || !validConnection()) throw Error("Connection unavailable.");
          const resolved = await this.authoring.loadSelectionItem(connection, authoringSecret,
            isGuid(reference) ? { itemId: reference } : { path: reference }, selectedLanguage, active);
          return { itemId: resolved.itemId, label: resolved.displayName || resolved.name, path: resolved.path };
        }, active);
        let deviceName = componentDeviceName(tree.device);
        if (isGuid(tree.device) && deviceName !== "Default" && authoringSecret) {
          try {
            const device = await this.authoring.loadSelectionItem(connection, authoringSecret, { itemId: tree.device }, selectedLanguage,
              AbortSignal.any([active, AbortSignal.timeout(3_000)]));
            if (device.itemId.replace(/[{}-]/gu, "").toLowerCase() === tree.device.replace(/[{}-]/gu, "").toLowerCase()
              && device.path.toLowerCase().startsWith("/sitecore/layout/devices/")) deviceName = device.displayName || device.name;
          } catch { active.throwIfAborted(); /* Keep the returned ID when metadata is unavailable. */ }
        }
        if (disposed || current !== revision) return;
        if (!validConnection()) throw Error("Connection changed.");
        const evidence = previewReferenceEvidence(report);
        const graphSignal = AbortSignal.any([this.lifetime.signal, graphRequest.signal]);
        const nextGraph = new ComponentReferences(async (id, signal) => {
          if (!validConnection()) throw Error("Connection changed.");
          const result = await this.referenceClient.read(connection.serverUrl, token, id, selectedLanguage, signal);
          if (!validConnection()) throw Error("Connection changed.");
          return result;
        }, graphSignal, evidence);
        const collectTargets = (placeholders: readonly ComponentPlaceholder[]): void => {
          for (const placeholder of placeholders) for (const component of placeholder.components) {
            components.set(component.key, component);
            const resolved = datasources.get(component.datasource);
            if (resolved?.itemId) {
              targets.set(component.key, resolved.itemId);
              nextGraph.root(component.key, resolved.itemId, evidence.get(resolved.itemId.replace(/[{}-]/gu, "").toLowerCase()));
            }
            collectTargets(component.placeholders);
          }
        };
        collectTargets(tree.placeholders);
        graph = nextGraph;
        panel.webview.html = html(renderComponentTree(tree, datasources), false, tree, deviceName);
      } catch {
        if (disposed || current !== revision || request.signal.aborted || this.lifetime.signal.aborted) return;
        panel.webview.html = html("<p>Components unavailable. Check the CM Preview token and site route. The response must match this page and language and fit the layout limits (500 components, 20 levels).</p>", false);
      }
    };
    const select = async (key: string, intent: number, referenceId?: string): Promise<void> => {
      resetDetails(); selectedKey = key;
      detailRequest = new AbortController();
      const current = detailRevision, layoutRevision = revision, locale = language;
      const signal = AbortSignal.any([detailRequest.signal, this.lifetime.signal, AbortSignal.timeout(30_000)]);
      const currentSelection = (): boolean => !disposed && current === detailRevision && layoutRevision === revision && validConnection();
      const component = components.get(key);
      const instance = component ? { name: component.name, uid: component.uid, datasource: component.datasource, parameters: component.parameters, issues: component.issues } : undefined;
      const targetId = referenceId ?? targets.get(key);
      try {
        await panel.webview.postMessage({ type: "details", revision, selection: current, intent, key, loading: true, instance });
        if (!targetId) {
          if (currentSelection()) await panel.webview.postMessage({ type: "details", revision, selection: current, intent, key, instance,
            error: component?.datasource ? "Datasource unresolved or unavailable. No item has been substituted." : "No datasource is declared for this component." });
          return;
        }
        const secret = await this.connections.getClientSecret(connection.id);
        if (!secret || !currentSelection()) throw Error("Connection unavailable.");
        const details = await this.authoring.loadItem(connection, secret, { itemId: targetId }, locale, undefined, signal, false, true);
        const view = componentItemDetails(details, targetId, locale);
        const resolvedReferences: { key: string; label: string; field: string; unavailable: boolean }[] = [];
        const localReferences = new Map<string, string>();
        for (let offset = 0; offset < view.references.length; offset += 4) {
          signal.throwIfAborted();
          await Promise.all(view.references.slice(offset, offset + 4).map(async (reference, index) => {
            const refKey = `reference:${offset + index}`;
            try {
              const result = await this.authoring.loadSelectionItem(connection, secret, { itemId: reference.id }, locale, signal);
              if (!isGuid(result.itemId) || result.itemId.replace(/[{}-]/gu, "").toLowerCase() !== reference.id.replace(/[{}-]/gu, "").toLowerCase()) throw Error("Mismatched reference.");
              localReferences.set(refKey, result.itemId);
              resolvedReferences.push({ key: refKey, label: result.displayName || result.name, field: reference.field, unavailable: false });
            } catch { signal.throwIfAborted(); resolvedReferences.push({ key: refKey, label: `${reference.id} — unavailable`, field: reference.field, unavailable: true }); }
          }));
        }
        signal.throwIfAborted();
        if (!currentSelection()) return;
        selectedItem = details;
        for (const [refKey, id] of localReferences) references.set(refKey, id);
        await panel.webview.postMessage({ type: "details", revision, selection: current, intent, key, instance,
          connectionName: connection.name, item: { ...view, role: referenceId ? "Referenced item" : "Datasource", references: resolvedReferences.sort((a, b) => Number(a.key.slice(10)) - Number(b.key.slice(10))) } });
      } catch {
        if (currentSelection() && !detailRequest.signal.aborted) await panel.webview.postMessage({ type: "details", revision, selection: current, intent, key, instance,
          error: "Item details unavailable. Check the connection and requested locale; the item may be missing, inaccessible or exceed inspection limits." });
      }
    };
    const listener = panel.webview.onDidReceiveMessage((message: unknown) => {
      if (!message || typeof message !== "object" || disposed) return;
      const value = message as Record<string, unknown>;
      if (value.revision !== revision || !validConnection()) return;
      if (value.type === "expandReferences" && typeof value.key === "string" && graph?.target(value.key)) {
        const currentGraph = graph, currentRevision = revision, key = value.key;
        void currentGraph.expand(key).then(result => {
          if (!disposed && revision === currentRevision && graph === currentGraph && validConnection())
            return panel.webview.postMessage({ type: "references", revision, key, ...result });
          return undefined;
        }).catch(() => {
          if (!disposed && revision === currentRevision && graph === currentGraph && validConnection())
            void panel.webview.postMessage({ type: "references", revision, key, groups: [], notice: "Preview references unavailable or over limits. Refresh to retry." });
        });
        return;
      }
      if (value.type === "selectReference" && typeof value.key === "string" && graph?.target(value.key)
        && Number.isSafeInteger(value.intent) && Number(value.intent) > lastIntent) {
        lastIntent = Number(value.intent); void select(value.key, lastIntent, graph.target(value.key)); return;
      }
      if (value.type === "select" && typeof value.key === "string" && components.has(value.key) && Number.isSafeInteger(value.intent) && Number(value.intent) > lastIntent) {
        lastIntent = Number(value.intent); void select(value.key, lastIntent); return;
      }
      if (value.type === "reference" && value.selection === detailRevision && typeof value.key === "string" && selectedKey
        && Number.isSafeInteger(value.intent) && Number(value.intent) > lastIntent) {
        const id = references.get(value.key); if (id) { lastIntent = Number(value.intent); void select(selectedKey, lastIntent, id); } return;
      }
      if ((value.type === "reveal" || value.type === "edit") && value.selection === detailRevision && selectedItem && this.actions) {
        const target = selectedItem;
        const operation = value.type === "reveal" ? this.actions.reveal(connection.id, target.itemId, language, target.path)
          : componentItemDetails(target, target.itemId, language).editable ? this.actions.edit(connection.id, target.itemId, language, target.version) : undefined;
        void operation?.catch(() => vscode.window.showErrorMessage("Unable to open the selected datasource. Check its connection and exact-locale version."));
        return;
      }
      if (value.type !== "load" || typeof value.language !== "string" || !languages.includes(value.language)) return;
      language = value.language; void load();
    });
    panel.onDidDispose(() => { disposed = true; request?.abort(); graphRequest?.abort(); resetDetails(); listener.dispose(); this.panels.delete(panel); });
    await load();
  }
}
