import * as vscode from "vscode";
import type { ConnectionStore } from "../connections/connectionStore";
import {
  AuthoringContentClient,
  type AuthoringItemLocator,
  type AuthoringTreeLevel,
} from "../sitecore/authoringClient";

const selectionKey = "sitecoreXmCloudSync.comparisonSelection.v1";
const defaultLanguage = "en";
const authoringRootPath = "/sitecore";

interface ComparisonSelection {
  readonly leftConnectionId?: string;
  readonly rightConnectionId?: string;
}

interface WebviewMessage {
  readonly type?: unknown;
  readonly side?: unknown;
  readonly connectionId?: unknown;
  readonly itemId?: unknown;
  readonly rowKey?: unknown;
  readonly leftRefreshPlan?: unknown;
  readonly rightRefreshPlan?: unknown;
}

interface RefreshPlanEntry {
  readonly itemId: string;
  readonly path: string;
  readonly depth: number;
}

export class ComparisonPanelManager implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private panelDisposables: vscode.Disposable[] = [];
  private readonly disposables: vscode.Disposable[] = [];
  private readonly treeLevelCache = new Map<string, AuthoringTreeLevel>();
  private readonly pendingTreeLevels = new Map<string, Promise<AuthoringTreeLevel>>();
  private readonly requestControllers = new Set<AbortController>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly workspaceState: vscode.Memento,
    private readonly connectionStore: ConnectionStore,
    private readonly authoringClient: AuthoringContentClient,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.disposables.push(
      connectionStore.onDidChange(() => {
        void this.refreshStateAndTrees();
      }),
    );
  }

  async open(): Promise<void> {
    if (this.panel) {
      this.log.debug("Revealing the existing comparison tab.");
      this.panel.reveal(vscode.ViewColumn.Active);
      return;
    }

    this.log.info("Opening the comparison tab.");

    const comparisonMediaUri = vscode.Uri.joinPath(this.extensionUri, "media", "comparison");
    const panel = vscode.window.createWebviewPanel(
      "xmCloudSync.comparison",
      "XM Cloud Comparison",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [comparisonMediaUri],
      },
    );

    this.panel = panel;
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, "media", "sitecore-xm-cloud-sync.svg");
    this.panelDisposables = [
      panel.onDidDispose(() => {
        this.cancelRequests();
        this.disposePanelSubscriptions();
        this.panel = undefined;
      }),
      panel.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
        await this.handleMessage(message);
      }),
    ];

    try {
      panel.webview.html = await this.loadHtml(panel.webview, comparisonMediaUri);
    } catch (error: unknown) {
      panel.dispose();
      const message = error instanceof Error ? error.message : "Unknown error";
      await vscode.window.showErrorMessage(`Unable to open XM Cloud comparison: ${message}`);
    }
  }

  async openWith(leftConnectionId: string, rightConnectionId: string): Promise<void> {
    const selection = this.normalizeSelection({ leftConnectionId, rightConnectionId });
    await this.saveSelection(selection);
    await this.open();
    await this.postState();
    await this.loadInitialTrees();
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    if (message.type === "ready") {
      await this.postState();
      await this.loadInitialTrees();
      return;
    }

    if (message.type === "addConnection") {
      await vscode.commands.executeCommand("xmCloudSync.addConnection");
      return;
    }

    if (message.type === "swapConnections") {
      const selection = this.getSelection();
      await this.saveSelection({
        leftConnectionId: selection.rightConnectionId,
        rightConnectionId: selection.leftConnectionId,
      });
      await this.postState();
      await this.loadInitialTrees();
      return;
    }

    if (
      message.type === "selectConnection" &&
      (message.side === "left" || message.side === "right") &&
      typeof message.connectionId === "string"
    ) {
      const connectionId = this.connectionStore.get(message.connectionId)?.id;
      const selection = this.getSelection();
      await this.saveSelection(this.normalizeSelection({
        ...selection,
        ...(message.side === "left"
          ? { leftConnectionId: connectionId }
          : { rightConnectionId: connectionId }),
      }, message.side));
      await this.postState();
      await this.loadInitialTrees();
      return;
    }

    if (
      message.type === "loadRoot" &&
      (message.side === "left" || message.side === "right") &&
      typeof message.connectionId === "string"
    ) {
      await this.loadTreeLevel(
        message.side,
        message.connectionId,
        { path: authoringRootPath },
      );
      return;
    }

    if (
      message.type === "loadChildren" &&
      (message.side === "left" || message.side === "right") &&
      typeof message.connectionId === "string" &&
      typeof message.itemId === "string"
    ) {
      await this.loadTreeLevel(
        message.side,
        message.connectionId,
        { itemId: message.itemId },
        message.itemId,
      );
      return;
    }

    if (message.type === "refreshSubtree" && typeof message.rowKey === "string") {
      await this.refreshSubtree(
        message.rowKey,
        parseRefreshPlan(message.leftRefreshPlan),
        parseRefreshPlan(message.rightRefreshPlan),
      );
    }
  }

  private async refreshSubtree(
    rowKey: string,
    leftPlan: readonly RefreshPlanEntry[],
    rightPlan: readonly RefreshPlanEntry[],
  ): Promise<void> {
    if (!this.panel) {
      return;
    }
    if (!leftPlan.length && !rightPlan.length) {
      await this.panel.webview.postMessage({ type: "subtreeRefreshFinished", rowKey });
      return;
    }

    const selection = this.getSelection();
    const sides = [
      { side: "left" as const, connectionId: selection.leftConnectionId, plan: leftPlan },
      { side: "right" as const, connectionId: selection.rightConnectionId, plan: rightPlan },
    ].filter(
      (entry): entry is {
        readonly side: "left" | "right";
        readonly connectionId: string;
        readonly plan: readonly RefreshPlanEntry[];
      } => Boolean(entry.connectionId && entry.plan.length),
    );
    if (!sides.length) {
      await this.panel.webview.postMessage({ type: "subtreeRefreshFinished", rowKey });
      return;
    }

    for (const { connectionId, plan } of sides) {
      for (const entry of plan) {
        this.treeLevelCache.delete(this.treeCacheKey(connectionId, { itemId: entry.itemId }));
        this.treeLevelCache.delete(this.treeCacheKey(connectionId, { path: entry.path }));
      }
    }

    this.log.info(
      `Refreshing comparison subtree ${rowKey} (${leftPlan.length} left level(s), ${rightPlan.length} right level(s)).`,
    );

    try {
      const maximumDepth = Math.max(
        ...sides.flatMap(({ plan }) => plan.map((entry) => entry.depth)),
      );
      for (let depth = 0; depth <= maximumDepth; depth += 1) {
        const requests: Promise<void>[] = [];
        for (const { side, connectionId, plan } of sides) {
          for (const entry of plan.filter((candidate) => candidate.depth === depth)) {
            requests.push(
              this.loadTreeLevel(
                side,
                connectionId,
                { itemId: entry.itemId },
                entry.itemId,
              ),
            );
          }
        }
        await Promise.all(requests);
      }
      this.log.info(`Finished refreshing comparison subtree ${rowKey}.`);
    } finally {
      await this.panel?.webview.postMessage({ type: "subtreeRefreshFinished", rowKey });
    }
  }

  private async refreshStateAndTrees(): Promise<void> {
    await this.postState();
    await this.loadInitialTrees();
  }

  private async loadInitialTrees(): Promise<void> {
    if (!this.panel || this.connectionStore.list().length < 2) {
      return;
    }

    const selection = this.getSelection();
    const requests: Promise<void>[] = [];
    if (selection.leftConnectionId) {
      requests.push(
        this.loadTreeLevel(
          "left",
          selection.leftConnectionId,
          { path: authoringRootPath },
        ),
      );
    }
    if (selection.rightConnectionId) {
      requests.push(
        this.loadTreeLevel(
          "right",
          selection.rightConnectionId,
          { path: authoringRootPath },
        ),
      );
    }
    await Promise.all(requests);
  }

  private async loadTreeLevel(
    side: "left" | "right",
    connectionId: string,
    locator: AuthoringItemLocator,
    requestedItemId?: string,
  ): Promise<void> {
    if (!this.panel || !this.isCurrentConnection(side, connectionId)) {
      return;
    }

    await this.panel.webview.postMessage({
      type: "treeLoading",
      side,
      connectionId,
      requestedItemId,
    });
    this.log.debug(
      `Loading ${side} tree level for connection ${connectionId} (${locatorDescription(locator)}).`,
    );

    try {
      const level = await this.getTreeLevel(connectionId, locator);
      if (!this.panel || !this.isCurrentConnection(side, connectionId)) {
        return;
      }
      await this.panel.webview.postMessage({
        type: "treeLoaded",
        side,
        connectionId,
        requestedItemId,
        level,
      });
      this.log.info(
        `Loaded ${side} tree level ${level.item.path} with ${level.children.length} direct child item(s).`,
      );
    } catch (error: unknown) {
      if (!this.panel || !this.isCurrentConnection(side, connectionId)) {
        return;
      }
      await this.panel.webview.postMessage({
        type: "treeLoadFailed",
        side,
        connectionId,
        requestedItemId,
        message: errorMessage(error),
      });
      this.log.error(
        `Failed to load ${side} tree level for connection ${connectionId} (${locatorDescription(locator)}).`,
        error,
      );
    }
  }

  private async getTreeLevel(
    connectionId: string,
    locator: AuthoringItemLocator,
  ): Promise<AuthoringTreeLevel> {
    const cacheKey = this.treeCacheKey(connectionId, locator);
    const cached = this.treeLevelCache.get(cacheKey);
    if (cached) {
      this.log.trace(`Tree cache hit: ${cacheKey}.`);
      return cached;
    }

    const pending = this.pendingTreeLevels.get(cacheKey);
    if (pending) {
      this.log.trace(`Reusing pending tree request: ${cacheKey}.`);
      return pending;
    }
    this.log.trace(`Tree cache miss: ${cacheKey}.`);

    const connection = this.connectionStore.get(connectionId);
    if (!connection) {
      throw new Error("The XM Cloud connection no longer exists.");
    }
    const clientSecret = await this.connectionStore.getClientSecret(connectionId);
    if (!clientSecret) {
      throw new Error("The connection's client secret is missing.");
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("Content-tree loading timed out.")),
      30_000,
    );
    this.requestControllers.add(controller);
    let request: Promise<AuthoringTreeLevel>;
    request = this.authoringClient
      .loadTreeLevel(connection, clientSecret, locator, defaultLanguage, controller.signal)
      .then((level) => {
        this.treeLevelCache.set(cacheKey, level);
        return level;
      })
      .finally(() => {
        clearTimeout(timeout);
        if (this.pendingTreeLevels.get(cacheKey) === request) {
          this.pendingTreeLevels.delete(cacheKey);
        }
        this.requestControllers.delete(controller);
      });
    this.pendingTreeLevels.set(cacheKey, request);
    return request;
  }

  private treeCacheKey(connectionId: string, locator: AuthoringItemLocator): string {
    const locatorKey = "path" in locator ? `path:${locator.path}` : `id:${locator.itemId}`;
    return `${connectionId}:${defaultLanguage}:${locatorKey}`;
  }

  private isCurrentConnection(side: "left" | "right", connectionId: string): boolean {
    const selection = this.getSelection();
    return side === "left"
      ? selection.leftConnectionId === connectionId
      : selection.rightConnectionId === connectionId;
  }

  private getSelection(): ComparisonSelection {
    const stored = this.workspaceState.get<ComparisonSelection>(selectionKey, {});
    return this.normalizeSelection(stored);
  }

  private normalizeSelection(
    selection: ComparisonSelection,
    changedSide?: "left" | "right",
  ): ComparisonSelection {
    const connectionIds = this.connectionStore.list().map((connection) => connection.id);
    const validIds = new Set(connectionIds);
    let leftConnectionId: string | undefined =
      selection.leftConnectionId && validIds.has(selection.leftConnectionId)
        ? selection.leftConnectionId
        : connectionIds[0];
    let rightConnectionId: string | undefined =
      selection.rightConnectionId && validIds.has(selection.rightConnectionId)
        ? selection.rightConnectionId
        : connectionIds.find((id) => id !== leftConnectionId);

    if (leftConnectionId === rightConnectionId) {
      if (changedSide === "left") {
        rightConnectionId = connectionIds.find((id) => id !== leftConnectionId);
      } else {
        leftConnectionId = connectionIds.find((id) => id !== rightConnectionId);
      }
    }

    return { leftConnectionId, rightConnectionId };
  }

  private async saveSelection(selection: ComparisonSelection): Promise<void> {
    await this.workspaceState.update(selectionKey, selection);
  }

  private async postState(): Promise<void> {
    if (!this.panel) {
      return;
    }

    const connections = this.connectionStore.list().map((connection) => ({
      id: connection.id,
      name: connection.name,
      serverUrl: connection.serverUrl,
    }));

    await this.panel.webview.postMessage({
      type: "stateChanged",
      connections,
      selection: this.getSelection(),
    });
  }

  private async loadHtml(
    webview: vscode.Webview,
    comparisonMediaUri: vscode.Uri,
  ): Promise<string> {
    const templateUri = vscode.Uri.joinPath(comparisonMediaUri, "comparison.html");
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(comparisonMediaUri, "comparison.css"));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(comparisonMediaUri, "comparison.js"));
    const templateBytes = await vscode.workspace.fs.readFile(templateUri);
    const template = new TextDecoder("utf-8").decode(templateBytes);

    return template
      .replaceAll("{{cspSource}}", webview.cspSource)
      .replaceAll("{{styleUri}}", styleUri.toString())
      .replaceAll("{{scriptUri}}", scriptUri.toString());
  }

  private disposePanelSubscriptions(): void {
    for (const disposable of this.panelDisposables) {
      disposable.dispose();
    }
    this.panelDisposables = [];
  }

  private cancelRequests(): void {
    for (const controller of this.requestControllers) {
      controller.abort();
    }
    this.requestControllers.clear();
    this.pendingTreeLevels.clear();
  }

  dispose(): void {
    this.cancelRequests();
    this.treeLevelCache.clear();
    this.panel?.dispose();
    this.disposePanelSubscriptions();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return "Content-tree loading was cancelled.";
    }
    return error.message;
  }
  return "An unknown error occurred while loading the content tree.";
}

function locatorDescription(locator: AuthoringItemLocator): string {
  return "path" in locator ? `path ${locator.path}` : `item ${locator.itemId}`;
}

function parseRefreshPlan(value: unknown): readonly RefreshPlanEntry[] {
  if (!Array.isArray(value) || value.length > 5_000) {
    return [];
  }

  const entries: RefreshPlanEntry[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") {
      return [];
    }
    const entry = candidate as Partial<RefreshPlanEntry>;
    if (
      typeof entry.itemId !== "string" ||
      typeof entry.path !== "string" ||
      typeof entry.depth !== "number" ||
      !Number.isInteger(entry.depth) ||
      entry.depth < 0 ||
      entry.depth > 1_000
    ) {
      return [];
    }
    entries.push({ itemId: entry.itemId, path: entry.path, depth: entry.depth });
  }
  return entries;
}
