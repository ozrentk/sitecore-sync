import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import type { ConnectionStore } from "../connections/connectionStore";
import type { AuthoringContentClient } from "../sitecore/authoringClient";
import { PreviewDiagnosticClient } from "../sitecore/previewDiagnostic";
import { isGuid, isLocale } from "./itemEditorModel";
import { componentRoute, escapeComponentHtml as esc, parsePageComponents, renderComponentTree, resolveComponentDatasources, type ComponentPlaceholder } from "./pageComponents";

type Connections = Pick<ConnectionStore, "get" | "getClientSecret" | "getPreviewToken" | "listVerifiedSites">;
type Authoring = Pick<AuthoringContentClient, "loadItem" | "loadLanguages" | "testConnection" | "loadSelectionItem">;

export class PageComponentsPanel implements vscode.Disposable {
  private readonly panels = new Set<vscode.WebviewPanel>();
  private readonly lifetime = new AbortController();
  constructor(private readonly connections: Connections, private readonly authoring: Authoring,
    private readonly preview: Pick<PreviewDiagnosticClient, "collect"> = new PreviewDiagnosticClient(),
    private readonly openDatasource?: (connectionId: string, itemId: string, language: string) => Promise<void>) {}
  dispose(): void { this.lifetime.abort(); for (const panel of this.panels) panel.dispose(); this.panels.clear(); }

  async open(args: unknown): Promise<void> {
    if (!args || typeof args !== "object") throw Error("Choose View components… from a page's context menu.");
    const target = args as Record<string, unknown>;
    if (typeof target.connectionId !== "string" || !isGuid(target.itemId) || !isLocale(target.language)) throw Error("Invalid page target.");
    const connection = this.connections.get(target.connectionId);
    if (!connection) throw Error("Connection no longer exists.");
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
    let request: AbortController | undefined, revision = 0, disposed = false;
    let language = initialLanguage;
    const targets = new Map<string, string>();
    const html = (body: string, busy: boolean): string => {
      const nonce = randomBytes(18).toString("hex");
      return `<!DOCTYPE html><html><head><meta charset="utf-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <style nonce="${nonce}">body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:16px}
      header{display:flex;align-items:center;gap:12px;flex-wrap:wrap}h1{font-size:1.3em}button,select{font:inherit;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);padding:5px}
      ul{list-style:none;padding-left:20px}.tree{padding:0}li{margin:10px 0}summary{cursor:pointer}summary:focus-visible{outline:1px solid var(--vscode-focusBorder)}
      .datasource,.info,.muted{margin:8px 0 8px 18px;font-size:.95em}.muted,summary span{color:var(--vscode-descriptionForeground)}
      pre,.datasource{white-space:pre-wrap;overflow-wrap:anywhere}.info{font-size:.9em}button{cursor:pointer}</style></head>
      <body><header><h1>${esc(item.displayName || item.name)}</h1><label>Language <select id="language" ${busy ? "disabled" : ""}>${languages.map(value =>
        `<option ${value === language ? "selected" : ""}>${esc(value)}</option>`).join("")}</select></label><button id="refresh" ${busy ? "disabled" : ""}>Refresh</button></header>
      <p class="muted">${esc(connection.name)} · ${esc(site.name)} · Read-only components and immediate datasource references</p>
      <main aria-live="polite" aria-busy="${busy}">${body}</main>
      <script nonce="${nonce}">const api=acquireVsCodeApi();document.getElementById("refresh").onclick=()=>api.postMessage({type:"load",language:document.getElementById("language").value});
      document.getElementById("language").onchange=e=>api.postMessage({type:"load",language:e.target.value});
      document.querySelectorAll("[data-datasource]").forEach(button=>button.onclick=()=>api.postMessage({type:"openDatasource",key:button.dataset.datasource,revision:${revision}}));</script></body></html>`;
    };
    const load = async (): Promise<void> => {
      request?.abort();
      request = new AbortController();
      const current = ++revision;
      targets.clear();
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
        if (disposed || current !== revision) return;
        if (!validConnection()) throw Error("Connection changed.");
        const collectTargets = (placeholders: readonly ComponentPlaceholder[]): void => {
          for (const placeholder of placeholders) for (const component of placeholder.components) {
            const resolved = datasources.get(component.datasource);
            if (resolved?.itemId) targets.set(component.key, resolved.itemId);
            collectTargets(component.placeholders);
          }
        };
        collectTargets(tree.placeholders);
        panel.webview.html = html(`<p class="muted">${tree.count} component occurrence(s). Requested locale: ${esc(tree.requestedLanguage)}. Source locale: unknown.</p>
          <details class="info"><summary>Layout context</summary><p>Returned locale/version: ${esc(tree.returnedLanguage)} / ${tree.returnedVersion}</p>
          <p>Device: ${esc(tree.device)}</p><p>Preview is effective content. Returned locale/version is not proof of a local editable version.
          Custom resolver and reference-graph coverage is not established. Datasources below are references, not verified writable targets.</p></details>${renderComponentTree(tree, datasources)}`, false);
      } catch {
        if (disposed || current !== revision || request.signal.aborted || this.lifetime.signal.aborted) return;
        panel.webview.html = html("<p>Components unavailable. Check the CM Preview token and site route. The response must match this page and language and fit the layout limits (500 components, 20 levels). No partial tree is shown.</p>", false);
      }
    };
    const listener = panel.webview.onDidReceiveMessage((message: unknown) => {
      if (!message || typeof message !== "object" || disposed) return;
      const value = message as Record<string, unknown>;
      if (value.type === "openDatasource") {
        if (value.revision !== revision || typeof value.key !== "string" || !validConnection()) return;
        const datasourceId = targets.get(value.key);
        if (datasourceId && this.openDatasource) void this.openDatasource(connection.id, datasourceId, language)
          .catch(() => vscode.window.showErrorMessage("Unable to open datasource. Check its connection and requested language."));
        return;
      }
      if (value.type !== "load" || typeof value.language !== "string" || !languages.includes(value.language)) return;
      language = value.language;
      void load();
    });
    panel.onDidDispose(() => { disposed = true; request?.abort(); listener.dispose(); this.panels.delete(panel); });
    await load();
  }
}
