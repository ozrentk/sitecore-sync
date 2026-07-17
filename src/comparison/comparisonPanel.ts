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
const traversalConcurrencyPerSide = 2;

type TreeSide = "left" | "right";

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
  readonly leftItemId?: unknown;
  readonly rightItemId?: unknown;
  readonly leftRefreshPlan?: unknown;
  readonly rightRefreshPlan?: unknown;
}

interface RefreshPlanEntry {
  readonly itemId: string;
  readonly path: string;
  readonly depth: number;
}

interface TraversalEntry {
  readonly locator: AuthoringItemLocator;
  readonly requestedItemId?: string;
}

export class ComparisonPanelManager implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private panelDisposables: vscode.Disposable[] = [];
  private readonly disposables: vscode.Disposable[] = [];
  private readonly treeLevelCache = new Map<string, AuthoringTreeLevel>();
  private readonly pendingTreeLevels = new Map<string, Promise<AuthoringTreeLevel>>();
  private readonly requestControllers = new Set<AbortController>();
  private readonly subtreeLoadControllers = new Map<string, AbortController>();
  private readonly pendingSubtreeConfirmations = new Set<string>();

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
      this.cancelSubtreeLoads();
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
      this.cancelSubtreeLoads();
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
      return;
    }

    if (message.type === "loadSubtree" && typeof message.rowKey === "string") {
      await this.confirmAndLoadSubtree(
        message.rowKey,
        typeof message.leftItemId === "string" ? message.leftItemId : undefined,
        typeof message.rightItemId === "string" ? message.rightItemId : undefined,
      );
      return;
    }

    if (message.type === "cancelSubtreeLoad" && typeof message.rowKey === "string") {
      this.cancelSubtreeLoad(message.rowKey);
    }
  }

  private async confirmAndLoadSubtree(
    rowKey: string,
    leftItemId: string | undefined,
    rightItemId: string | undefined,
  ): Promise<void> {
    if (
      this.pendingSubtreeConfirmations.has(rowKey) ||
      this.subtreeLoadControllers.has(rowKey)
    ) {
      return;
    }

    this.pendingSubtreeConfirmations.add(rowKey);
    try {
      const selection = await vscode.window.showWarningMessage(
        "Expand All will load every descendant beneath this item from XM Cloud. Large subtrees may affect VS Code performance. Do you want to continue?",
        { modal: true },
        "Expand All",
      );
      if (selection === "Expand All") {
        await this.loadSubtree(rowKey, leftItemId, rightItemId);
      }
    } finally {
      this.pendingSubtreeConfirmations.delete(rowKey);
    }
  }

  private async loadSubtree(
    rowKey: string,
    leftItemId: string | undefined,
    rightItemId: string | undefined,
  ): Promise<void> {
    if (
      !this.panel ||
      this.subtreeLoadControllers.has(rowKey) ||
      (!leftItemId && !rightItemId)
    ) {
      return;
    }

    const selection = this.getSelection();
    const sides = [
      {
        side: "left" as const,
        connectionId: selection.leftConnectionId,
        itemId: leftItemId,
      },
      {
        side: "right" as const,
        connectionId: selection.rightConnectionId,
        itemId: rightItemId,
      },
    ].filter(
      (entry): entry is { side: TreeSide; connectionId: string; itemId: string } =>
        Boolean(entry.connectionId && entry.itemId),
    );
    if (!sides.length) {
      return;
    }

    const controller = new AbortController();
    this.subtreeLoadControllers.set(rowKey, controller);
    await this.panel.webview.postMessage({ type: "subtreeLoadStarted", rowKey });
    this.log.info(`Loading complete comparison subtree ${rowKey}.`);

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Loading XM Cloud comparison subtree",
          cancellable: true,
        },
        async (progress, token) => {
          const cancellation = token.onCancellationRequested(() =>
            controller.abort(new DOMException("Subtree loading was cancelled.", "AbortError")),
          );
          let loadedLevels = 0;
          const reportLevel = async (): Promise<void> => {
            loadedLevels += 1;
            progress.report({ message: `${loadedLevels} item level(s) loaded` });
            await this.panel?.webview.postMessage({
              type: "subtreeLoadProgress",
              rowKey,
              loadedLevels,
            });
          };

          try {
            const sideLoads = sides.map(({ side, connectionId, itemId }) =>
              this.loadSideRecursively(
                side,
                connectionId,
                { locator: { itemId }, requestedItemId: itemId },
                controller.signal,
                reportLevel,
                async (depth) => {
                  await this.panel?.webview.postMessage({
                    type: "subtreeLoadDepthLoaded",
                    rowKey,
                    side,
                    depth,
                  });
                },
              ),
            );
            await waitForTraversalSides(sideLoads, controller);
          } finally {
            cancellation.dispose();
          }
        },
      );
      this.log.info(`Finished loading complete comparison subtree ${rowKey}.`);
      await this.panel?.webview.postMessage({ type: "subtreeLoadFinished", rowKey });
    } catch (error: unknown) {
      const cancelled = isAbortError(error);
      if (!controller.signal.aborted) {
        controller.abort(error);
      }
      if (cancelled) {
        this.log.info(`Comparison subtree loading was cancelled for ${rowKey}.`);
      } else {
        this.log.error(`Comparison subtree loading failed for ${rowKey}.`, error);
        await vscode.window.showErrorMessage(
          `Unable to load the complete comparison subtree: ${errorMessage(error)}`,
        );
      }
      await this.panel?.webview.postMessage({
        type: "subtreeLoadFinished",
        rowKey,
        cancelled,
      });
    } finally {
      if (this.subtreeLoadControllers.get(rowKey) === controller) {
        this.subtreeLoadControllers.delete(rowKey);
      }
    }
  }

  private async loadSideRecursively(
    side: TreeSide,
    connectionId: string,
    initialEntry: TraversalEntry,
    signal: AbortSignal,
    reportLevel: () => Promise<void>,
    reportDepth: (depth: number) => Promise<void>,
  ): Promise<void> {
    let depth = 0;
    let frontier: readonly TraversalEntry[] = [initialEntry];
    const queuedItemIds = new Set<string>();
    if (initialEntry.requestedItemId) {
      queuedItemIds.add(normalizeItemId(initialEntry.requestedItemId));
    }

    while (frontier.length) {
      throwIfAborted(signal);
      const levels = await mapWithConcurrency(
        frontier,
        traversalConcurrencyPerSide,
        async (entry) => {
          const level = await this.loadAndPostTreeLevel(
            side,
            connectionId,
            entry.locator,
            entry.requestedItemId,
            signal,
          );
          await reportLevel();
          return level;
        },
      );

      const nextFrontier: TraversalEntry[] = [];
      for (const level of levels) {
        queuedItemIds.add(normalizeItemId(level.item.itemId));
        for (const child of level.children) {
          const normalizedId = normalizeItemId(child.itemId);
          if (!child.hasChildren || queuedItemIds.has(normalizedId)) {
            continue;
          }
          queuedItemIds.add(normalizedId);
          nextFrontier.push({
            locator: { itemId: child.itemId },
            requestedItemId: child.itemId,
          });
        }
      }
      await reportDepth(depth);
      depth += 1;
      frontier = nextFrontier;
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
    this.cancelSubtreeLoads();
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
    side: TreeSide,
    connectionId: string,
    locator: AuthoringItemLocator,
    requestedItemId?: string,
  ): Promise<void> {
    try {
      await this.loadAndPostTreeLevel(side, connectionId, locator, requestedItemId);
    } catch {
      // loadAndPostTreeLevel already reports non-cancellation failures inline.
    }
  }

  private async loadAndPostTreeLevel(
    side: TreeSide,
    connectionId: string,
    locator: AuthoringItemLocator,
    requestedItemId?: string,
    cancellationSignal?: AbortSignal,
  ): Promise<AuthoringTreeLevel> {
    if (cancellationSignal) {
      throwIfAborted(cancellationSignal);
    }
    if (!this.panel || !this.isCurrentConnection(side, connectionId)) {
      throw new DOMException("The comparison selection changed.", "AbortError");
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
      const level = await this.getTreeLevel(connectionId, locator, cancellationSignal);
      if (cancellationSignal) {
        throwIfAborted(cancellationSignal);
      }
      if (!this.panel || !this.isCurrentConnection(side, connectionId)) {
        throw new DOMException("The comparison selection changed.", "AbortError");
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
      return level;
    } catch (error: unknown) {
      if (!isAbortError(error) && !cancellationSignal?.aborted) {
        await this.reportTreeLoadFailure(
          side,
          connectionId,
          locator,
          requestedItemId,
          error,
        );
      }
      throw error;
    }
  }

  private async reportTreeLoadFailure(
    side: TreeSide,
    connectionId: string,
    locator: AuthoringItemLocator,
    requestedItemId: string | undefined,
    error: unknown,
  ): Promise<void> {
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

  private async getTreeLevel(
    connectionId: string,
    locator: AuthoringItemLocator,
    cancellationSignal?: AbortSignal,
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
      return cancellationSignal
        ? awaitWithCancellation(pending, cancellationSignal)
        : pending;
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
    const cancellationHandler = (): void =>
      controller.abort(cancellationSignal?.reason ?? new DOMException("Cancelled.", "AbortError"));
    if (cancellationSignal?.aborted) {
      cancellationHandler();
    } else {
      cancellationSignal?.addEventListener("abort", cancellationHandler, { once: true });
    }
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
        cancellationSignal?.removeEventListener("abort", cancellationHandler);
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
    this.cancelSubtreeLoads();
    for (const controller of this.requestControllers) {
      controller.abort();
    }
    this.requestControllers.clear();
    this.pendingTreeLevels.clear();
  }

  private cancelSubtreeLoad(rowKey: string): void {
    this.subtreeLoadControllers.get(rowKey)?.abort(
      new DOMException("Subtree loading was cancelled.", "AbortError"),
    );
  }

  private cancelSubtreeLoads(): void {
    for (const controller of this.subtreeLoadControllers.values()) {
      controller.abort(new DOMException("Subtree loading was cancelled.", "AbortError"));
    }
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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new DOMException("The operation was cancelled.", "AbortError");
  }
}

function normalizeItemId(itemId: string): string {
  return itemId.replace(/[{}-]/g, "").toLowerCase();
}

async function mapWithConcurrency<TInput, TOutput>(
  values: readonly TInput[],
  concurrency: number,
  mapper: (value: TInput) => Promise<TOutput>,
): Promise<readonly TOutput[]> {
  const results = new Array<TOutput>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(values[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

async function waitForTraversalSides(
  sideLoads: readonly Promise<void>[],
  controller: AbortController,
): Promise<void> {
  const guardedLoads = sideLoads.map(async (load) => {
    try {
      await load;
    } catch (error: unknown) {
      if (!controller.signal.aborted) {
        controller.abort(error);
      }
      throw error;
    }
  });
  const results = await Promise.allSettled(guardedLoads);
  const failures = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  const failure = failures.find((result) => !isAbortError(result.reason)) ?? failures[0];
  if (failure) {
    throw failure.reason;
  }
}

function awaitWithCancellation<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const cancellationHandler = (): void => {
      signal.removeEventListener("abort", cancellationHandler);
      reject(signal.reason ?? new DOMException("The operation was cancelled.", "AbortError"));
    };
    signal.addEventListener("abort", cancellationHandler, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", cancellationHandler);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", cancellationHandler);
        reject(error);
      },
    );
  });
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
