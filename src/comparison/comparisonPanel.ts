import * as vscode from "vscode";
import type { ConnectionStore } from "../connections/connectionStore";
import {
  AuthoringContentClient,
  type AuthoringItemDetails,
  type AuthoringItemIconReference,
  type AuthoringItemLocator,
  type AuthoringLanguage,
  type AuthoringTreeItem,
  type AuthoringTreeLevel,
} from "../sitecore/authoringClient";
import { resolveSitecoreIconUrl } from "../sitecore/itemIcon";
import {
  FieldDiffViewProvider,
  fieldDiffViewId,
  type FieldDiffSelection,
} from "./fieldDiffView";
import type { TransferQueueStore } from "../transfers/transferQueueStore";
import {
  fieldStateFingerprint,
  normalizeTransferId,
  subtreeTransferModeLabel,
  type SubtreeTransferMode,
  type SubtreeTransferPreflight,
  type TransferRecord,
} from "../transfers/transferTypes";
import {
  ItemTaskRunner,
  type ItemTaskCandidateContext,
} from "../tasks/itemTaskRunner";
import type { PublishingManager } from "../publishing/publishingManager";
import {
  availableLanguage,
  languageLockCandidates,
  lockedLanguagePair,
  preferredLanguage,
  sameLanguage,
  type LanguageLockCandidate,
} from "./languageLock";

const selectionKey = "sitecoreXmCloudSync.comparisonSelection.v1";
const fieldTransferConfirmationKey = "sitecoreXmCloudSync.fieldTransferConfirmationAccepted.v1";
const subtreeTransferModeKey = "sitecoreXmCloudSync.subtreeTransferMode.v1";
const defaultLanguage = "en";
const authoringRootPath = "/sitecore";
const traversalConcurrencyPerSide = 2;
const itemIconFieldId = "06d5295ced2f4a54b92f26228d113318";
const itemIconLoadConcurrency = 4;
const maximumItemIconReferences = 4_096;
const maximumItemIconImages = 256;
const favoriteRevealTimeoutMs = 5_000;

type TreeSide = "left" | "right";

interface ComparisonSelection {
  readonly leftConnectionId?: string;
  readonly rightConnectionId?: string;
  readonly leftLanguage: string;
  readonly rightLanguage: string;
  readonly languagesLocked: boolean;
}

interface WebviewMessage {
  readonly type?: unknown;
  readonly side?: unknown;
  readonly connectionId?: unknown;
  readonly itemId?: unknown;
  readonly path?: unknown;
  readonly rowKey?: unknown;
  readonly leftItemId?: unknown;
  readonly rightItemId?: unknown;
  readonly leftRefreshPlan?: unknown;
  readonly rightRefreshPlan?: unknown;
  readonly language?: unknown;
  readonly locked?: unknown;
  readonly fieldId?: unknown;
  readonly leftName?: unknown;
  readonly rightName?: unknown;
  readonly direction?: unknown;
  readonly sourceItemId?: unknown;
  readonly sourcePath?: unknown;
  readonly targetRefreshPlan?: unknown;
  readonly requestId?: unknown;
  readonly navigationId?: unknown;
  readonly found?: unknown;
  readonly leftPath?: unknown;
  readonly rightPath?: unknown;
  readonly leftDisplayName?: unknown;
  readonly rightDisplayName?: unknown;
  readonly leftHasChildren?: unknown;
  readonly rightHasChildren?: unknown;
}

interface FavoriteNavigation {
  readonly source: "favorite" | "site";
  readonly navigationId: number;
  readonly connectionId: string;
  readonly path: string;
  readonly side: TreeSide;
}

interface RefreshPlanEntry {
  readonly itemId: string;
  readonly path: string;
  readonly depth: number;
  readonly loadLevel: boolean;
}

interface TraversalEntry {
  readonly locator: AuthoringItemLocator;
  readonly requestedItemId?: string;
}

interface SubtreeTransferModeQuickPickItem extends vscode.QuickPickItem {
  readonly mode: SubtreeTransferMode;
}

interface LanguageLockQuickPickItem extends vscode.QuickPickItem {
  readonly candidate: LanguageLockCandidate;
}

interface CachedItemIcon {
  readonly iconKey: string;
  readonly dataUri: string;
}

class FieldDiffContentProvider implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  private nextDocumentId = 1;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? "";
  }

  create(value: string, label: string): vscode.Uri {
    const safeLabel = label.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "field";
    const uri = vscode.Uri.from({
      scheme: "xm-cloud-sync-field",
      path: `/${this.nextDocumentId}-${safeLabel}.txt`,
    });
    this.nextDocumentId += 1;
    this.contents.set(uri.toString(), value);
    return uri;
  }
}

export class ComparisonPanelManager implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private panelDisposables: vscode.Disposable[] = [];
  private readonly disposables: vscode.Disposable[] = [];
  private readonly treeLevelCache = new Map<string, AuthoringTreeLevel>();
  private readonly pendingTreeLevels = new Map<string, Promise<AuthoringTreeLevel>>();
  private readonly languageCache = new Map<string, readonly AuthoringLanguage[]>();
  private readonly pendingLanguages = new Map<string, Promise<readonly AuthoringLanguage[]>>();
  private readonly itemDetailsCache = new Map<string, AuthoringItemDetails>();
  private readonly pendingItemDetails = new Map<string, Promise<AuthoringItemDetails>>();
  private readonly itemIconReferenceCache = new Map<string, string | undefined>();
  private readonly pendingItemIconReferences = new Map<string, Promise<string | undefined>>();
  private readonly itemIconCache = new Map<string, CachedItemIcon | undefined>();
  private readonly pendingItemIcons = new Map<string, Promise<CachedItemIcon | undefined>>();
  private readonly itemIconLoadWaiters: Array<() => void> = [];
  private readonly requestControllers = new Set<AbortController>();
  private readonly subtreeLoadControllers = new Map<string, AbortController>();
  private readonly pendingSubtreeConfirmations = new Set<string>();
  private readonly copyingFieldIds = new Set<string>();
  private readonly fieldDiffProvider = new FieldDiffContentProvider();
  private readonly comparisonStateEmitter = new vscode.EventEmitter<void>();
  private readonly pendingFavoriteReveal = new Map<string, (found: boolean) => void>();
  private connectionSignature: string;
  private nextFavoriteRevealId = 1;
  private favoriteNavigationGeneration = 0;
  private nextItemIconKey = 1;
  private activeItemIconLoads = 0;
  private itemIconGeneration = 0;
  private pendingFavoriteNavigation: FavoriteNavigation | undefined;
  private selectedFieldDiffItem: FieldDiffSelection | undefined;
  private selectionChangeQueue: Promise<void> = Promise.resolve();
  private warnedInvalidLanguageLock: string | undefined;
  readonly onDidChangeComparisonState = this.comparisonStateEmitter.event;
  readonly fieldDiffViewProvider: FieldDiffViewProvider;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly workspaceState: vscode.Memento,
    private readonly globalState: vscode.Memento,
    private readonly connectionStore: ConnectionStore,
    private readonly authoringClient: AuthoringContentClient,
    private readonly transferQueue: TransferQueueStore,
    private readonly itemTaskRunner: ItemTaskRunner,
    private readonly publishingManager: PublishingManager,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.connectionSignature = this.currentConnectionSignature();
    this.fieldDiffViewProvider = new FieldDiffViewProvider(
      extensionUri,
      () => {
        void this.refreshFieldDiffView();
      },
      async (fieldId) => {
        await this.openSelectedFieldDiff(fieldId);
      },
      async (fieldId, direction) => {
        await this.copySelectedFieldValue(fieldId, direction);
      },
      async (side, itemId) => await this.copySelectedItemId(side, itemId),
    );
    this.disposables.push(
      this.fieldDiffViewProvider,
      vscode.workspace.registerTextDocumentContentProvider(
        "xm-cloud-sync-field",
        this.fieldDiffProvider,
      ),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("xmCloudSync.textNormalization")) {
          void this.postState();
          void this.refreshFieldDiffView();
        }
      }),
      connectionStore.onDidChange(() => {
        const signature = this.currentConnectionSignature();
        if (signature !== this.connectionSignature) {
          this.connectionSignature = signature;
          void this.refreshStateAndTrees();
        }
      }),
    );
  }

  async handleTransferStarted(record: TransferRecord): Promise<void> {
    if (record.kind !== "subtree") {
      return;
    }
    await this.panel?.webview.postMessage({
      type: "syncStarted",
      rowKey: record.comparisonRowKey,
      targetItemIds: record.targetRefreshPlan.map((entry) => entry.itemId),
    });
  }

  async handleTransferCompleted(record: TransferRecord): Promise<void> {
    if (record.kind === "subtree") {
      const selection = this.getSelection();
      const selectedTargetConnectionId = record.targetSide === "left"
        ? selection.leftConnectionId
        : selection.rightConnectionId;
      const selectedTargetLanguage = record.targetSide === "left"
        ? selection.leftLanguage
        : selection.rightLanguage;
      if (
        selectedTargetConnectionId === record.targetConnectionId &&
        selectedTargetLanguage === record.targetLanguage
      ) {
        await this.refreshSubtree(
          record.comparisonRowKey,
          record.targetSide === "left" ? record.targetRefreshPlan : [],
          record.targetSide === "right" ? record.targetRefreshPlan : [],
        );
      }
      await this.panel?.webview.postMessage({
        type: "syncFinished",
        rowKey: record.comparisonRowKey,
      });
      return;
    }

    const selection = this.getSelection();
    const targetSide: TreeSide = record.direction === "leftToRight" ? "right" : "left";
    const selectedConnectionId = targetSide === "left"
      ? selection.leftConnectionId
      : selection.rightConnectionId;
    const selectedLanguage = targetSide === "left"
      ? selection.leftLanguage
      : selection.rightLanguage;
    if (
      selectedConnectionId !== record.target.connectionId ||
      selectedLanguage !== record.target.language
    ) {
      return;
    }
    this.invalidateItemDetails(
      record.target.connectionId,
      record.target.language,
      record.target.itemId,
    );
    await this.loadAndPostItemDetails(
      targetSide,
      record.target.connectionId,
      record.target.itemId,
    );
    if (normalizeItemId(record.target.fieldId) === itemIconFieldId) {
      this.invalidateItemIcon(record.target.connectionId, record.target.itemId);
      await this.loadAndPostItemIcons(
        targetSide,
        record.target.connectionId,
        record.target.language,
        [record.target.itemId],
      );
    }
    await this.refreshFieldDiffView();
  }

  async handleTransferFailed(record: TransferRecord): Promise<void> {
    if (record.kind === "subtree") {
      await this.panel?.webview.postMessage({
        type: "syncFinished",
        rowKey: record.comparisonRowKey,
      });
    }
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
    this.comparisonStateEmitter.fire();
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, "media", "sitecore-xm-cloud-sync.svg");
    this.panelDisposables = [
      panel.onDidDispose(() => {
        this.cancelRequests();
        this.disposePanelSubscriptions();
        this.panel = undefined;
        this.comparisonStateEmitter.fire();
      }),
      panel.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
        if (this.isSelectionMessage(message)) {
          await this.enqueueSelectionChange(async () => await this.handleMessage(message));
        } else {
          await this.handleMessage(message);
        }
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
    const current = this.getSelection();
    const requested = this.normalizeSelection({
      leftConnectionId,
      rightConnectionId,
      leftLanguage: current.languagesLocked ? current.leftLanguage : defaultLanguage,
      rightLanguage: current.languagesLocked ? current.rightLanguage : defaultLanguage,
      languagesLocked: current.languagesLocked,
    });
    const selection = await this.prepareConnectionPairSelection(requested, "Unlock and Open");
    if (!selection) {
      return;
    }
    await this.saveSelection(selection);
    await this.open();
    await this.postState();
    await this.loadInitialTrees();
  }

  async openSite(connectionId: string, path: string): Promise<void> {
    await this.openConnectionPath(connectionId, path, "site");
  }

  async openFavorite(connectionId: string, path: string): Promise<void> {
    await this.openConnectionPath(connectionId, path, "favorite");
  }

  private async openConnectionPath(
    connectionId: string,
    path: string,
    source: "favorite" | "site",
  ): Promise<void> {
    if (!this.connectionStore.get(connectionId)) {
      await vscode.window.showErrorMessage(`The ${source}'s XM Cloud connection no longer exists.`);
      return;
    }
    if (!this.panel) {
      await vscode.window.showWarningMessage(
        source === "site"
          ? "Open a comparison and select this site's connection before navigating to its root item."
          : "Open a comparison before navigating to a favorite. You can also right-click the favorite and choose Compare with…",
      );
      return;
    }

    const selection = this.getSelection();
    const side: TreeSide | undefined = selection.leftConnectionId === connectionId
      ? "left"
      : selection.rightConnectionId === connectionId
        ? "right"
        : undefined;
    if (!side) {
      await vscode.window.showWarningMessage(
        source === "site"
          ? "Select this site's connection in the current comparison before navigating to its root item."
          : `${this.connectionStore.get(connectionId)?.name ?? "The favorite's connection"} is not open in the current comparison. Right-click the favorite and choose Compare with… to open it explicitly.`,
      );
      return;
    }

    const navigation = this.beginFavoriteNavigation(connectionId, path, side, source);
    this.panel.reveal(vscode.ViewColumn.Active);
    await this.navigateToFavorite(navigation);
  }

  async openFavoriteWith(
    favoriteConnectionId: string,
    rightConnectionId: string,
    path: string,
  ): Promise<void> {
    const requested = this.normalizeSelection({
      ...this.getSelection(),
      leftConnectionId: favoriteConnectionId,
      rightConnectionId,
    });
    const selection = await this.prepareConnectionPairSelection(requested, "Unlock and Open");
    if (!selection) {
      return;
    }
    await this.saveSelection(selection);
    const navigation = this.beginFavoriteNavigation(favoriteConnectionId, path, "left");
    if (!this.panel) {
      this.pendingFavoriteNavigation = navigation;
      await this.open();
      return;
    }

    this.panel.reveal(vscode.ViewColumn.Active);
    await this.postState();
    await this.loadInitialTrees();
    await this.navigateToFavorite(navigation);
  }

  async refreshAll(): Promise<boolean> {
    if (!this.panel) {
      return false;
    }
    return this.panel.webview.postMessage({ type: "refreshAllRequested" });
  }

  isConnectionInOpenComparison(connectionId: string): boolean {
    if (!this.panel) {
      return false;
    }
    const selection = this.getSelection();
    return selection.leftConnectionId === connectionId || selection.rightConnectionId === connectionId;
  }

  private async prepareConnectionPairSelection(
    requested: ComparisonSelection,
    unlockAction: string,
  ): Promise<ComparisonSelection | undefined> {
    if (!requested.languagesLocked) {
      return requested;
    }
    if (!requested.leftConnectionId || !requested.rightConnectionId) {
      return undefined;
    }
    try {
      const [leftLanguages, rightLanguages] = await Promise.all([
        this.getLanguages(requested.leftConnectionId),
        this.getLanguages(requested.rightConnectionId),
      ]);
      const pair = lockedLanguagePair(requested.leftLanguage, leftLanguages, rightLanguages);
      if (pair) {
        return { ...requested, ...pair };
      }
      const leftFallback = preferredLanguage(leftLanguages);
      const rightFallback = preferredLanguage(rightLanguages);
      if (!leftFallback || !rightFallback) {
        await vscode.window.showWarningMessage(
          "The requested comparison cannot be opened because one of its connections exposes no configured content languages.",
        );
        return undefined;
      }
      const action = await vscode.window.showWarningMessage(
        `The requested connections do not both have the locked language "${requested.leftLanguage}".`,
        unlockAction,
      );
      return action === unlockAction
        ? {
            ...requested,
            leftLanguage: leftFallback,
            rightLanguage: rightFallback,
            languagesLocked: false,
          }
        : undefined;
    } catch (error: unknown) {
      await vscode.window.showErrorMessage(
        `Unable to verify the comparison languages: ${errorMessage(error)}`,
      );
      return undefined;
    }
  }

  private isSelectionMessage(message: WebviewMessage): boolean {
    return message.type === "swapConnections" ||
      message.type === "selectConnection" ||
      message.type === "selectLanguage" ||
      message.type === "setLanguageLock";
  }

  private async enqueueSelectionChange(operation: () => Promise<void>): Promise<void> {
    const pending = this.selectionChangeQueue.then(operation, operation);
    this.selectionChangeQueue = pending.catch(() => undefined);
    await pending;
  }

  private async applySelection(selection: ComparisonSelection): Promise<void> {
    this.warnedInvalidLanguageLock = undefined;
    this.cancelSubtreeLoads();
    await this.clearFieldDiffSelection();
    await this.saveSelection(this.normalizeSelection(selection));
    await this.postState();
    await this.loadInitialTrees();
  }

  private async rejectSelectionChange(): Promise<void> {
    await this.postState();
  }

  private async handleLanguageSelection(side: TreeSide, requestedLanguage: string): Promise<void> {
    const selection = this.getSelection();
    const connectionId = side === "left"
      ? selection.leftConnectionId
      : selection.rightConnectionId;
    if (!connectionId) {
      await this.rejectSelectionChange();
      return;
    }

    try {
      const sideLanguages = await this.getLanguages(connectionId);
      const canonicalLanguage = availableLanguage(sideLanguages, requestedLanguage);
      if (!canonicalLanguage) {
        await this.rejectSelectionChange();
        await vscode.window.showWarningMessage(
          `The language "${requestedLanguage.trim()}" is not configured for ${this.connectionStore.get(connectionId)?.name ?? "the selected connection"}.`,
        );
        return;
      }

      if (!selection.languagesLocked) {
        await this.applySelection({
          ...selection,
          ...(side === "left"
            ? { leftLanguage: canonicalLanguage }
            : { rightLanguage: canonicalLanguage }),
        });
        return;
      }

      const otherSide: TreeSide = side === "left" ? "right" : "left";
      const otherConnectionId = otherSide === "left"
        ? selection.leftConnectionId
        : selection.rightConnectionId;
      if (!otherConnectionId) {
        await this.rejectSelectionChange();
        return;
      }
      const otherLanguages = await this.getLanguages(otherConnectionId);
      const otherLanguage = availableLanguage(otherLanguages, canonicalLanguage);
      if (otherLanguage) {
        await this.applySelection({
          ...selection,
          leftLanguage: side === "left" ? canonicalLanguage : otherLanguage,
          rightLanguage: side === "right" ? canonicalLanguage : otherLanguage,
        });
        return;
      }

      await this.rejectSelectionChange();
      const action = await vscode.window.showWarningMessage(
        `The language "${canonicalLanguage}" is not configured for ${this.connectionStore.get(otherConnectionId)?.name ?? `the ${otherSide} connection`}.`,
        "Unlock and Select",
      );
      if (action === "Unlock and Select") {
        await this.applySelection({
          ...selection,
          languagesLocked: false,
          ...(side === "left"
            ? { leftLanguage: canonicalLanguage }
            : { rightLanguage: canonicalLanguage }),
        });
      }
    } catch (error: unknown) {
      await vscode.window.showErrorMessage(
        `Unable to verify the selected language: ${errorMessage(error)}`,
      );
      await this.rejectSelectionChange();
    }
  }

  private async handleConnectionSelection(side: TreeSide, requestedConnectionId: string): Promise<void> {
    const connection = this.connectionStore.get(requestedConnectionId);
    if (!connection) {
      await this.rejectSelectionChange();
      return;
    }
    const selection = this.getSelection();
    if (!selection.languagesLocked) {
      await this.applySelection(this.normalizeSelection({
        ...selection,
        ...(side === "left"
          ? { leftConnectionId: connection.id }
          : { rightConnectionId: connection.id }),
      }));
      return;
    }

    const nextSelection = this.normalizeSelection({
      ...selection,
      ...(side === "left"
        ? { leftConnectionId: connection.id }
        : { rightConnectionId: connection.id }),
    });
    if (!nextSelection.leftConnectionId || !nextSelection.rightConnectionId) {
      await this.rejectSelectionChange();
      return;
    }

    try {
      const [leftLanguages, rightLanguages] = await Promise.all([
        this.getLanguages(nextSelection.leftConnectionId),
        this.getLanguages(nextSelection.rightConnectionId),
      ]);
      const pair = lockedLanguagePair(selection.leftLanguage, leftLanguages, rightLanguages);
      if (pair) {
        await this.applySelection({ ...nextSelection, ...pair, languagesLocked: true });
        return;
      }

      const newConnectionLanguages = side === "left" ? leftLanguages : rightLanguages;
      const fallbackLanguage = preferredLanguage(newConnectionLanguages);
      if (!fallbackLanguage) {
        await this.rejectSelectionChange();
        await vscode.window.showWarningMessage(
          `${connection.name} does not expose any configured content languages, so it cannot be selected.`,
        );
        return;
      }
      await this.rejectSelectionChange();
      const action = await vscode.window.showWarningMessage(
        `${connection.name} does not have the locked language "${selection.leftLanguage}".`,
        "Unlock and Switch",
      );
      if (action === "Unlock and Switch") {
        await this.applySelection({
          ...nextSelection,
          languagesLocked: false,
          ...(side === "left"
            ? { leftLanguage: fallbackLanguage }
            : { rightLanguage: fallbackLanguage }),
        });
      }
    } catch (error: unknown) {
      await vscode.window.showErrorMessage(
        `Unable to verify the new connection's languages: ${errorMessage(error)}`,
      );
      await this.rejectSelectionChange();
    }
  }

  private async handleLanguageLockChange(locked: boolean): Promise<void> {
    const selection = this.getSelection();
    if (locked === selection.languagesLocked) {
      await this.rejectSelectionChange();
      return;
    }

    if (!locked) {
      let leftLanguage = selection.leftLanguage;
      let rightLanguage = selection.rightLanguage;
      try {
        if (selection.leftConnectionId) {
          const languages = await this.getLanguages(selection.leftConnectionId);
          leftLanguage = availableLanguage(languages, leftLanguage) ??
            preferredLanguage(languages) ?? leftLanguage;
        }
        if (selection.rightConnectionId) {
          const languages = await this.getLanguages(selection.rightConnectionId);
          rightLanguage = availableLanguage(languages, rightLanguage) ??
            preferredLanguage(languages) ?? rightLanguage;
        }
      } catch {
        // Unlocking must remain available even when language discovery is temporarily unavailable.
      }
      await this.applySelection({
        ...selection,
        leftLanguage,
        rightLanguage,
        languagesLocked: false,
      });
      return;
    }

    if (!selection.leftConnectionId || !selection.rightConnectionId) {
      await vscode.window.showWarningMessage(
        "Choose connections on both sides before locking languages.",
      );
      await this.rejectSelectionChange();
      return;
    }

    try {
      const [leftLanguages, rightLanguages] = await Promise.all([
        this.getLanguages(selection.leftConnectionId),
        this.getLanguages(selection.rightConnectionId),
      ]);
      if (sameLanguage(selection.leftLanguage, selection.rightLanguage)) {
        const pair = lockedLanguagePair(selection.leftLanguage, leftLanguages, rightLanguages);
        if (pair) {
          await this.applySelection({ ...selection, ...pair, languagesLocked: true });
          return;
        }
      }

      const candidates = languageLockCandidates(
        selection.leftLanguage,
        selection.rightLanguage,
        leftLanguages,
        rightLanguages,
      );
      if (!candidates.length) {
        await this.rejectSelectionChange();
        await vscode.window.showWarningMessage(
          "Neither selected language is configured on both connections. Choose a shared language before locking.",
        );
        return;
      }

      await this.rejectSelectionChange();
      const picked = await vscode.window.showQuickPick<LanguageLockQuickPickItem>(
        candidates.map((candidate) => ({
          label: `Use ${candidate.language}`,
          description: `Currently selected on the ${candidate.source} side`,
          candidate,
        })),
        {
          title: "Lock comparison languages",
          placeHolder: "Choose which current language to use on both sides",
          ignoreFocusOut: true,
        },
      );
      if (!picked) {
        return;
      }
      await this.applySelection({
        ...selection,
        leftLanguage: picked.candidate.leftLanguage,
        rightLanguage: picked.candidate.rightLanguage,
        languagesLocked: true,
      });
    } catch (error: unknown) {
      await vscode.window.showErrorMessage(
        `Unable to lock comparison languages: ${errorMessage(error)}`,
      );
      await this.rejectSelectionChange();
    }
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    if (message.type === "ready") {
      await this.postState();
      await this.loadInitialTrees();
      const navigation = this.pendingFavoriteNavigation;
      this.pendingFavoriteNavigation = undefined;
      if (navigation) {
        await this.navigateToFavorite(navigation);
      }
      return;
    }

    if (
      message.type === "favoriteRevealResult" &&
      typeof message.requestId === "string" &&
      Number.isSafeInteger(message.navigationId) &&
      message.navigationId === this.favoriteNavigationGeneration &&
      typeof message.found === "boolean"
    ) {
      this.pendingFavoriteReveal.get(message.requestId)?.(message.found);
      return;
    }

    if (
      message.type === "addFavorite" &&
      (typeof message.leftPath === "string" || typeof message.rightPath === "string")
    ) {
      await this.addFavoriteFromRow(
        typeof message.leftPath === "string" ? message.leftPath : undefined,
        typeof message.rightPath === "string" ? message.rightPath : undefined,
      );
      return;
    }

    if (message.type === "addConnection") {
      await vscode.commands.executeCommand("xmCloudSync.addConnection");
      return;
    }

    if (message.type === "swapConnections") {
      const selection = this.getSelection();
      await this.applySelection({
        ...selection,
        leftConnectionId: selection.rightConnectionId,
        rightConnectionId: selection.leftConnectionId,
        leftLanguage: selection.rightLanguage,
        rightLanguage: selection.leftLanguage,
      });
      return;
    }

    if (
      message.type === "selectConnection" &&
      (message.side === "left" || message.side === "right") &&
      typeof message.connectionId === "string"
    ) {
      await this.handleConnectionSelection(message.side, message.connectionId);
      return;
    }

    if (
      message.type === "selectLanguage" &&
      (message.side === "left" || message.side === "right") &&
      typeof message.language === "string" &&
      message.language.trim()
    ) {
      await this.handleLanguageSelection(message.side, message.language);
      return;
    }

    if (message.type === "setLanguageLock" && typeof message.locked === "boolean") {
      await this.handleLanguageLockChange(message.locked);
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

    if (
      message.type === "loadItemDetails" &&
      (message.side === "left" || message.side === "right") &&
      typeof message.connectionId === "string" &&
      typeof message.itemId === "string"
    ) {
      await this.loadAndPostItemDetails(message.side, message.connectionId, message.itemId);
      return;
    }

    if (
      message.type === "openFieldDiff" &&
      typeof message.leftItemId === "string" &&
      typeof message.rightItemId === "string" &&
      typeof message.fieldId === "string"
    ) {
      try {
        await this.openFieldDiff(message.leftItemId, message.rightItemId, message.fieldId);
      } catch (error: unknown) {
        await vscode.window.showErrorMessage(`Unable to open field diff: ${errorMessage(error)}`);
      }
      return;
    }

    if (
      (message.type === "selectFieldDiffItem" || message.type === "showDetailedFieldDiff") &&
      (typeof message.leftItemId === "string" || typeof message.rightItemId === "string")
    ) {
      if (message.type === "selectFieldDiffItem" && !this.fieldDiffViewProvider.visible) {
        return;
      }
      this.selectedFieldDiffItem = {
        leftItemId: typeof message.leftItemId === "string" ? message.leftItemId : undefined,
        rightItemId: typeof message.rightItemId === "string" ? message.rightItemId : undefined,
        leftName: typeof message.leftName === "string" ? message.leftName : undefined,
        rightName: typeof message.rightName === "string" ? message.rightName : undefined,
      };
      if (message.type === "showDetailedFieldDiff") {
        await vscode.commands.executeCommand(`${fieldDiffViewId}.focus`);
      }
      await this.refreshFieldDiffView();
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

    if (
      message.type === "refreshItem" &&
      typeof message.rowKey === "string" &&
      (typeof message.leftItemId === "string" || typeof message.rightItemId === "string")
    ) {
      await this.refreshItem(
        message.rowKey,
        typeof message.leftItemId === "string" ? message.leftItemId : undefined,
        typeof message.rightItemId === "string" ? message.rightItemId : undefined,
      );
      return;
    }

    if (
      message.type === "refreshAll" &&
      typeof message.rowKey === "string" &&
      (typeof message.leftItemId === "string" || typeof message.rightItemId === "string")
    ) {
      await this.confirmAndRefreshAll(
        message.rowKey,
        typeof message.leftItemId === "string" ? message.leftItemId : undefined,
        typeof message.rightItemId === "string" ? message.rightItemId : undefined,
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
      return;
    }

    if (
      message.type === "runItemTask" &&
      (typeof message.leftItemId === "string" || typeof message.rightItemId === "string")
    ) {
      await this.runItemTask(message);
      return;
    }

    if (
      (message.type === "standardPublish" ||
        message.type === "tracedPublish" ||
        message.type === "powerPublish") &&
      (message.side === "left" || message.side === "right") &&
      typeof message.itemId === "string" &&
      typeof message.path === "string"
    ) {
      const selection = this.getSelection();
      const connectionId = message.side === "left"
        ? selection.leftConnectionId
        : selection.rightConnectionId;
      const language = message.side === "left"
        ? selection.leftLanguage
        : selection.rightLanguage;
      if (!connectionId) {
        await vscode.window.showErrorMessage("The selected comparison side has no connection.");
        return;
      }
      await this.publishingManager.start(
        message.type === "standardPublish"
          ? "standard"
          : message.type === "tracedPublish"
            ? "traced"
            : "power",
        {
          connectionId,
          side: message.side,
          itemId: message.itemId,
          path: message.path,
          language,
        },
      );
      return;
    }

    if (
      message.type === "syncSubtree" &&
      typeof message.rowKey === "string" &&
      (message.direction === "leftToRight" || message.direction === "rightToLeft") &&
      typeof message.sourceItemId === "string" &&
      typeof message.sourcePath === "string"
    ) {
      await this.syncSubtree(
        message.rowKey,
        message.direction,
        message.sourceItemId,
        message.sourcePath,
        parseRefreshPlan(message.targetRefreshPlan),
      );
    }
  }

  private async runItemTask(message: WebviewMessage): Promise<void> {
    const selection = this.getSelection();
    const requestedSide = message.side === "left" || message.side === "right"
      ? message.side
      : undefined;
    const candidates: ItemTaskCandidateContext[] = [];
    const inputs = [
      {
        side: "left" as const,
        itemId: typeof message.leftItemId === "string" ? message.leftItemId : undefined,
        name: typeof message.leftName === "string" ? message.leftName : undefined,
        displayName: typeof message.leftDisplayName === "string"
          ? message.leftDisplayName
          : undefined,
        hasChildren: message.leftHasChildren === true,
        connectionId: selection.leftConnectionId,
        language: selection.leftLanguage,
      },
      {
        side: "right" as const,
        itemId: typeof message.rightItemId === "string" ? message.rightItemId : undefined,
        name: typeof message.rightName === "string" ? message.rightName : undefined,
        displayName: typeof message.rightDisplayName === "string"
          ? message.rightDisplayName
          : undefined,
        hasChildren: message.rightHasChildren === true,
        connectionId: selection.rightConnectionId,
        language: selection.rightLanguage,
      },
    ].filter((input) => !requestedSide || input.side === requestedSide);
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Loading item context for tasks",
          cancellable: false,
        },
        async () => {
          const availableInputs = inputs.filter((input): input is typeof input & {
            readonly itemId: string;
            readonly connectionId: string;
          } => Boolean(input.itemId && input.connectionId));
          const results = await Promise.allSettled(availableInputs.map(async (input) => {
            const connection = this.connectionStore.get(input.connectionId);
            if (!connection) {
              throw new Error(`The ${input.side} connection no longer exists.`);
            }
            const details = await this.getItemDetails(input.connectionId, input.language, input.itemId);
            const fallbackName = details.path.split("/").filter(Boolean).at(-1) ?? details.path;
            return {
              side: input.side,
              connection: {
                id: connection.id,
                name: connection.name,
                serverUrl: connection.serverUrl,
              },
              language: input.language,
              item: {
                ...details,
                name: input.name ?? fallbackName,
                displayName: input.displayName ?? input.name ?? fallbackName,
                hasChildren: input.hasChildren,
              },
            } satisfies ItemTaskCandidateContext;
          }));
          for (const result of results) {
            if (result.status === "fulfilled") {
              candidates.push(result.value);
            } else {
              this.log.warn(`Could not load one item-task context: ${errorMessage(result.reason)}`);
            }
          }
        },
      );
      if (candidates.length === 0) {
        throw new Error("Item details could not be loaded for either comparison side.");
      }
      await this.itemTaskRunner.selectAndRun(candidates);
    } catch (error: unknown) {
      await vscode.window.showErrorMessage(
        `Unable to prepare the item task: ${errorMessage(error)}`,
      );
    }
  }

  private async syncSubtree(
    rowKey: string,
    direction: "leftToRight" | "rightToLeft",
    sourceItemId: string,
    sourcePath: string,
    targetRefreshPlan: readonly RefreshPlanEntry[],
  ): Promise<void> {
    if (!this.panel) {
      return;
    }
    const selection = this.getSelection();
    const sourceSide: TreeSide = direction === "leftToRight" ? "left" : "right";
    const targetSide: TreeSide = direction === "leftToRight" ? "right" : "left";
    const sourceConnectionId = sourceSide === "left"
      ? selection.leftConnectionId
      : selection.rightConnectionId;
    const targetConnectionId = targetSide === "left"
      ? selection.leftConnectionId
      : selection.rightConnectionId;
    const sourceConnection = sourceConnectionId
      ? this.connectionStore.get(sourceConnectionId)
      : undefined;
    const targetConnection = targetConnectionId
      ? this.connectionStore.get(targetConnectionId)
      : undefined;
    if (!sourceConnection || !targetConnection) {
      await vscode.window.showErrorMessage("Both comparison connections are required for transfer.");
      return;
    }
    if (sourcePath.replace(/\/$/u, "").toLowerCase() === authoringRootPath) {
      await vscode.window.showInformationMessage(
        "The complete /sitecore root cannot be synchronized as one subtree.",
      );
      return;
    }
    if (sourceConnection.serverUrl === targetConnection.serverUrl) {
      await vscode.window.showInformationMessage(
        "Subtree transfer is unavailable when both sides use the same XM Cloud environment.",
      );
      return;
    }

    const mode = await this.pickSubtreeTransferMode();
    if (!mode) {
      return;
    }
    await this.globalState.update(subtreeTransferModeKey, mode);

    let preflight: SubtreeTransferPreflight;
    try {
      preflight = await this.preflightSubtreeTransfer(
        sourceConnection.id,
        targetConnection.id,
        sourceItemId,
        sourcePath,
        this.sideLanguage(sourceSide),
        this.sideLanguage(targetSide),
        mode,
      );
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        await vscode.window.showErrorMessage(
          `Unable to prepare the subtree transfer: ${errorMessage(error)}`,
        );
      }
      return;
    }

    const confirmation = subtreeTransferConfirmation(mode, sourcePath, preflight);
    const confirmed = await vscode.window.showWarningMessage(
      confirmation.message,
      { modal: true, detail: confirmation.detail },
      confirmation.action,
    );
    if (confirmed !== confirmation.action) {
      return;
    }
    const duplicateKey = [
      "subtree",
      sourceConnection.id,
      targetConnection.id,
      normalizeTransferId(sourceItemId),
      sourcePath.toLowerCase(),
    ].join(":");
    const queued = await this.transferQueue.enqueue({
      kind: "subtree",
      mode,
      intent: {
        kind: "subtree",
        source: {
          connectionId: sourceConnection.id,
          rootItemId: sourceItemId,
          rootPath: sourcePath,
        },
        destination: { connectionId: targetConnection.id },
        mode,
      },
      preflight,
      duplicateKey,
      direction,
      sourceConnectionId: sourceConnection.id,
      sourceConnectionName: sourceConnection.name,
      targetConnectionId: targetConnection.id,
      targetConnectionName: targetConnection.name,
      sourceItemId,
      sourcePath,
      sourceLanguage: this.sideLanguage(sourceSide),
      targetLanguage: this.sideLanguage(targetSide),
      comparisonRowKey: rowKey,
      targetSide,
      targetRefreshPlan,
    });
    await vscode.window.showInformationMessage(queued.added
      ? `Added ${subtreeTransferModeLabel(mode).toLowerCase()} transfer for ${sourcePath}.`
      : `${sourcePath} is already queued for this destination.`);
  }

  private async pickSubtreeTransferMode(): Promise<SubtreeTransferMode | undefined> {
    const remembered = this.globalState.get<SubtreeTransferMode>(
      subtreeTransferModeKey,
      "synchronize",
    );
    const modes: readonly SubtreeTransferModeQuickPickItem[] = [
      {
        mode: "addMissing",
        label: "$(add) Add missing content",
        description: "Keep existing target items",
        detail: "Adds source items that do not exist at the target; nothing is deleted.",
      },
      {
        mode: "synchronize",
        label: "$(sync) Synchronize from source",
        description: "Add and update",
        detail: "Adds missing items and replaces matching target items; target-only items remain.",
      },
      {
        mode: "exactMirror",
        label: "$(replace-all) Exact mirror",
        description: "Add, update, and remove",
        detail: "Replaces the target subtree and deletes target-only items.",
      },
    ];
    const ordered = [
      ...modes.filter((item) => item.mode === remembered).map((item) => ({
        ...item,
        description: `${item.description} · last used`,
      })),
      ...modes.filter((item) => item.mode !== remembered),
    ];
    return (await vscode.window.showQuickPick(ordered, {
      title: "Choose subtree transfer type",
      placeHolder: "How should the target subtree be handled?",
      matchOnDescription: true,
      matchOnDetail: true,
    }))?.mode;
  }

  private async preflightSubtreeTransfer(
    sourceConnectionId: string,
    targetConnectionId: string,
    expectedSourceItemId: string,
    sourcePath: string,
    sourceLanguage: string,
    targetLanguage: string,
    mode: SubtreeTransferMode,
  ): Promise<SubtreeTransferPreflight> {
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Checking ${itemNameFromPath(sourcePath)} before transfer`,
        cancellable: true,
      },
      async (progress, cancellationToken) => {
        const controller = new AbortController();
        const cancellation = cancellationToken.onCancellationRequested(() =>
          controller.abort(new DOMException("Cancelled.", "AbortError")));
        let inspectedLevels = 0;
        const report = (): void => {
          inspectedLevels += 1;
          progress.report({ message: `${inspectedLevels} tree level(s) checked` });
        };
        try {
          const destinationParentPath = sourcePath.slice(0, sourcePath.lastIndexOf("/"));
          const [sourceRoot, targetParent] = await Promise.all([
            this.getTreeLevel(
              sourceConnectionId,
              sourceLanguage,
              { path: sourcePath },
              controller.signal,
            ),
            this.getTreeLevel(
              targetConnectionId,
              targetLanguage,
              { path: destinationParentPath },
              controller.signal,
            ),
          ]);
          if (
            normalizeItemId(sourceRoot.item.itemId) !==
            normalizeItemId(expectedSourceItemId)
          ) {
            throw new Error(
              `${sourcePath} now resolves to item ${sourceRoot.item.itemId}. Refresh the comparison and try again.`,
            );
          }
          const targetRootItem = targetParent.children.find(
            (item) => normalizedPath(item.path) === normalizedPath(sourcePath),
          );
          if (
            targetRootItem &&
            mode !== "exactMirror" &&
            normalizeItemId(targetRootItem.itemId) !== normalizeItemId(sourceRoot.item.itemId)
          ) {
            throw new Error(
              `The target path already exists with a different item ID (${targetRootItem.itemId}). ` +
              "Choose Exact mirror to replace it.",
            );
          }

          const [sourceItems, targetItems] = await Promise.all([
            this.collectSubtreeInventory(
              sourceConnectionId,
              sourceLanguage,
              sourceRoot,
              controller.signal,
              report,
            ),
            targetRootItem
              ? this.getTreeLevel(
                  targetConnectionId,
                  targetLanguage,
                  { itemId: targetRootItem.itemId },
                  controller.signal,
                ).then((targetRoot) => this.collectSubtreeInventory(
                  targetConnectionId,
                  targetLanguage,
                  targetRoot,
                  controller.signal,
                  report,
                ))
              : Promise.resolve(new Map<string, AuthoringTreeItem>()),
          ]);

          const targetPaths = new Map(
            [...targetItems.values()].map((item) => [
              normalizedPath(item.path),
              normalizeItemId(item.itemId),
            ]),
          );
          if (mode !== "exactMirror") {
            for (const sourceItem of sourceItems.values()) {
              const targetId = targetPaths.get(normalizedPath(sourceItem.path));
              if (targetId && targetId !== normalizeItemId(sourceItem.itemId)) {
                throw new Error(
                  `The target path ${sourceItem.path} exists with a different item ID. ` +
                  "Choose Exact mirror to replace it.",
                );
              }
            }
          }

          const sourceIds = new Set(sourceItems.keys());
          const targetIds = new Set(targetItems.keys());
          const commonItems = [...sourceIds].filter((id) => targetIds.has(id)).length;
          return {
            sourceItems: sourceIds.size,
            targetItems: targetIds.size,
            addItems: sourceIds.size - commonItems,
            updateItems: mode === "addMissing" ? 0 : commonItems,
            removeItems: mode === "exactMirror" ? targetIds.size - commonItems : 0,
          };
        } finally {
          cancellation.dispose();
        }
      },
    );
  }

  private async collectSubtreeInventory(
    connectionId: string,
    language: string,
    root: AuthoringTreeLevel,
    signal: AbortSignal,
    reportLevel: () => void,
  ): Promise<Map<string, AuthoringTreeItem>> {
    const items = new Map<string, AuthoringTreeItem>();
    const addLevel = (level: AuthoringTreeLevel): readonly AuthoringTreeItem[] => {
      items.set(normalizeItemId(level.item.itemId), level.item);
      for (const child of level.children) {
        items.set(normalizeItemId(child.itemId), child);
      }
      reportLevel();
      return level.children.filter((child) => child.hasChildren);
    };
    let frontier = [...addLevel(root)];
    while (frontier.length) {
      throwIfAborted(signal);
      const levels = await mapWithConcurrency(
        frontier,
        traversalConcurrencyPerSide,
        (item) => this.getTreeLevel(
          connectionId,
          language,
          { itemId: item.itemId },
          signal,
        ),
      );
      frontier = levels.flatMap((level) => [...addLevel(level)]);
    }
    return items;
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

  private async confirmAndRefreshAll(
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
        "Refresh All will re-read every item and field beneath the configured root on both sides. Large trees may take time and affect VS Code performance. Do you want to continue?",
        { modal: true },
        "Refresh All",
      );
      if (selection !== "Refresh All") {
        return;
      }

      this.cancelRequests();
      this.treeLevelCache.clear();
      this.itemDetailsCache.clear();
      this.clearItemIconCaches();
      await this.panel?.webview.postMessage({ type: "itemIconsReset" });
      await this.loadSubtree(rowKey, leftItemId, rightItemId, "refreshAll");
    } finally {
      this.pendingSubtreeConfirmations.delete(rowKey);
    }
  }

  private async loadSubtree(
    rowKey: string,
    leftItemId: string | undefined,
    rightItemId: string | undefined,
    operation: "expand" | "refreshAll" = "expand",
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
    const refreshingAll = operation === "refreshAll";
    this.log.info(
      refreshingAll
        ? `Refreshing the complete comparison ${rowKey}.`
        : `Loading complete comparison subtree ${rowKey}.`,
    );

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: refreshingAll
            ? "Refreshing all XM Cloud comparison data"
            : "Loading XM Cloud comparison subtree",
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
      if (refreshingAll) {
        await this.refreshFieldDiffView();
      }
      this.log.info(
        refreshingAll
          ? `Finished refreshing the complete comparison ${rowKey}.`
          : `Finished loading complete comparison subtree ${rowKey}.`,
      );
      await this.panel?.webview.postMessage({ type: "subtreeLoadFinished", rowKey });
    } catch (error: unknown) {
      const cancelled = isAbortError(error);
      if (!controller.signal.aborted) {
        controller.abort(error);
      }
      if (cancelled) {
        this.log.info(
          refreshingAll
            ? `Complete comparison refresh was cancelled for ${rowKey}.`
            : `Comparison subtree loading was cancelled for ${rowKey}.`,
        );
      } else {
        this.log.error(
          refreshingAll
            ? `Complete comparison refresh failed for ${rowKey}.`
            : `Comparison subtree loading failed for ${rowKey}.`,
          error,
        );
        await vscode.window.showErrorMessage(
          refreshingAll
            ? `Unable to refresh all comparison data: ${errorMessage(error)}`
            : `Unable to load the complete comparison subtree: ${errorMessage(error)}`,
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

    for (const { side, connectionId, plan } of sides) {
      const language = this.sideLanguage(side);
      for (const entry of plan) {
        this.treeLevelCache.delete(
          this.treeCacheKey(connectionId, language, { itemId: entry.itemId }),
        );
        this.treeLevelCache.delete(
          this.treeCacheKey(connectionId, language, { path: entry.path }),
        );
        this.invalidateItemDetails(connectionId, language, entry.itemId);
        this.invalidateItemIcon(connectionId, entry.itemId);
      }
    }

    const fieldDiffRefresh = this.selectedFieldDiffItemMatchesPlans(leftPlan, rightPlan)
      ? this.refreshFieldDiffView()
      : Promise.resolve();

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
          for (const entry of plan.filter(
            (candidate) => candidate.depth === depth && candidate.loadLevel,
          )) {
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
      await fieldDiffRefresh;
      this.log.info(`Finished refreshing comparison subtree ${rowKey}.`);
    } finally {
      await this.panel?.webview.postMessage({ type: "subtreeRefreshFinished", rowKey });
    }
  }

  private async refreshItem(
    rowKey: string,
    leftItemId: string | undefined,
    rightItemId: string | undefined,
  ): Promise<void> {
    if (!this.panel) {
      return;
    }
    const selection = this.getSelection();
    const sides = [
      {
        side: "left" as const,
        connectionId: selection.leftConnectionId,
        language: selection.leftLanguage,
        itemId: leftItemId,
      },
      {
        side: "right" as const,
        connectionId: selection.rightConnectionId,
        language: selection.rightLanguage,
        itemId: rightItemId,
      },
    ].filter(
      (entry): entry is {
        readonly side: TreeSide;
        readonly connectionId: string;
        readonly language: string;
        readonly itemId: string;
      } => Boolean(entry.connectionId && entry.itemId),
    );

    this.log.info(`Refreshing comparison item ${rowKey}.`);
    for (const { connectionId, language, itemId } of sides) {
      this.invalidateItemDetails(connectionId, language, itemId);
      this.invalidateItemIcon(connectionId, itemId);
    }

    try {
      const requests = sides.flatMap(({ side, connectionId, language, itemId }) => [
        this.loadAndPostItemDetails(side, connectionId, itemId),
        this.loadAndPostItemIcons(side, connectionId, language, [itemId]),
      ]);
      if (this.selectedFieldDiffItemMatchesIds(leftItemId, rightItemId)) {
        requests.push(this.refreshFieldDiffView());
      }
      await Promise.all(requests);
      this.log.info(`Finished refreshing comparison item ${rowKey}.`);
    } finally {
      await this.panel?.webview.postMessage({ type: "itemRefreshFinished", rowKey });
    }
  }

  private invalidateItemDetails(
    connectionId: string,
    language: string,
    itemId: string,
  ): void {
    const cacheKey = this.itemDetailsCacheKey(connectionId, language, itemId);
    this.itemDetailsCache.delete(cacheKey);
    this.pendingItemDetails.delete(cacheKey);
  }

  private selectedFieldDiffItemMatchesPlans(
    leftPlan: readonly RefreshPlanEntry[],
    rightPlan: readonly RefreshPlanEntry[],
  ): boolean {
    const leftItemId = this.selectedFieldDiffItem?.leftItemId;
    const rightItemId = this.selectedFieldDiffItem?.rightItemId;
    return Boolean(
      (leftItemId && leftPlan.some(
          (entry) => normalizeItemId(entry.itemId) === normalizeItemId(leftItemId),
        )) ||
      (rightItemId && rightPlan.some(
        (entry) => normalizeItemId(entry.itemId) === normalizeItemId(rightItemId),
      )),
    );
  }

  private selectedFieldDiffItemMatchesIds(
    leftItemId: string | undefined,
    rightItemId: string | undefined,
  ): boolean {
    const selected = this.selectedFieldDiffItem;
    return Boolean(
      selected && (
        (selected.leftItemId && leftItemId &&
          normalizeItemId(selected.leftItemId) === normalizeItemId(leftItemId)) ||
        (selected.rightItemId && rightItemId &&
          normalizeItemId(selected.rightItemId) === normalizeItemId(rightItemId))
      ),
    );
  }

  private async refreshStateAndTrees(): Promise<void> {
    this.cancelRequests();
    this.clearItemIconCaches();
    await this.clearFieldDiffSelection();
    await this.postState();
    await this.panel?.webview.postMessage({ type: "itemIconsReset" });
    await this.loadInitialTrees();
  }

  private currentConnectionSignature(): string {
    return this.connectionStore.list()
      .map((connection) => `${connection.id}:${connection.serverUrl}`)
      .join("|");
  }

  private async addFavoriteFromRow(
    leftPath: string | undefined,
    rightPath: string | undefined,
  ): Promise<void> {
    const selection = this.getSelection();
    const candidates = [
      leftPath && selection.leftConnectionId
        ? { connectionId: selection.leftConnectionId, path: leftPath, side: "Left" }
        : undefined,
      rightPath && selection.rightConnectionId
        ? { connectionId: selection.rightConnectionId, path: rightPath, side: "Right" }
        : undefined,
    ].filter((candidate): candidate is {
      connectionId: string;
      path: string;
      side: string;
    } => Boolean(candidate));
    const uniqueCandidates = candidates.filter((candidate, index) =>
      candidates.findIndex((other) =>
        other.connectionId === candidate.connectionId &&
        other.path.localeCompare(candidate.path, undefined, { sensitivity: "base" }) === 0
      ) === index
    );
    if (!uniqueCandidates.length) {
      return;
    }

    let selected = uniqueCandidates;
    if (uniqueCandidates.length > 1) {
      const picked = await vscode.window.showQuickPick(
        uniqueCandidates.map((candidate) => ({
          label: this.connectionStore.get(candidate.connectionId)?.name ?? candidate.connectionId,
          description: candidate.side,
          detail: candidate.path,
          picked: true,
          candidate,
        })),
        {
          title: "Add item to connection favorites",
          placeHolder: "Select one or both connections",
          canPickMany: true,
        },
      );
      if (!picked?.length) {
        return;
      }
      selected = picked.map((item) => item.candidate);
    }

    let added = 0;
    for (const favorite of selected) {
      if (await this.connectionStore.addFavoritePath(favorite.connectionId, favorite.path)) {
        added += 1;
      }
    }
    await vscode.window.showInformationMessage(
      added
        ? `Added ${added === 1 ? "favorite" : `${added} favorites`}.`
        : "The selected item is already in Favorites.",
    );
  }

  private async navigateToFavorite(navigation: FavoriteNavigation): Promise<void> {
    if (!this.panel || !this.isCurrentFavoriteNavigation(navigation)) {
      return;
    }
    await this.panel.webview.postMessage({
      type: "favoriteNavigationStarted",
      navigationId: navigation.navigationId,
      side: navigation.side,
      path: navigation.path,
    });
    if (!this.panel || !this.isCurrentFavoriteNavigation(navigation)) {
      return;
    }
    if (await this.tryRevealFavorite(navigation)) {
      return;
    }
    if (!this.isCurrentFavoriteNavigation(navigation)) {
      return;
    }

    try {
      // Resolve the complete path first so a missing favorite does not disturb the loaded tree.
      await this.getTreeLevel(
        navigation.connectionId,
        this.sideLanguage(navigation.side),
        { path: navigation.path },
      );
      for (const ancestorPath of favoriteAncestorPaths(navigation.path)) {
        if (!this.panel || !this.isCurrentFavoriteNavigation(navigation)) {
          return;
        }
        await this.loadFavoriteLevel(
          navigation,
          navigation.side,
          navigation.connectionId,
          ancestorPath,
        );
        const otherSide: TreeSide = navigation.side === "left" ? "right" : "left";
        const selection = this.getSelection();
        const otherConnectionId = otherSide === "left"
          ? selection.leftConnectionId
          : selection.rightConnectionId;
        if (otherConnectionId) {
          try {
            await this.loadFavoriteLevel(navigation, otherSide, otherConnectionId, ancestorPath);
          } catch (error: unknown) {
            this.log.debug(
              `Favorite counterpart ${ancestorPath} is unavailable on the ${otherSide}: ${errorMessage(error)}`,
            );
          }
        }
      }
      const revealed = await this.tryRevealFavorite(navigation);
      if (!this.isCurrentFavoriteNavigation(navigation)) {
        return;
      }
      if (!revealed) {
        throw new Error("The item loaded, but it could not be revealed in the comparison tree.");
      }
    } catch (error: unknown) {
      if (!this.isCurrentFavoriteNavigation(navigation)) {
        return;
      }
      const message = errorMessage(error);
      this.log.warn(
        `Unable to open ${navigation.source} ${navigation.path} on connection ${navigation.connectionId}: ${message}`,
      );
      const connectionName = this.connectionStore.get(navigation.connectionId)?.name ?? "the connection";
      const notFound = message.includes(" was not found.");
      const choice = notFound && navigation.source === "favorite"
        ? await vscode.window.showErrorMessage(
            `Favorite path ${navigation.path} was not found on ${connectionName}.`,
            "Remove Favorite",
          )
        : await vscode.window.showErrorMessage(
            `Unable to open ${navigation.source} path ${navigation.path} on ${connectionName}: ${message}`,
          );
      if (choice === "Remove Favorite") {
        await this.connectionStore.removeFavoritePath(navigation.connectionId, navigation.path);
      }
    }
  }

  private async loadFavoriteLevel(
    navigation: FavoriteNavigation,
    side: TreeSide,
    connectionId: string,
    path: string,
  ): Promise<void> {
    if (!this.isCurrentFavoriteNavigation(navigation)) {
      return;
    }
    const language = this.sideLanguage(side);
    const level = await this.getTreeLevel(connectionId, language, { path });
    if (
      !this.panel ||
      !this.isCurrentFavoriteNavigation(navigation) ||
      !this.isCurrentSelection(side, connectionId, language)
    ) {
      return;
    }
    await this.panel.webview.postMessage({
      type: "treeLoaded",
      side,
      connectionId,
      language,
      requestedItemId: level.item.itemId,
      level,
    });
    void this.loadAndPostItemIcons(
      side,
      connectionId,
      language,
      [level.item, ...level.children].map((item) => item.itemId),
    );
  }

  private isCurrentFavoriteNavigation(navigation: FavoriteNavigation): boolean {
    if (navigation.navigationId !== this.favoriteNavigationGeneration) {
      return false;
    }
    const selection = this.getSelection();
    return navigation.side === "left"
      ? selection.leftConnectionId === navigation.connectionId
      : selection.rightConnectionId === navigation.connectionId;
  }

  private async tryRevealFavorite(navigation: FavoriteNavigation): Promise<boolean> {
    if (!this.panel || !this.isCurrentFavoriteNavigation(navigation)) {
      return false;
    }
    const requestId = `favorite-${this.nextFavoriteRevealId}`;
    this.nextFavoriteRevealId += 1;
    const result = new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingFavoriteReveal.delete(requestId);
        resolve(false);
      }, favoriteRevealTimeoutMs);
      this.pendingFavoriteReveal.set(requestId, (found) => {
        clearTimeout(timeout);
        this.pendingFavoriteReveal.delete(requestId);
        resolve(found);
      });
    });
    const posted = await this.panel.webview.postMessage({
      type: "tryRevealFavorite",
      requestId,
      navigationId: navigation.navigationId,
      path: navigation.path,
      side: navigation.side,
    });
    if (!posted) {
      this.pendingFavoriteReveal.get(requestId)?.(false);
    }
    return result;
  }

  private beginFavoriteNavigation(
    connectionId: string,
    path: string,
    side: TreeSide,
    source: "favorite" | "site" = "favorite",
  ): FavoriteNavigation {
    this.favoriteNavigationGeneration += 1;
    this.resolvePendingFavoriteReveals(false);
    return {
      navigationId: this.favoriteNavigationGeneration,
      source,
      connectionId,
      path,
      side,
    };
  }

  private resolvePendingFavoriteReveals(found: boolean): void {
    for (const resolve of this.pendingFavoriteReveal.values()) {
      resolve(found);
    }
    this.pendingFavoriteReveal.clear();
  }

  private async loadAndPostLanguages(side: TreeSide, connectionId: string): Promise<void> {
    if (!this.panel) {
      return;
    }
    await this.panel.webview.postMessage({ type: "languagesLoading", side, connectionId });
    try {
      const languages = await this.getLanguages(connectionId);
      if (!this.panel || !this.isCurrentSelection(side, connectionId, this.sideLanguage(side))) {
        return;
      }
      await this.panel.webview.postMessage({
        type: "languagesLoaded",
        side,
        connectionId,
        languages,
      });
    } catch (error: unknown) {
      if (this.panel) {
        await this.panel.webview.postMessage({
          type: "languagesLoadFailed",
          side,
          connectionId,
          message: errorMessage(error),
        });
      }
    }
  }

  private async getLanguages(connectionId: string): Promise<readonly AuthoringLanguage[]> {
    const cached = this.languageCache.get(connectionId);
    if (cached) {
      return cached;
    }
    const pending = this.pendingLanguages.get(connectionId);
    if (pending) {
      return pending;
    }
    const connection = this.connectionStore.get(connectionId);
    const clientSecret = await this.connectionStore.getClientSecret(connectionId);
    if (!connection || !clientSecret) {
      throw new Error("The XM Cloud connection or its secret is missing.");
    }
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("Language loading timed out.")),
      30_000,
    );
    this.requestControllers.add(controller);
    let request: Promise<readonly AuthoringLanguage[]>;
    request = this.authoringClient
      .loadLanguages(connection, clientSecret, controller.signal)
      .then((languages) => {
        this.languageCache.set(connectionId, languages);
        return languages;
      })
      .finally(() => {
        clearTimeout(timeout);
        if (this.pendingLanguages.get(connectionId) === request) {
          this.pendingLanguages.delete(connectionId);
        }
        this.requestControllers.delete(controller);
      });
    this.pendingLanguages.set(connectionId, request);
    return request;
  }

  private async loadAndPostItemDetails(
    side: TreeSide,
    connectionId: string,
    itemId: string,
  ): Promise<void> {
    const language = this.sideLanguage(side);
    if (!this.panel || !this.isCurrentSelection(side, connectionId, language)) {
      return;
    }
    await this.panel.webview.postMessage({
      type: "itemDetailsLoading",
      side,
      connectionId,
      language,
      itemId,
    });
    try {
      const details = await this.getItemDetails(connectionId, language, itemId);
      if (!this.panel || !this.isCurrentSelection(side, connectionId, language)) {
        return;
      }
      await this.panel.webview.postMessage({
        type: "itemDetailsLoaded",
        side,
        connectionId,
        language,
        itemId,
        details,
      });
    } catch (error: unknown) {
      if (this.panel && this.isCurrentSelection(side, connectionId, language)) {
        await this.panel.webview.postMessage({
          type: "itemDetailsLoadFailed",
          side,
          connectionId,
          language,
          itemId,
          message: errorMessage(error),
        });
      }
    }
  }

  private async getItemDetails(
    connectionId: string,
    language: string,
    itemId: string,
  ): Promise<AuthoringItemDetails> {
    const cacheKey = this.itemDetailsCacheKey(connectionId, language, itemId);
    const cached = this.itemDetailsCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const pending = this.pendingItemDetails.get(cacheKey);
    if (pending) {
      return pending;
    }
    const connection = this.connectionStore.get(connectionId);
    const clientSecret = await this.connectionStore.getClientSecret(connectionId);
    if (!connection || !clientSecret) {
      throw new Error("The XM Cloud connection or its secret is missing.");
    }
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("Item-detail loading timed out.")),
      30_000,
    );
    this.requestControllers.add(controller);
    let request: Promise<AuthoringItemDetails>;
    request = this.authoringClient
      .loadItemDetails(connection, clientSecret, itemId, language, controller.signal)
      .then((details) => {
        if (this.pendingItemDetails.get(cacheKey) === request) {
          this.itemDetailsCache.set(cacheKey, details);
        }
        return details;
      })
      .finally(() => {
        clearTimeout(timeout);
        if (this.pendingItemDetails.get(cacheKey) === request) {
          this.pendingItemDetails.delete(cacheKey);
        }
        this.requestControllers.delete(controller);
      });
    this.pendingItemDetails.set(cacheKey, request);
    return request;
  }

  private itemDetailsCacheKey(connectionId: string, language: string, itemId: string): string {
    return `${connectionId}:${language.toLowerCase()}:${normalizeItemId(itemId)}`;
  }

  private async openFieldDiff(
    leftItemId: string,
    rightItemId: string,
    fieldId: string,
  ): Promise<void> {
    await this.openFieldDiffForAvailableSides(leftItemId, rightItemId, fieldId);
  }

  private async clearFieldDiffSelection(): Promise<void> {
    this.selectedFieldDiffItem = undefined;
    await this.fieldDiffViewProvider.clear();
  }

  private async openSelectedFieldDiff(fieldId: string): Promise<void> {
    const selected = this.selectedFieldDiffItem;
    if (!selected) {
      return;
    }
    await this.openFieldDiffForAvailableSides(
      selected.leftItemId,
      selected.rightItemId,
      fieldId,
    );
  }

  private async copySelectedFieldValue(
    fieldId: string,
    direction: "leftToRight" | "rightToLeft",
  ): Promise<void> {
    const normalizedFieldId = normalizeItemId(fieldId);
    if (this.copyingFieldIds.has(normalizedFieldId)) {
      return;
    }
    this.copyingFieldIds.add(normalizedFieldId);
    try {
      const selected = this.selectedFieldDiffItem;
      const selection = this.getSelection();
      if (
        !selected?.leftItemId ||
        !selected.rightItemId ||
        !selection.leftConnectionId ||
        !selection.rightConnectionId
      ) {
        void vscode.window.showErrorMessage(
          "Both items and connections must be available to copy a field value.",
        );
        return;
      }

      const [leftDetails, rightDetails] = await Promise.all([
        this.getItemDetails(
          selection.leftConnectionId,
          selection.leftLanguage,
          selected.leftItemId,
        ),
        this.getItemDetails(
          selection.rightConnectionId,
          selection.rightLanguage,
          selected.rightItemId,
        ),
      ]);
      const leftField = leftDetails.fields.find(
        (field) => normalizeItemId(field.fieldId) === normalizedFieldId,
      );
      const rightField = rightDetails.fields.find(
        (field) => normalizeItemId(field.fieldId) === normalizedFieldId,
      );
      if (!leftField || !rightField) {
        void vscode.window.showErrorMessage(
          "The field is no longer available on both sides of the comparison.",
        );
        return;
      }

      const leftToRight = direction === "leftToRight";
      const sourceSide: TreeSide = leftToRight ? "left" : "right";
      const targetSide: TreeSide = leftToRight ? "right" : "left";
      const sourceDetails = leftToRight ? leftDetails : rightDetails;
      const targetDetails = leftToRight ? rightDetails : leftDetails;
      const sourceField = leftToRight ? leftField : rightField;
      const targetField = leftToRight ? rightField : leftField;
      const sourceConnectionId = leftToRight
        ? selection.leftConnectionId
        : selection.rightConnectionId;
      const targetConnectionId = leftToRight
        ? selection.rightConnectionId
        : selection.leftConnectionId;
      const sourceConnection = this.connectionStore.get(sourceConnectionId);
      const targetConnection = this.connectionStore.get(targetConnectionId);
      if (!sourceConnection || !targetConnection) {
        void vscode.window.showErrorMessage("A comparison connection is no longer available.");
        return;
      }
      if (sourceField.containsFallbackValue) {
        void vscode.window.showWarningMessage(
          "Fallback-derived values cannot be copied as stored field values.",
        );
        return;
      }

      const normalization = vscode.workspace
        .getConfiguration("xmCloudSync")
        .get<"none" | "lineEndings">("textNormalization", "none");
      const normalizeValue = (value: string): string =>
        normalization === "lineEndings" ? value.replace(/\r\n?|\n/g, "\n") : value;
      if (normalizeValue(sourceField.value) === normalizeValue(targetField.value)) {
        void vscode.window.showInformationMessage("The field values no longer differ.");
        return;
      }

      const sourceKind = sourceField.containsInheritedValue
        ? "inherited"
        : sourceField.containsStandardValue
          ? "Standard Value"
          : "stored";
      const fieldLabel = targetField.label || targetField.name;
      const sourceLabel = `${sourceConnection.name}/${sourceDetails.language}`;
      const targetLabel = `${targetConnection.name}/${targetDetails.language}`;
      const sourceNote = sourceKind === "stored"
        ? ""
        : ` The ${sourceKind} source value will become an explicit stored value on the target.`;
      if (!this.globalState.get<boolean>(fieldTransferConfirmationKey, false)) {
        const confirmed = await vscode.window.showWarningMessage(
          `Add a transfer for “${fieldLabel}” from ${sourceLabel} to ${targetLabel}? Processing it will replace the target field value.${sourceNote} This confirmation is shown only for the first accepted field transfer.`,
          { modal: true },
          "Add Transfer",
        );
        if (confirmed !== "Add Transfer") {
          return;
        }
        await this.globalState.update(fieldTransferConfirmationKey, true);
      }
      const currentSelection = this.getSelection();
      if (
        selected !== this.selectedFieldDiffItem ||
        currentSelection.leftConnectionId !== selection.leftConnectionId ||
        currentSelection.rightConnectionId !== selection.rightConnectionId ||
        currentSelection.leftLanguage !== selection.leftLanguage ||
        currentSelection.rightLanguage !== selection.rightLanguage
      ) {
        void vscode.window.showWarningMessage(
          "The comparison changed before the field value could be copied.",
        );
        return;
      }
      const duplicateKey = [
        "field",
        sourceConnectionId,
        targetConnectionId,
        normalizeItemId(targetDetails.itemId),
        normalizedFieldId,
        direction,
      ].join(":");
      const enqueueResult = await this.transferQueue.enqueue({
        kind: "fieldValue",
        intent: {
          kind: "fieldValue",
          source: {
            connectionId: sourceConnectionId,
            itemId: sourceDetails.itemId,
            itemPath: sourceDetails.path,
            language: sourceDetails.language,
            fieldId: sourceField.fieldId,
            fieldName: sourceField.name,
            fieldLabel,
          },
          destination: {
            connectionId: targetConnectionId,
            itemId: targetDetails.itemId,
            itemPath: targetDetails.path,
            language: targetDetails.language,
            fieldId: targetField.fieldId,
            fieldName: targetField.name,
            fieldLabel,
          },
        },
        duplicateKey,
        direction,
        source: {
          connectionId: sourceConnectionId,
          connectionName: sourceConnection.name,
          itemId: sourceDetails.itemId,
          itemPath: sourceDetails.path,
          language: sourceDetails.language,
          version: sourceDetails.version,
          fieldId: sourceField.fieldId,
          fieldName: sourceField.name,
          fieldLabel,
          fingerprint: fieldStateFingerprint(sourceDetails, sourceField),
        },
        target: {
          connectionId: targetConnectionId,
          connectionName: targetConnection.name,
          itemId: targetDetails.itemId,
          itemPath: targetDetails.path,
          language: targetDetails.language,
          version: targetDetails.version,
          fieldId: targetField.fieldId,
          fieldName: targetField.name,
          fieldLabel,
          fingerprint: fieldStateFingerprint(targetDetails, targetField),
        },
      });
      if (enqueueResult.added) {
        this.log.info(`Queued field ${normalizedFieldId} ${sourceSide} to ${targetSide}.`);
        void vscode.window.showInformationMessage(
          `Added “${fieldLabel}” from ${sourceLabel} to ${targetLabel} to Transfers.`,
        );
      } else {
        void vscode.window.showInformationMessage(
          `That “${fieldLabel}” transfer is already queued.`,
        );
      }
    } catch (error: unknown) {
      void vscode.window.showErrorMessage(`Unable to queue field transfer: ${errorMessage(error)}`);
    } finally {
      this.copyingFieldIds.delete(normalizedFieldId);
    }
  }

  private async copySelectedItemId(side: TreeSide, itemId: string): Promise<boolean> {
    const selectedItemId = side === "left"
      ? this.selectedFieldDiffItem?.leftItemId
      : this.selectedFieldDiffItem?.rightItemId;
    if (!selectedItemId || normalizeItemId(selectedItemId) !== normalizeItemId(itemId)) {
      await vscode.window.showErrorMessage(`The ${side} item ID is no longer available.`);
      return false;
    }
    try {
      await vscode.env.clipboard.writeText(itemId);
      this.log.info(`Copied ${side} Field Diff item ID to the clipboard.`);
      return true;
    } catch (error: unknown) {
      await vscode.window.showErrorMessage(`Unable to copy item ID: ${errorMessage(error)}`);
      return false;
    }
  }

  private async openFieldDiffForAvailableSides(
    leftItemId: string | undefined,
    rightItemId: string | undefined,
    fieldId: string,
  ): Promise<void> {
    const selection = this.getSelection();
    const [leftDetails, rightDetails] = await Promise.all([
      leftItemId && selection.leftConnectionId
        ? this.getItemDetails(selection.leftConnectionId, selection.leftLanguage, leftItemId)
        : undefined,
      rightItemId && selection.rightConnectionId
        ? this.getItemDetails(selection.rightConnectionId, selection.rightLanguage, rightItemId)
        : undefined,
    ]);
    const normalizedFieldId = normalizeItemId(fieldId);
    const leftField = leftDetails?.fields.find(
      (field) => normalizeItemId(field.fieldId) === normalizedFieldId,
    );
    const rightField = rightDetails?.fields.find(
      (field) => normalizeItemId(field.fieldId) === normalizedFieldId,
    );
    const fieldName = leftField?.label || rightField?.label || leftField?.name || rightField?.name || "Field";
    const normalization = vscode.workspace
      .getConfiguration("xmCloudSync")
      .get<"none" | "lineEndings">("textNormalization", "none");
    const normalize = (value: string): string =>
      normalization === "lineEndings" ? value.replace(/\r\n?|\n/g, "\n") : value;
    const leftUri = this.fieldDiffProvider.create(
      normalize(leftField?.value ?? ""),
      `${selection.leftLanguage}-${fieldName}`,
    );
    const rightUri = this.fieldDiffProvider.create(
      normalize(rightField?.value ?? ""),
      `${selection.rightLanguage}-${fieldName}`,
    );
    await vscode.commands.executeCommand(
      "vscode.diff",
      leftUri,
      rightUri,
      `${fieldName}: ${selection.leftLanguage} ↔ ${selection.rightLanguage}`,
      { preview: true },
    );
  }

  private async refreshFieldDiffView(): Promise<void> {
    if (!this.fieldDiffViewProvider.visible) {
      return;
    }
    const selected = this.selectedFieldDiffItem;
    if (!selected) {
      await this.fieldDiffViewProvider.clear();
      return;
    }
    const selection = this.getSelection();
    await this.fieldDiffViewProvider.showLoading(selected);
    try {
      const [leftResult, rightResult] = await Promise.allSettled([
        selected.leftItemId && selection.leftConnectionId
          ? this.getItemDetails(
              selection.leftConnectionId,
              selection.leftLanguage,
              selected.leftItemId,
            )
          : undefined,
        selected.rightItemId && selection.rightConnectionId
          ? this.getItemDetails(
              selection.rightConnectionId,
              selection.rightLanguage,
              selected.rightItemId,
            )
          : undefined,
      ]);
      const leftDetails = leftResult.status === "fulfilled" ? leftResult.value : undefined;
      const rightDetails = rightResult.status === "fulfilled" ? rightResult.value : undefined;
      const leftError = leftResult.status === "rejected"
        ? errorMessage(leftResult.reason)
        : undefined;
      const rightError = rightResult.status === "rejected"
        ? errorMessage(rightResult.reason)
        : undefined;
      if (selected !== this.selectedFieldDiffItem || !this.fieldDiffViewProvider.visible) {
        return;
      }
      await this.fieldDiffViewProvider.showSnapshot({
        ...selected,
        leftConnectionName: selection.leftConnectionId
          ? this.connectionStore.get(selection.leftConnectionId)?.name
          : undefined,
        rightConnectionName: selection.rightConnectionId
          ? this.connectionStore.get(selection.rightConnectionId)?.name
          : undefined,
        leftDetails,
        rightDetails,
        leftError,
        rightError,
        textNormalization: vscode.workspace
          .getConfiguration("xmCloudSync")
          .get<"none" | "lineEndings">("textNormalization", "none"),
      });
    } catch (error: unknown) {
      if (selected === this.selectedFieldDiffItem) {
        await this.fieldDiffViewProvider.showError(
          `Unable to load field details: ${errorMessage(error)}`,
        );
      }
    }
  }

  private async loadInitialTrees(): Promise<void> {
    if (!this.panel || this.connectionStore.list().length < 1) {
      return;
    }

    let selection = this.getSelection();
    if (
      selection.languagesLocked &&
      selection.leftConnectionId &&
      selection.rightConnectionId
    ) {
      const leftConnectionId = selection.leftConnectionId;
      const rightConnectionId = selection.rightConnectionId;
      try {
        const [leftLanguages, rightLanguages] = await Promise.all([
          this.getLanguages(leftConnectionId),
          this.getLanguages(rightConnectionId),
        ]);
        const pair = sameLanguage(selection.leftLanguage, selection.rightLanguage)
          ? lockedLanguagePair(selection.leftLanguage, leftLanguages, rightLanguages)
          : undefined;
        if (!pair) {
          await this.reportInvalidRestoredLanguageLock(
            selection,
            leftLanguages,
            rightLanguages,
          );
          return;
        }
        if (
          pair.leftLanguage !== selection.leftLanguage ||
          pair.rightLanguage !== selection.rightLanguage
        ) {
          selection = { ...selection, ...pair };
          await this.saveSelection(selection);
          await this.postState();
        }
        this.warnedInvalidLanguageLock = undefined;
      } catch {
        await Promise.all([
          this.loadAndPostLanguages("left", leftConnectionId),
          this.loadAndPostLanguages("right", rightConnectionId),
        ]);
        return;
      }
    }

    const requests: Promise<void>[] = [];
    if (selection.leftConnectionId) {
      requests.push(this.loadAndPostLanguages("left", selection.leftConnectionId));
      requests.push(
        this.loadTreeLevel(
          "left",
          selection.leftConnectionId,
          { path: authoringRootPath },
        ),
      );
    }
    if (selection.rightConnectionId) {
      requests.push(this.loadAndPostLanguages("right", selection.rightConnectionId));
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

  private async reportInvalidRestoredLanguageLock(
    selection: ComparisonSelection,
    leftLanguages: readonly AuthoringLanguage[],
    rightLanguages: readonly AuthoringLanguage[],
  ): Promise<void> {
    if (!selection.leftConnectionId || !selection.rightConnectionId || !this.panel) {
      return;
    }
    await Promise.all([
      this.loadAndPostLanguages("left", selection.leftConnectionId),
      this.loadAndPostLanguages("right", selection.rightConnectionId),
    ]);

    const leftAvailable = availableLanguage(leftLanguages, selection.leftLanguage);
    const rightAvailable = availableLanguage(rightLanguages, selection.rightLanguage);
    const message = sameLanguage(selection.leftLanguage, selection.rightLanguage)
      ? `The saved locked language "${selection.leftLanguage}" is no longer configured on both connections.`
      : "The saved locked language selection is inconsistent.";
    const unavailableSides: readonly TreeSide[] = leftAvailable && rightAvailable
      ? ["left", "right"]
      : [
          ...(leftAvailable ? [] : ["left" as const]),
          ...(rightAvailable ? [] : ["right" as const]),
        ];
    await Promise.all(unavailableSides.map(async (side) => {
      const connectionId = side === "left"
        ? selection.leftConnectionId
        : selection.rightConnectionId;
      const language = side === "left" ? selection.leftLanguage : selection.rightLanguage;
      await this.panel?.webview.postMessage({
        type: "treeLoadFailed",
        side,
        connectionId,
        language,
        message,
      });
    }));

    const signature = [
      selection.leftConnectionId,
      selection.rightConnectionId,
      selection.leftLanguage.toLowerCase(),
      selection.rightLanguage.toLowerCase(),
    ].join(":");
    if (this.warnedInvalidLanguageLock === signature) {
      return;
    }
    this.warnedInvalidLanguageLock = signature;
    const action = await vscode.window.showWarningMessage(message, "Unlock Languages");
    if (action === "Unlock Languages") {
      await this.handleLanguageLockChange(false);
    }
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
    const language = this.sideLanguage(side);
    if (cancellationSignal) {
      throwIfAborted(cancellationSignal);
    }
    if (!this.panel || !this.isCurrentSelection(side, connectionId, language)) {
      throw new DOMException("The comparison selection changed.", "AbortError");
    }

    await this.panel.webview.postMessage({
      type: "treeLoading",
      side,
      connectionId,
      language,
      requestedItemId,
    });
    this.log.debug(
      `Loading ${side} tree level for connection ${connectionId} (${locatorDescription(locator)}).`,
    );

    try {
      const level = await this.getTreeLevel(connectionId, language, locator, cancellationSignal);
      if (cancellationSignal) {
        throwIfAborted(cancellationSignal);
      }
      if (!this.panel || !this.isCurrentSelection(side, connectionId, language)) {
        throw new DOMException("The comparison selection changed.", "AbortError");
      }
      await this.panel.webview.postMessage({
        type: "treeLoaded",
        side,
        connectionId,
        language,
        requestedItemId,
        level,
      });
      void this.loadAndPostItemIcons(
        side,
        connectionId,
        language,
        [level.item, ...level.children].map((item) => item.itemId),
      );
      this.log.info(
        `Loaded ${side} tree level ${level.item.path} with ${level.children.length} direct child item(s).`,
      );
      return level;
    } catch (error: unknown) {
      if (!isAbortError(error) && !cancellationSignal?.aborted) {
        await this.reportTreeLoadFailure(
          side,
          connectionId,
          language,
          locator,
          requestedItemId,
          error,
        );
      }
      throw error;
    }
  }

  private async loadAndPostItemIcons(
    side: TreeSide,
    connectionId: string,
    language: string,
    itemIds: readonly string[],
  ): Promise<void> {
    const generation = this.itemIconGeneration;
    try {
      const references = await this.getItemIconReferences(
        connectionId,
        language,
        itemIds,
      );
      if (
        generation !== this.itemIconGeneration ||
        !this.panel ||
        !this.isCurrentSelection(side, connectionId, language)
      ) {
        return;
      }

      const itemIdsByConfiguredIcon = new Map<string, string[]>();
      const itemsWithoutConfiguredIcon: string[] = [];
      for (const itemId of itemIds) {
        const configuredIcon = references.get(normalizeItemId(itemId));
        if (!configuredIcon) {
          itemsWithoutConfiguredIcon.push(itemId);
          continue;
        }
        const matchingItemIds = itemIdsByConfiguredIcon.get(configuredIcon) ?? [];
        matchingItemIds.push(itemId);
        itemIdsByConfiguredIcon.set(configuredIcon, matchingItemIds);
      }

      if (itemsWithoutConfiguredIcon.length) {
        await this.postItemIcons(
          side,
          connectionId,
          language,
          generation,
          itemsWithoutConfiguredIcon,
          undefined,
        );
      }
      await Promise.all([...itemIdsByConfiguredIcon].map(async ([configuredIcon, matchingItemIds]) => {
        const icon = await this.getItemIcon(connectionId, configuredIcon, generation);
        await this.postItemIcons(
          side,
          connectionId,
          language,
          generation,
          matchingItemIds,
          icon,
        );
      }));
    } catch (error: unknown) {
      if (!isAbortError(error) && generation === this.itemIconGeneration) {
        this.log.debug(
          `Unable to load item-icon metadata for connection ${connectionId}; using fallback icons.`,
        );
      }
    }
  }

  private async postItemIcons(
    side: TreeSide,
    connectionId: string,
    language: string,
    generation: number,
    itemIds: readonly string[],
    icon: CachedItemIcon | undefined,
  ): Promise<void> {
    if (
      generation !== this.itemIconGeneration ||
      !this.panel ||
      !this.isCurrentSelection(side, connectionId, language)
    ) {
      return;
    }
    await this.panel.webview.postMessage({
      type: "itemIconsLoaded",
      side,
      connectionId,
      language,
      items: itemIds.map((itemId) => ({ itemId, iconKey: icon?.iconKey })),
      icons: icon ? [icon] : [],
    });
  }

  private async getItemIconReferences(
    connectionId: string,
    language: string,
    itemIds: readonly string[],
  ): Promise<ReadonlyMap<string, string | undefined>> {
    const normalizedItemIds = [...new Map(itemIds.map((itemId) => [
      normalizeItemId(itemId),
      itemId,
    ])).entries()];
    const missing = normalizedItemIds.filter(([normalizedId]) => {
      const cacheKey = this.itemIconReferenceCacheKey(connectionId, normalizedId);
      return !this.itemIconReferenceCache.has(cacheKey) &&
        !this.pendingItemIconReferences.has(cacheKey);
    });

    const connection = this.connectionStore.get(connectionId);
    if (!connection) {
      throw new Error("The XM Cloud connection no longer exists.");
    }
    const clientSecret = missing.length
      ? this.connectionStore.getClientSecret(connectionId)
      : Promise.resolve(undefined);

    for (let offset = 0; offset < missing.length; offset += 128) {
      const batchEntries = missing.slice(offset, offset + 128);
      const batch = clientSecret.then(async (secret) => {
        if (!secret) {
          throw new Error("The connection's client secret is missing.");
        }
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(new Error("Item-icon metadata loading timed out.")),
          30_000,
        );
        this.requestControllers.add(controller);
        try {
          return await this.authoringClient.loadItemIconReferences(
            connection,
            secret,
            batchEntries.map(([, itemId]) => itemId),
            language,
            controller.signal,
          );
        } finally {
          clearTimeout(timeout);
          this.requestControllers.delete(controller);
        }
      }).then((loaded) => new Map<string, AuthoringItemIconReference>(
        loaded.map((reference) => [normalizeItemId(reference.itemId), reference]),
      ));

      for (const [normalizedId] of batchEntries) {
        const cacheKey = this.itemIconReferenceCacheKey(connectionId, normalizedId);
        let request: Promise<string | undefined>;
        request = batch.then((loaded) => {
          const configuredIcon = loaded.get(normalizedId)?.configuredIcon;
          setBoundedCache(
            this.itemIconReferenceCache,
            cacheKey,
            configuredIcon,
            maximumItemIconReferences,
          );
          return configuredIcon;
        }).finally(() => {
          if (this.pendingItemIconReferences.get(cacheKey) === request) {
            this.pendingItemIconReferences.delete(cacheKey);
          }
        });
        this.pendingItemIconReferences.set(cacheKey, request);
      }
    }

    const result = new Map<string, string | undefined>();
    await Promise.all(normalizedItemIds.map(async ([normalizedId]) => {
      const cacheKey = this.itemIconReferenceCacheKey(connectionId, normalizedId);
      const configuredIcon = this.itemIconReferenceCache.has(cacheKey)
        ? this.itemIconReferenceCache.get(cacheKey)
        : await this.pendingItemIconReferences.get(cacheKey);
      result.set(normalizedId, configuredIcon);
    }));
    return result;
  }

  private async getItemIcon(
    connectionId: string,
    configuredIcon: string,
    generation: number,
  ): Promise<CachedItemIcon | undefined> {
    const connection = this.connectionStore.get(connectionId);
    if (!connection) {
      return undefined;
    }
    const iconUrl = resolveSitecoreIconUrl(connection.serverUrl, configuredIcon);
    if (!iconUrl) {
      return undefined;
    }
    const cacheKey = `${connectionId}:${iconUrl.href}`;
    if (this.itemIconCache.has(cacheKey)) {
      return this.itemIconCache.get(cacheKey);
    }
    const pending = this.pendingItemIcons.get(cacheKey);
    if (pending) {
      return pending;
    }

    let request: Promise<CachedItemIcon | undefined>;
    request = this.withItemIconLoadPermit(async () => {
      if (generation !== this.itemIconGeneration) {
        return undefined;
      }
      const clientSecret = await this.connectionStore.getClientSecret(connectionId);
      if (!clientSecret || generation !== this.itemIconGeneration) {
        return undefined;
      }
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(new Error("Item-icon loading timed out.")),
        30_000,
      );
      this.requestControllers.add(controller);
      try {
        const dataUri = await this.authoringClient.loadItemIcon(
          connection,
          clientSecret,
          configuredIcon,
          controller.signal,
        );
        if (generation !== this.itemIconGeneration) {
          return undefined;
        }
        const icon = {
          iconKey: `item-icon-${this.nextItemIconKey}`,
          dataUri,
        };
        this.nextItemIconKey += 1;
        setBoundedCache(this.itemIconCache, cacheKey, icon, maximumItemIconImages);
        return icon;
      } catch (error: unknown) {
        if (!isAbortError(error) && generation === this.itemIconGeneration) {
          setBoundedCache(this.itemIconCache, cacheKey, undefined, maximumItemIconImages);
          this.log.debug(
            `Unable to load a configured item icon for connection ${connectionId}; using the fallback icon.`,
          );
        }
        return undefined;
      } finally {
        clearTimeout(timeout);
        this.requestControllers.delete(controller);
      }
    }).finally(() => {
      if (this.pendingItemIcons.get(cacheKey) === request) {
        this.pendingItemIcons.delete(cacheKey);
      }
    });
    this.pendingItemIcons.set(cacheKey, request);
    return request;
  }

  private async withItemIconLoadPermit<T>(operation: () => Promise<T>): Promise<T> {
    if (this.activeItemIconLoads >= itemIconLoadConcurrency) {
      await new Promise<void>((resolve) => this.itemIconLoadWaiters.push(resolve));
    } else {
      this.activeItemIconLoads += 1;
    }
    try {
      return await operation();
    } finally {
      const next = this.itemIconLoadWaiters.shift();
      if (next) {
        next();
      } else {
        this.activeItemIconLoads -= 1;
      }
    }
  }

  private itemIconReferenceCacheKey(connectionId: string, normalizedItemId: string): string {
    return `${connectionId}:${normalizedItemId}`;
  }

  private invalidateItemIcon(connectionId: string, itemId: string): void {
    const cacheKey = this.itemIconReferenceCacheKey(connectionId, normalizeItemId(itemId));
    this.itemIconReferenceCache.delete(cacheKey);
    this.pendingItemIconReferences.delete(cacheKey);
  }

  private clearItemIconCaches(): void {
    this.itemIconReferenceCache.clear();
    this.pendingItemIconReferences.clear();
    this.itemIconCache.clear();
    this.pendingItemIcons.clear();
    this.nextItemIconKey = 1;
  }

  private async reportTreeLoadFailure(
    side: TreeSide,
    connectionId: string,
    language: string,
    locator: AuthoringItemLocator,
    requestedItemId: string | undefined,
    error: unknown,
  ): Promise<void> {
    if (!this.panel || !this.isCurrentSelection(side, connectionId, language)) {
      return;
    }
    await this.panel.webview.postMessage({
      type: "treeLoadFailed",
      side,
      connectionId,
      language,
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
    language: string,
    locator: AuthoringItemLocator,
    cancellationSignal?: AbortSignal,
  ): Promise<AuthoringTreeLevel> {
    const cacheKey = this.treeCacheKey(connectionId, language, locator);
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
      .loadTreeLevel(connection, clientSecret, locator, language, controller.signal)
      .then((level) => {
        if (this.pendingTreeLevels.get(cacheKey) === request) {
          this.treeLevelCache.set(cacheKey, level);
        }
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

  private treeCacheKey(
    connectionId: string,
    language: string,
    locator: AuthoringItemLocator,
  ): string {
    const locatorKey = "path" in locator ? `path:${locator.path}` : `id:${locator.itemId}`;
    return `${connectionId}:${language.toLowerCase()}:${locatorKey}`;
  }

  private isCurrentSelection(
    side: "left" | "right",
    connectionId: string,
    language: string,
  ): boolean {
    const selection = this.getSelection();
    return side === "left"
      ? selection.leftConnectionId === connectionId && selection.leftLanguage === language
      : selection.rightConnectionId === connectionId && selection.rightLanguage === language;
  }

  private sideLanguage(side: TreeSide): string {
    const selection = this.getSelection();
    return side === "left" ? selection.leftLanguage : selection.rightLanguage;
  }

  private getSelection(): ComparisonSelection {
    const stored = this.workspaceState.get<Partial<ComparisonSelection>>(selectionKey, {});
    return this.normalizeSelection(stored);
  }

  private normalizeSelection(
    selection: Partial<ComparisonSelection>,
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
        : connectionIds.find((id) => id !== leftConnectionId) ?? leftConnectionId;

    return {
      leftConnectionId,
      rightConnectionId,
      leftLanguage: selection.leftLanguage?.trim() || defaultLanguage,
      rightLanguage: selection.rightLanguage?.trim() || defaultLanguage,
      languagesLocked: selection.languagesLocked === true,
    };
  }

  private async saveSelection(selection: ComparisonSelection): Promise<void> {
    await this.workspaceState.update(selectionKey, selection);
    this.comparisonStateEmitter.fire();
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
      textNormalization: vscode.workspace
        .getConfiguration("xmCloudSync")
        .get<"none" | "lineEndings">("textNormalization", "none"),
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
    this.itemIconGeneration += 1;
    this.favoriteNavigationGeneration += 1;
    this.cancelSubtreeLoads();
    for (const controller of this.requestControllers) {
      controller.abort();
    }
    this.requestControllers.clear();
    this.pendingTreeLevels.clear();
    this.pendingLanguages.clear();
    this.pendingItemDetails.clear();
    this.pendingItemIconReferences.clear();
    this.pendingItemIcons.clear();
    this.resolvePendingFavoriteReveals(false);
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
    this.languageCache.clear();
    this.itemDetailsCache.clear();
    this.clearItemIconCaches();
    this.panel?.dispose();
    this.disposePanelSubscriptions();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.comparisonStateEmitter.dispose();
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

function setBoundedCache<K, V>(
  cache: Map<K, V>,
  key: K,
  value: V,
  maximumEntries: number,
): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > maximumEntries) {
    const oldestKey = cache.keys().next().value as K | undefined;
    if (oldestKey === undefined) {
      break;
    }
    cache.delete(oldestKey);
  }
}

function normalizedPath(path: string): string {
  return path.replace(/\/+$/u, "").toLowerCase();
}

function itemNameFromPath(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function subtreeTransferConfirmation(
  mode: SubtreeTransferMode,
  sourcePath: string,
  preflight: SubtreeTransferPreflight,
): { readonly message: string; readonly detail: string; readonly action: string } {
  const counts =
    `Source: ${preflight.sourceItems} item(s) · Target: ${preflight.targetItems} item(s)\n` +
    `Will add: ${preflight.addItems} · update: ${preflight.updateItems} · remove: ${preflight.removeItems}`;
  switch (mode) {
    case "addMissing":
      return {
        message: "Add missing content?",
        detail: `Existing target items under ${sourcePath} will be kept.\n\n${counts}`,
        action: "Add Transfer",
      };
    case "synchronize":
      return {
        message: "Synchronize target tree?",
        detail: `Matching items under ${sourcePath} will be replaced. Target-only items will remain.\n\n${counts}`,
        action: "Add Transfer",
      };
    case "exactMirror":
      return {
        message: "Replace target tree?",
        detail:
          "The target subtree will be deleted and recreated from source.\n\n" +
          `Path: ${sourcePath}\n\n` +
          `Source: ${preflight.sourceItems} item(s) · Target: ${preflight.targetItems} item(s)\n` +
          `Matching: ${preflight.updateItems} · Source-only: ${preflight.addItems} · ` +
          `Target-only: ${preflight.removeItems}`,
        action: "Replace",
      };
  }
}

function favoriteAncestorPaths(path: string): readonly string[] {
  const segments = path.split("/").filter(Boolean);
  return segments.map((_, index) => `/${segments.slice(0, index + 1).join("/")}`);
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
    if (typeof entry.loadLevel !== "boolean") {
      return [];
    }
    entries.push({
      itemId: entry.itemId,
      path: entry.path,
      depth: entry.depth,
      loadLevel: entry.loadLevel,
    });
  }
  return entries;
}
