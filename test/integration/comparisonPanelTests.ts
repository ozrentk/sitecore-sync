import { FieldDiffViewProvider } from "../../src/comparison/fieldDiffView";
import { ContentSession } from "../../src/comparison/contentSession";
import { modePreferencesKey, readModePreferences } from "../../src/comparison/modeSwitching";
import { deepStrictEqual, strictEqual, rejects } from "node:assert/strict";
import * as vscode from "vscode";
import { mock } from "node:test";
import { PublicPageService } from "../../src/publicPages/publicPageService";
import { ComparisonPanelManager } from "../../src/comparison/comparisonPanel";
import {
  SiteTreeItem,
  FavoriteTreeItem,
  ConnectionTreeProvider,
  ConnectionTreeItem,
} from "../../src/connections/connectionTreeProvider";
import type { ConnectionStore } from "../../src/connections/connectionStore";
import type { XmCloudConnection } from "../../src/connections/connection";
import { AuthoringItemNotFoundError } from "../../src/sitecore/authoringClient";
import type {
  AuthoringItemDetails,
  AuthoringLanguage,
  AuthoringTreeLevel,
} from "../../src/sitecore/authoringClient";
import { MemoryMemento, type IntegrationTest } from "./testSupport";

const selectionKey = "sitecoreXmCloudSync.comparisonSelection.v1";

interface ComparisonPanelHarness {
  openPublicPage(side: "left" | "right", itemId: string): Promise<void>;
  handleMessage(message: unknown): Promise<void>;
  openSite(connectionId: string, path: string): Promise<void>;
  openFavorite(connectionId: string, path: string): Promise<void>;
  loadAndPostItemIcons(
    side: "left" | "right",
    connectionId: string,
    language: string,
    itemIds: readonly string[],
  ): Promise<void>;
}

export const comparisonPanelTests: readonly IntegrationTest[] = [{
  name: "mode switching remembers the partner across reload and always retains left navigation despite a legacy right preference",
  async execute(): Promise<void> {
    const workspaceState = new MemoryMemento({ [modePreferencesKey]: {
      partners: { one: { connectionId: "one", language: "fr", languagesLocked: false } }, retainedSide: "right",
    } });
    const session = new ContentSession();
    session.openConnection({ connectionId: "one", language: "en", rootPath: "/" });
    const posted: Array<Record<string, unknown>> = [];
    const roots: unknown[] = [];
    const manager = Object.create(ComparisonPanelManager.prototype) as ComparisonPanelHarness;
    Object.assign(manager, { contentSession: session, modeIntent: 0, modeNavigation: new Map(), workspaceState,
      connectionStore: { list: () => [connection("one", "One")], get: () => connection("one", "One") },
      panel: { webview: { postMessage: async (message: Record<string, unknown>) => { posted.push(message); return true; } } },
      getLanguages: async () => [language("en"), language("fr")],
      cancelRequests: () => session.cancelPending(), clearFieldDiffSelection: async () => undefined,
      comparisonStateEmitter: { fire() {} }, loadAndPostLanguages: async () => undefined,
      loadTreeLevel: async (side: string, _id: string, locator: unknown) => { roots.push([side, locator]); },
    });
    await manager.handleMessage({ type: "switchMode", mode: "compare", viewContext: session.revisionId,
      navigation: { left: { rootPath: "/sitecore/home", selectedItemId: "page" } } });
    strictEqual(session.state?.mode, "compare");
    if (session.state?.mode !== "compare") throw Error("Expected Compare");
    strictEqual(session.state.right.language, "fr");
    deepStrictEqual(roots, [["left", { path: "/sitecore/home" }], ["right", { path: "/" }]]);
    await manager.handleMessage({ type: "switchMode", mode: "browse", viewContext: session.revisionId,
      navigation: { left: { rootPath: "/sitecore/home", selectedItemId: "page" }, right: { rootPath: "/sitecore/other", selectedItemId: "other" } } });
    deepStrictEqual(session.state, { mode: "browse", source: { connectionId: "one", language: "en", rootPath: "/sitecore/home", selectedItemId: "page" } });
    strictEqual(posted.at(-1)?.mode, "browse");
    const reloaded = readModePreferences(JSON.parse(JSON.stringify(workspaceState.get(modePreferencesKey))));
    strictEqual(reloaded.partners.one?.language, "fr");
    strictEqual(Object.hasOwn(reloaded, "retainedSide"), false);
    session.dispose();
  },
}, {
  name: "cancelled and superseded mode pickers leave the live Browse session intact",
  async execute(): Promise<void> {
    const session = new ContentSession();
    session.openConnection({ connectionId: "one", language: "en", rootPath: "/sitecore/home" });
    const initial = session.state;
    const workspaceState = new MemoryMemento();
    const manager = Object.create(ComparisonPanelManager.prototype) as ComparisonPanelHarness;
    Object.assign(manager, { contentSession: session, modeIntent: 0, modeNavigation: new Map(), workspaceState,
      connectionStore: { list: () => [connection("one", "One")], get: () => connection("one", "One") },
    });
    const cancelled = mock.method(vscode.window, "showQuickPick", async () => undefined);
    try {
      await manager.handleMessage({ type: "switchMode", mode: "compare", viewContext: session.revisionId });
      strictEqual(session.state, initial);
    } finally { cancelled.mock.restore(); }
    let finish!: (value: unknown) => void;
    const pending = mock.method(vscode.window, "showQuickPick", () => new Promise(resolve => { finish = resolve; }));
    try {
      const switching = manager.handleMessage({ type: "switchMode", mode: "compare", viewContext: session.revisionId });
      await manager.handleMessage({ type: "cancelModeSwitch", viewContext: session.revisionId });
      finish({ id: "one" });
      await switching;
      strictEqual(session.state, initial);
    } finally { pending.mock.restore(); session.dispose(); }
  },
}, {
  name: "Item Details provider rejects stale, right-side and mutation messages in Browse",
  async execute(): Promise<void> {
    const calls: string[] = [];
    const messages: Array<Record<string, unknown>> = [];
    let receive!: (message: unknown) => Promise<void>;
    const disposable = { dispose() {} };
    const view = { title: "", visible: true, onDidChangeVisibility: () => disposable,
      webview: { cspSource: "test", options: {}, html: "", asWebviewUri: (uri: vscode.Uri) => uri,
        onDidReceiveMessage: (listener: typeof receive) => { receive = listener; return disposable; },
        postMessage: async (message: Record<string, unknown>) => { messages.push(message); return true; } } };
    const provider = new FieldDiffViewProvider(vscode.Uri.file(process.cwd()), () => undefined,
      async () => { calls.push("diff"); }, async () => { calls.push("transfer"); },
      async () => { calls.push("copy"); return true; }, async () => { calls.push("page"); });
    try {
      provider.resolveWebviewView(view as unknown as vscode.WebviewView);
      await provider.showLoading({ mode: "browse", leftItemId: "item" });
      strictEqual(view.title, "Item Details");
      const contextId = messages.at(-1)?.contextId;
      await receive({ type: "openTextDiff", fieldId: "field", contextId });
      await receive({ type: "copyFieldValue", fieldId: "field", direction: "leftToRight", contextId });
      await receive({ type: "openPublicPage", side: "right", itemId: "item", contextId });
      await receive({ type: "openPublicPage", side: "left", itemId: "item", contextId: -1 });
      deepStrictEqual(calls, []);
      await receive({ type: "openPublicPage", side: "left", itemId: "item", contextId });
      await receive({ type: "copyItemId", side: "left", itemId: "item", contextId });
      deepStrictEqual(calls, ["page", "copy"]);
      await provider.clear("compare");
      strictEqual(view.title, "Field Diff");
      await receive({ type: "openTextDiff", fieldId: "field", contextId });
      strictEqual(calls.length, 2);
      await receive({ type: "openTextDiff", fieldId: "field", contextId: messages.at(-1)?.contextId });
      strictEqual(calls.at(-1), "diff");
    } finally { provider.dispose(); }
  },
}, {
  name: "Browse publishing and tasks use the browsed endpoint and reject stale or right-side actions",
  async execute(): Promise<void> {
    const session = new ContentSession();
    session.openConnection({ connectionId: "browse", language: "fr", rootPath: "/" });
    const calls: unknown[] = [];
    const tasks: unknown[] = [];
    const manager = Object.create(ComparisonPanelManager.prototype) as ComparisonPanelHarness;
    Object.assign(manager, { contentSession: session,
      connectionStore: { get: () => connection("browse", "Browse") },
      getItemDetails: async (connectionId: string, language: string, itemId: string) => {
        deepStrictEqual([connectionId, language, itemId], ["browse", "fr", "item"]);
        return itemDetails(itemId);
      },
      publishingManager: { start: async (...args: unknown[]) => { calls.push(args); } },
      itemTaskRunner: { selectAndRun: async (candidates: unknown) => { tasks.push(candidates); } },
      log: { warn() {} },
    });
    for (const type of ["standardPublish", "tracedPublish", "powerPublish"]) {
      await manager.handleMessage({ type, viewContext: session.revisionId, side: "left", itemId: "item", path: "/sitecore/item" });
    }
    deepStrictEqual(calls, ["standard", "traced", "power"].map(mode => [mode,
      { connectionId: "browse", language: "fr", side: "left", itemId: "item", path: "/sitecore/item" }]));
    await manager.handleMessage({ type: "runItemTask", viewContext: session.revisionId, side: "left", leftItemId: "item", rightItemId: "stale" });
    const candidates = tasks[0] as Array<{ connection: { id: string }; language: string; item: { itemId: string } }>;
    strictEqual(candidates.length, 1);
    deepStrictEqual([candidates[0]?.connection.id, candidates[0]?.language, candidates[0]?.item.itemId], ["browse", "fr", "item"]);
    const oldContext = session.revisionId;
    session.openConnection({ connectionId: "other", language: "de", rootPath: "/" });
    for (const message of [
      { type: "standardPublish", viewContext: oldContext, side: "left" },
      { type: "standardPublish", viewContext: session.revisionId, side: "right" },
      { type: "runItemTask", viewContext: oldContext, side: "left" },
      { type: "syncSubtree", viewContext: session.revisionId, side: "left" },
    ]) await manager.handleMessage({ ...message, itemId: "item", path: "/sitecore/item", leftItemId: "item" });
    strictEqual(calls.length, 3);
    strictEqual(tasks.length, 1);
    session.dispose();
  },
}, {
  name: "Browse item details ignore replaced selections and cancelled sessions",
  async execute(): Promise<void> {
    const session = new ContentSession();
    session.openConnection({ connectionId: "browse", language: "fr", rootPath: "/" });
    const snapshots: Array<Record<string, unknown>> = [];
    const pending = new Map<string, (value: AuthoringItemDetails) => void>();
    const manager = Object.create(ComparisonPanelManager.prototype) as ComparisonPanelHarness;
    Object.assign(manager, { contentSession: session,
      connectionStore: { get: () => connection("browse", "Browse") },
      getItemDetails: async (_connectionId: string, language: string, id: string) => {
        strictEqual(language, "fr");
        return new Promise<AuthoringItemDetails>(resolve => pending.set(id, resolve));
      },
      fieldDiffViewProvider: { visible: true, showLoading: async () => undefined,
        showSnapshot: async (snapshot: Record<string, unknown>) => { snapshots.push(snapshot); } },
    });
    const select = (id: string) => manager.handleMessage({ type: "selectBrowseItem", leftItemId: id, viewContext: session.revisionId });
    const first = select("first");
    await new Promise(resolve => setImmediate(resolve));
    const second = select("second");
    await new Promise(resolve => setImmediate(resolve));
    pending.get("second")?.(itemDetails("second"));
    await second;
    pending.get("first")?.(itemDetails("first"));
    await first;
    strictEqual(snapshots.length, 1);
    strictEqual(snapshots[0]?.mode, "browse");
    strictEqual((snapshots[0]?.leftDetails as AuthoringItemDetails).itemId, "second");
    strictEqual(snapshots[0]?.rightDetails, undefined);
    const cancelled = select("cancelled");
    await new Promise(resolve => setImmediate(resolve));
    session.cancelPending();
    pending.get("cancelled")?.(itemDetails("cancelled"));
    await cancelled;
    strictEqual(snapshots.length, 1);
    Object.assign(manager, { getItemDetails: async () => { throw new Error("Authoring unavailable"); } });
    await select("failed");
    strictEqual(snapshots.length, 2);
    strictEqual(snapshots[1]?.leftError, "Authoring unavailable");
    strictEqual(snapshots[1]?.leftDetails, undefined);
    session.dispose();
  },
}, {
  name: "Browse has one source, preserves Compare preferences and blocks paired actions",
  async execute(): Promise<void> {
    const one = connection("one", "One"); const two = connection("two", "Two");
    const session = new ContentSession();
    const saved = { leftConnectionId: "one", rightConnectionId: "one", leftLanguage: "en", rightLanguage: "de", languagesLocked: false };
    const workspaceState = new MemoryMemento({ [selectionKey]: saved });
    const loads: string[] = [];
    const manager = Object.create(ComparisonPanelManager.prototype) as {
      getSelection(): Record<string, unknown>;
      saveSelection(value: unknown): Promise<void>;
      loadInitialTrees(): Promise<void>;
      handleMessage(value: unknown): Promise<void>;
    };
    Object.assign(manager, { contentSession: session, workspaceState, panel: {},
      connectionStore: { list: () => [one, two], get: (id: string) => id === "one" ? one : two },
      comparisonStateEmitter: { fire() {} },
      loadAndPostLanguages: async (side: string) => { loads.push(`languages:${side}`); },
      loadTreeLevel: async (side: string) => { loads.push(`tree:${side}`); },
    });
    session.openConnection({ connectionId: "two", language: "fr", rootPath: "/" });
    strictEqual(manager.getSelection().rightConnectionId, undefined);
    await manager.loadInitialTrees();
    deepStrictEqual(loads.sort(), ["languages:left", "tree:left"]);
    for (const type of ["syncSubtree", "swapConnections", "setLanguageLock", "standardPublish", "runItemTask", "openPublicPage", "selectFieldDiffItem", "loadItemDetails"]) {
      await manager.handleMessage({ type, side: "left", itemId: "item", language: "en", connectionId: "one" });
    }
    await manager.handleMessage({ type: "loadRoot", side: "right", connectionId: "one" });
    strictEqual(loads.length, 2);
    await manager.saveSelection({ leftConnectionId: "two", leftLanguage: "de", rightLanguage: "en", languagesLocked: false });
    strictEqual(manager.getSelection().leftLanguage, "de");
    deepStrictEqual(workspaceState.get(selectionKey), saved);
    session.openCompare({ connectionId: "one", language: "en", rootPath: "/" }, { connectionId: "one", language: "de", rootPath: "/" });
    strictEqual(manager.getSelection().rightLanguage, "de");
    session.dispose();
  },
}, {
  name: "Browse tree responses cannot publish after cancellation or a mode round trip",
  async execute(): Promise<void> {
    for (const cancel of [true, false]) {
      const session = new ContentSession(); const source = { connectionId: "one", language: "en", rootPath: "/" };
      session.openConnection(source);
      const messages: { type: string }[] = [];
      let finish!: (value: AuthoringTreeLevel) => void;
      const result = new Promise<AuthoringTreeLevel>(resolve => { finish = resolve; });
      const manager = Object.create(ComparisonPanelManager.prototype) as { loadAndPostTreeLevel(side: string, id: string, locator: unknown): Promise<unknown> };
      Object.assign(manager, { contentSession: session,
        panel: { webview: { postMessage: async (message: { type: string }) => { messages.push(message); return true; } } },
        sideLanguage: () => "en", isCurrentSelection: () => true, getTreeLevel: async () => result,
        log: { debug() {}, info() {} },
      });
      const pending = manager.loadAndPostTreeLevel("left", "one", { path: "/" });
      if (cancel) session.cancelPending();
      else { session.openCompare(source, source); session.openConnection(source); }
      finish(treeLevel("/sitecore"));
      await rejects(pending, /selection changed/);
      deepStrictEqual(messages.map(value => value.type), ["treeLoading"]);
      session.dispose();
    }
  },
}, {
  name: "public pages open directly and cancelled or stale resolutions do not launch",
  async execute(): Promise<void> {
    const manager = Object.create(ComparisonPanelManager.prototype) as ComparisonPanelHarness;
    const controllers = new Set<AbortController>();
    const opened: string[] = [];
    let current = true;
    let cancel = false;
    Object.assign(manager, {
      requestControllers: controllers,
      getSelection: () => ({ leftConnectionId: "left", leftLanguage: "en" }),
      isCurrentSelection: () => current,
    });
    const resolve = mock.method(PublicPageService.prototype, "resolve", async () => {
      if (cancel) { for (const controller of controllers) controller.abort(); }
      return { url: "https://example.test/page" };
    });
    const open = mock.method(vscode.env, "openExternal", async (uri: vscode.Uri) => { opened.push(uri.toString()); return true; });
    const picker = mock.method(vscode.window, "showQuickPick", async () => undefined);
    try {
      await manager.openPublicPage("left", "page");
      deepStrictEqual(opened, ["https://example.test/page"]);
      strictEqual(picker.mock.callCount(), 0);
      current = false;
      await manager.openPublicPage("left", "page");
      current = true;
      cancel = true;
      await manager.openPublicPage("left", "page");
      strictEqual(opened.length, 1);
      strictEqual(controllers.size, 0);
    } finally {
      resolve.mock.restore(); open.mock.restore(); picker.mock.restore();
    }
  },
}, {
  name: "name search falls back on empty left results, paginates only the chosen connection and blocks stale selections",
  async execute(): Promise<void> {
    const manager = Object.create(ComparisonPanelManager.prototype) as ComparisonPanelHarness;
    const messages: Array<Record<string, unknown>> = [];
    const calls: string[] = [];
    let fail = false;
    let revealSide: string | undefined;
    Object.assign(manager, {
      favoriteNavigationGeneration: 0, pendingFavoriteReveal: new Map(),
      panel: { webview: { postMessage: async (message: Record<string, unknown>) => { messages.push(message); return true; } } },
      getSelection: () => ({ leftConnectionId: "left", rightConnectionId: "right", leftLanguage: "en", rightLanguage: "fr" }),
      connectionStore: { get: (id: string) => connection(id, id), getClientSecret: async () => "secret" },
      authoringClient: { searchItemsByName: async (connection: XmCloudConnection, _secret: string, _query: string, _language: string, page: number) => {
        calls.push(`${connection.id}:${page}`);
        if (fail) { throw new Error("offline"); }
        return connection.id === "left" ? { items: [], totalCount: 0, hasMore: false } : { items: [treeLevel(`/sitecore/Page${page}`, `id${page}`).item], totalCount: 75, hasMore: page === 0 };
      } },
      getTreeLevel: async (id: string) => { revealSide = id; return treeLevel("/sitecore/Page0"); },
      revealFavoriteNavigation: async () => undefined,
    });
    await manager.handleMessage({ type: "navigateItem", query: "Page", requestId: "1" });
    deepStrictEqual(calls.splice(0), ["left:0", "right:0"]);
    strictEqual(messages.at(-1)?.type, "itemSearchResults");
    await manager.handleMessage({ type: "moreItemResults", requestId: "1" });
    deepStrictEqual(calls.splice(0), ["right:1"]);
    await manager.handleMessage({ type: "revealItemResult", searchRequestId: "old", requestId: "2", itemId: "id0" });
    strictEqual(revealSide, undefined);
    await manager.handleMessage({ type: "revealItemResult", searchRequestId: "1", requestId: "2", itemId: "id0" });
    strictEqual(revealSide, "right");
    fail = true;
    await manager.handleMessage({ type: "navigateItem", query: "Page", requestId: "3" });
    deepStrictEqual(calls, ["left:0"]);
    strictEqual(String(messages.at(-1)?.text).includes("offline"), true);
  },
}, {
  name: "exact navigation falls back only on not-found and ignores cancelled lookups",
  async execute(): Promise<void> {
    const manager = Object.create(ComparisonPanelManager.prototype) as ComparisonPanelHarness;
    const calls: string[] = [];
    const messages: Array<Record<string, unknown>> = [];
    let failure: Error | undefined;
    let cancel = false;
    Object.assign(manager, {
      favoriteNavigationGeneration: 0,
      pendingFavoriteReveal: new Map(),
      getSelection: () => ({ leftConnectionId: "left", rightConnectionId: "right", leftLanguage: "en", rightLanguage: "fr" }),
      panel: { webview: { postMessage: async (message: Record<string, unknown>) => { messages.push(message); return true; } } },
      getTreeLevel: async (connectionId: string) => {
        calls.push(connectionId);
        if (cancel) { await manager.handleMessage({ type: "cancelItemLookup" }); }
        if (connectionId === "left" && failure) { throw failure; }
        return treeLevel("/sitecore/content/Page");
      },
      revealFavoriteNavigation: async () => { calls.push("reveal"); },
    });
    const run = () => manager.handleMessage({ type: "navigateItem", query: "/sitecore/content/Page", requestId: "1" });
    await run();
    deepStrictEqual(calls.splice(0), ["left", "reveal"]);
    failure = new AuthoringItemNotFoundError("not found");
    await run();
    deepStrictEqual(calls.splice(0), ["left", "right", "reveal"]);
    failure = new Error("offline");
    await run();
    deepStrictEqual(calls.splice(0), ["left"]);
    strictEqual(String(messages.at(-1)?.text).includes("offline"), true);
    failure = undefined;
    cancel = true;
    const before = messages.length;
    await run();
    deepStrictEqual(calls, ["left"]);
    strictEqual(messages.length, before);
  },
}, {
  name: "language-only selection changes load only changed sides and ignore stale child requests",
  async execute(): Promise<void> {
    let selection = { leftConnectionId: "left", rightConnectionId: "right", leftLanguage: "en", rightLanguage: "en" };
    const loads: unknown[] = [];
    let clears = 0;
    const manager = Object.create(ComparisonPanelManager.prototype) as {
      applySelection(next: typeof selection): Promise<void>;
      handleMessage(message: unknown): Promise<void>;
    };
    Object.assign(manager, {
      getSelection: () => selection,
      normalizeSelection: (next: typeof selection) => next,
      saveSelection: async (next: typeof selection) => { selection = next; },
      postState: async () => undefined,
      clearFieldDiffSelection: async () => { clears += 1; },
      subtreeLoadControllers: new Map(),
      favoriteNavigationGeneration: 0,
      pendingFavoriteReveal: new Map(),
      panel: {},
      connectionStore: { list: () => [{ id: "left" }, { id: "right" }] },
      loadAndPostLanguages: async () => undefined,
      loadTreeLevel: async (side: string, connectionId: string, locator: unknown) => {
        loads.push({ side, connectionId, locator });
      },
    });
    await manager.applySelection({ ...selection, leftLanguage: "fr" });
    deepStrictEqual(loads, [{ side: "left", connectionId: "left", locator: { path: "/" } }]);
    strictEqual(clears, 1);
    for (const type of ["standardPublish", "tracedPublish", "powerPublish"]) {
      await manager.handleMessage({ type, side: "left", itemId: "item", path: "/sitecore/content" });
    }
    await manager.handleMessage({ type: "syncSubtree", rowKey: "row", direction: "leftToRight", sourceItemId: "item", sourcePath: "/sitecore/content" });
    loads.length = 0;
    await manager.applySelection({ ...selection });
    strictEqual(loads.length, 0);
    strictEqual(clears, 1);
    await manager.handleMessage({ type: "loadChildren", side: "left", connectionId: "left", language: "en", itemId: "item" });
    strictEqual(loads.length, 0);
    await manager.handleMessage({ type: "loadChildren", side: "left", connectionId: "left", language: "fr", itemId: "item" });
    strictEqual(loads.length, 1);
    let fieldRefreshes = 0;
    Object.assign(manager, {
      fieldDiffViewProvider: { visible: true },
      refreshFieldDiffView: async () => { fieldRefreshes += 1; },
    });
    await manager.handleMessage({ type: "selectFieldDiffItem", leftItemId: "item", comparisonKey: JSON.stringify(["left", "en", "right", "en"]) });
    strictEqual(fieldRefreshes, 0);
    await manager.handleMessage({ type: "selectFieldDiffItem", leftItemId: "item", comparisonKey: JSON.stringify(["left", "fr", "right", "en"]) });
    strictEqual(fieldRefreshes, 0, "Field Diff remains blocked until the staged view commits");
    await manager.handleMessage({ type: "languageViewReady", comparisonKey: JSON.stringify(["left", "en", "right", "en"]) });
    await manager.handleMessage({ type: "selectFieldDiffItem", leftItemId: "item" });
    strictEqual(fieldRefreshes, 0, "An old acknowledgement cannot unlock the new view");
    await manager.handleMessage({ type: "languageViewReady", comparisonKey: JSON.stringify(["left", "fr", "right", "en"]) });
    await manager.handleMessage({ type: "selectFieldDiffItem", leftItemId: "item", comparisonKey: JSON.stringify(["left", "fr", "right", "en"]) });
    strictEqual(fieldRefreshes, 1);
    loads.length = 0;
    await manager.applySelection({ ...selection, leftLanguage: "de", rightLanguage: "de" });
    strictEqual(loads.length, 2);
    loads.length = 0;
    await manager.applySelection({ ...selection, leftConnectionId: "other" });
    strictEqual(loads.length, 2);
  },
}, {
  name: "site and favorite loading icons survive refresh and remain source- and connection-scoped",
  async execute(): Promise<void> {
    const owner = connection("owner", "Owner");
    const other = connection("other", "Other");
    const path = "/sitecore/content/Example";
    const siteRecord = { name: "Example", rootPath: path, rootItemId: "root" };
    const emitter = new vscode.EventEmitter<void>();
    const provider = new ConnectionTreeProvider({
      onDidChange: emitter.event,
      list: () => [owner, other],
      listFavoritePaths: () => [path],
      listVerifiedSites: () => [siteRecord],
    } as unknown as ConnectionStore);
    const favorite = (index: number): FavoriteTreeItem => {
      const item = provider.getChildren(provider.getChildren()[index])[0];
      if (!(item instanceof FavoriteTreeItem)) {
        throw new Error("Missing favorite");
      }
      return item;
    };
    try {
      const site = (index: number): SiteTreeItem => {
        const item = provider.getChildren(provider.getChildren()[index])[1];
        if (!(item instanceof SiteTreeItem)) {
          throw new Error("Missing site");
        }
        return item;
      };
      const originalSite = site(0);
      const original = favorite(0);
      strictEqual(original.iconPath, undefined);
      provider.setNavigationLoading({ source: "favorite", connectionId: owner.id, path });
      strictEqual((favorite(0).iconPath as vscode.ThemeIcon).id, "sync~spin");
      strictEqual(favorite(1).iconPath, undefined);
      emitter.fire();
      strictEqual((favorite(0).iconPath as vscode.ThemeIcon).id, "sync~spin");
      strictEqual(favorite(0).id, original.id);
      strictEqual(favorite(0).command?.command, "xmCloudSync.openFavorite");
      strictEqual((site(0).iconPath as vscode.ThemeIcon).id, "globe");
      provider.setNavigationLoading({ source: "site", connectionId: owner.id, path });
      strictEqual(favorite(0).iconPath, undefined);
      strictEqual((site(0).iconPath as vscode.ThemeIcon).id, "sync~spin");
      strictEqual((site(1).iconPath as vscode.ThemeIcon).id, "globe");
      emitter.fire();
      strictEqual((site(0).iconPath as vscode.ThemeIcon).id, "sync~spin");
      strictEqual(site(0).id, originalSite.id);
      strictEqual(site(0).command?.command, "xmCloudSync.openSite");
      provider.setNavigationLoading({ source: "favorite", connectionId: owner.id, path });
      strictEqual((site(0).iconPath as vscode.ThemeIcon).id, "globe");
      strictEqual((favorite(0).iconPath as vscode.ThemeIcon).id, "sync~spin");
      provider.setNavigationLoading(undefined);
      strictEqual(favorite(0).iconPath, undefined);
      strictEqual((site(0).iconPath as vscode.ThemeIcon).id, "globe");
    } finally {
      provider.dispose();
      emitter.dispose();
    }
  },
}, ...(["favorite", "site"] as const).map((source): IntegrationTest => ({
  name: `${source} loading clears on completion, errors and cancellation without stale cleanup`,
  async execute(): Promise<void> {
    interface Navigation { readonly navigationId: number }
    const states: unknown[] = [];
    const manager = Object.create(ComparisonPanelManager.prototype) as {
      beginFavoriteNavigation(
        connectionId: string,
        path: string,
        side: string,
        source: "favorite" | "site",
      ): Navigation;
      finishFavoriteNavigation(navigation: Navigation): void;
      navigateToFavorite(navigation: Navigation): Promise<void>;
      cancelRequests(): void;
      handleMessage(message: unknown): Promise<void>;
    };
    Object.assign(manager, {
      favoriteNavigationGeneration: 0,
      navigationLoadingEmitter: { fire: (state: unknown) => states.push(state) },
      pendingFavoriteReveal: new Map(),
      revealFavoriteNavigation: async () => undefined,
      itemIconGeneration: 0,
      subtreeLoadControllers: new Map(),
      requestControllers: new Set(),
      pendingTreeLevels: new Map(),
      pendingLanguages: new Map(),
      pendingItemDetails: new Map(),
      pendingItemIconReferences: new Map(),
      pendingItemIcons: new Map(),
    });
    const first = manager.beginFavoriteNavigation("owner", "/first", "left", source);
    const second = manager.beginFavoriteNavigation("owner", "/second", "left", source);
    manager.finishFavoriteNavigation(first);
    deepStrictEqual(states.at(-1), { source, connectionId: "owner", path: "/second" });
    await manager.navigateToFavorite(second);
    strictEqual(states.at(-1), undefined);
    const failed = manager.beginFavoriteNavigation("owner", "/failed", "left", source);
    Object.assign(manager, {
      revealFavoriteNavigation: async () => { throw new Error("Navigation failed"); },
    });
    await rejects(manager.navigateToFavorite(failed), /Navigation failed/);
    strictEqual(states.at(-1), undefined);
    manager.beginFavoriteNavigation("owner", "/cancelled", "left", source);
    manager.cancelRequests();
    strictEqual(states.at(-1), undefined);
    const initializing = manager.beginFavoriteNavigation("owner", "/initializing", "left", source);
    Object.assign(manager, {
      pendingFavoriteNavigation: initializing,
      postState: async () => { throw new Error("Initialization failed"); },
    });
    await rejects(manager.handleMessage({ type: "ready" }), /Initialization failed/);
    strictEqual(states.at(-1), undefined);
  },
})), {
  name: "site entries retain their connection and expose root navigation",
  async execute(): Promise<void> {
    const owner = connection("owner", "Owner");
    const site = { name: "Example", rootPath: "/sitecore/content/Example", rootItemId: "root" };
    const emitter = new vscode.EventEmitter<void>();
    const provider = new ConnectionTreeProvider({
      onDidChange: emitter.event,
      list: () => [owner],
      listFavoritePaths: () => [],
      listVerifiedSites: () => [site],
    } as unknown as ConnectionStore);
    try {
      const root = provider.getChildren()[0];
      strictEqual(root instanceof ConnectionTreeItem, true);
      const item = provider.getChildren(root)[0];
      strictEqual(item instanceof SiteTreeItem, true);
      if (!(item instanceof SiteTreeItem)) {
        throw new Error("Missing site entry");
      }
      strictEqual(item.connection, owner);
      strictEqual(item.site.rootPath, site.rootPath);
      strictEqual(item.command?.command, "xmCloudSync.openSite");
      deepStrictEqual(item.command?.arguments, [item]);
    } finally {
      provider.dispose();
      emitter.dispose();
    }
  },
}, {
  name: "persists and mirrors the comparison language lock",
  async execute(): Promise<void> {
    const left = connection("left", "Left");
    const right = connection("right", "Right");
    const workspaceState = new MemoryMemento({
      [selectionKey]: {
        leftConnectionId: left.id,
        rightConnectionId: right.id,
        leftLanguage: "en",
        rightLanguage: "EN",
      },
    });
    const languagesByConnection = new Map<string, readonly AuthoringLanguage[]>([
      [left.id, [language("en"), language("fr")]],
      [right.id, [language("EN"), language("FR")]],
    ]);
    const stateEmitter = new vscode.EventEmitter<void>();
    const manager = Object.create(ComparisonPanelManager.prototype) as ComparisonPanelHarness;
    Object.assign(manager, {
      panel: undefined,
      workspaceState,
      connectionStore: {
        list: () => [left, right],
        get: (id: string) => [left, right].find((candidate) => candidate.id === id),
        getClientSecret: async () => "secret",
      },
      authoringClient: {
        loadLanguages: async (candidate: XmCloudConnection) =>
          languagesByConnection.get(candidate.id) ?? [],
      },
      languageCache: new Map(),
      pendingLanguages: new Map(),
      requestControllers: new Set(),
      subtreeLoadControllers: new Map(),
      fieldDiffViewProvider: { clear: async () => undefined },
      comparisonStateEmitter: stateEmitter,
      warnedInvalidLanguageLock: undefined,
      favoriteNavigationGeneration: 0,
      pendingFavoriteReveal: new Map(),
    });

    try {
      await manager.handleMessage({ type: "setLanguageLock", locked: true });
      deepStrictEqual(workspaceState.get(selectionKey), {
        leftConnectionId: left.id,
        rightConnectionId: right.id,
        leftLanguage: "en",
        rightLanguage: "EN",
        languagesLocked: true,
      });

      await manager.handleMessage({ type: "selectLanguage", side: "left", language: "fr" });
      deepStrictEqual(workspaceState.get(selectionKey), {
        leftConnectionId: left.id,
        rightConnectionId: right.id,
        leftLanguage: "fr",
        rightLanguage: "FR",
        languagesLocked: true,
      });

      await manager.handleMessage({ type: "setLanguageLock", locked: false });
      strictEqual(
        (workspaceState.get<Record<string, unknown>>(selectionKey) ?? {}).languagesLocked,
        false,
      );
    } finally {
      stateEmitter.dispose();
    }
  },
}, ...(["left", "right"] as const).map((side): IntegrationTest => ({
  name: `site navigation on the ${side} supersedes an older favorite reveal`,
  async execute(): Promise<void> {
    const left = connection("left", "Left");
    const other = connection("other", "Other");
    const firstPath = "/sitecore/content/First";
    const secondPath = "/sitecore/content/Second";
    const revealAttempts = new Map<string, number>();
    const navigationStarts: Array<Record<string, unknown>> = [];
    const loadingStates: unknown[] = [];
    const loadedLevels: Array<Record<string, unknown>> = [];
    let sitecoreLevelCalls = 0;
    let reportFirstAncestor: (() => void) | undefined;
    let releaseFirstAncestor: (() => void) | undefined;
    const firstAncestorStarted = new Promise<void>((resolve) => {
      reportFirstAncestor = resolve;
    });
    const firstAncestor = new Promise<AuthoringTreeLevel>((resolve) => {
      releaseFirstAncestor = () => resolve(treeLevel("/sitecore", "stale-item"));
    });
    const manager = Object.create(
      ComparisonPanelManager.prototype,
    ) as unknown as ComparisonPanelHarness;
    Object.assign(manager, {
      panel: {
        reveal: () => undefined,
        webview: {
          postMessage: async (message: Record<string, unknown>) => {
            if (message.type === "favoriteNavigationStarted") {
              navigationStarts.push(message);
            } else if (message.type === "treeLoaded") {
              loadedLevels.push(message);
            } else if (
              message.type === "tryRevealFavorite" &&
              typeof message.requestId === "string" &&
              typeof message.path === "string"
            ) {
              const attempt = (revealAttempts.get(message.path) ?? 0) + 1;
              revealAttempts.set(message.path, attempt);
              setImmediate(() => {
                void manager.handleMessage({
                  type: "favoriteRevealResult",
                  requestId: message.requestId,
                  navigationId: message.navigationId,
                  found: attempt > 1,
                });
              });
            }
            return true;
          },
        },
      },
      workspaceState: new MemoryMemento({
        [selectionKey]: {
          [side === "left" ? "rightConnectionId" : "leftConnectionId"]: other.id,
          [`${side}ConnectionId`]: left.id,
          [`${side}Language`]: "en",
        },
      }),
      connectionStore: {
        list: () => [left, other],
        get: (id: string) => [left, other].find((candidate) => candidate.id === id),
      },
      getTreeLevel: async (
        _connectionId: string,
        _language: string,
        locator: { readonly path?: string },
      ) => {
        if (locator.path === "/sitecore") {
          sitecoreLevelCalls += 1;
          if (sitecoreLevelCalls === 1) {
            reportFirstAncestor?.();
            return firstAncestor;
          }
        }
        return treeLevel(locator.path ?? secondPath);
      },
      loadAndPostItemIcons: async () => undefined,
      log: { debug: () => undefined, warn: () => undefined },
      pendingFavoriteReveal: new Map(),
      nextFavoriteRevealId: 1,
      favoriteNavigationGeneration: 0,
      navigationLoadingEmitter: { fire: (state: unknown) => loadingStates.push(state) },
    });

    const firstNavigation = manager.openFavorite(left.id, firstPath);
    await firstAncestorStarted;
    deepStrictEqual(loadingStates, [{ source: "favorite", connectionId: left.id, path: firstPath }]);
    await manager.openSite(left.id, secondPath);
    releaseFirstAncestor?.();
    await firstNavigation;
    deepStrictEqual(loadingStates, [
      { source: "favorite", connectionId: left.id, path: firstPath },
      { source: "site", connectionId: left.id, path: secondPath },
      undefined,
    ]);

    deepStrictEqual(navigationStarts.map((message) => ({
      navigationId: message.navigationId,
      path: message.path,
    })), [{
      navigationId: 1,
      path: firstPath,
    }, {
      navigationId: 2,
      path: secondPath,
    }]);
    strictEqual(navigationStarts[1]?.side, side);
    strictEqual(revealAttempts.get(firstPath), 1);
    strictEqual(revealAttempts.get(secondPath), 2);
    strictEqual(loadedLevels.some((message) => (
      message.level as AuthoringTreeLevel | undefined
    )?.item.itemId === "stale-item"), false);
  },
})), {
  name: "loads comparison item icons once and reuses the bounded caches",
  async execute(): Promise<void> {
    const left = connection("left", "Left");
    const workspaceState = new MemoryMemento({
      [selectionKey]: {
        leftConnectionId: left.id,
        leftLanguage: "en",
      },
    });
    const messages: Array<Record<string, unknown>> = [];
    let referenceCalls = 0;
    let iconCalls = 0;
    const manager = Object.create(
      ComparisonPanelManager.prototype,
    ) as unknown as ComparisonPanelHarness;
    Object.assign(manager, {
      panel: {
        webview: {
          postMessage: async (message: Record<string, unknown>) => {
            messages.push(message);
            return true;
          },
        },
      },
      workspaceState,
      connectionStore: {
        list: () => [left],
        get: (id: string) => id === left.id ? left : undefined,
        getClientSecret: async () => "secret",
      },
      authoringClient: {
        loadItemIconReferences: async (
          _connection: XmCloudConnection,
          _secret: string,
          itemIds: readonly string[],
        ) => {
          referenceCalls += 1;
          await Promise.resolve();
          return itemIds.map((itemId) => ({
            itemId,
            configuredIcon: "Applications/16x16/document.png",
          }));
        },
        loadItemIcon: async () => {
          iconCalls += 1;
          await Promise.resolve();
          return "data:image/png;base64,AQID";
        },
      },
      log: { debug: () => undefined },
      itemIconReferenceCache: new Map(),
      pendingItemIconReferences: new Map(),
      itemIconCache: new Map(),
      pendingItemIcons: new Map(),
      itemIconLoadWaiters: [],
      requestControllers: new Set(),
      activeItemIconLoads: 0,
      itemIconGeneration: 0,
      nextItemIconKey: 1,
    });

    await Promise.all([
      manager.loadAndPostItemIcons("left", left.id, "en", ["{ITEM-1}"]),
      manager.loadAndPostItemIcons("left", left.id, "en", ["{ITEM-1}"]),
    ]);
    await manager.loadAndPostItemIcons("left", left.id, "en", ["{ITEM-1}"]);

    strictEqual(referenceCalls, 1);
    strictEqual(iconCalls, 1);
    strictEqual(messages.length, 3);
    for (const message of messages) {
      strictEqual(message.type, "itemIconsLoaded");
      deepStrictEqual(message.items, [{ itemId: "{ITEM-1}", iconKey: "item-icon-1" }]);
      deepStrictEqual(message.icons, [{
        iconKey: "item-icon-1",
        dataUri: "data:image/png;base64,AQID",
      }]);
    }
  },
}, {
  name: "posts completed comparison icons without waiting for slower icons",
  async execute(): Promise<void> {
    const left = connection("left", "Left");
    const messages: Array<Record<string, unknown>> = [];
    let releaseSlowIcon: (() => void) | undefined;
    let reportFastIcon: (() => void) | undefined;
    const slowIcon = new Promise<void>((resolve) => { releaseSlowIcon = resolve; });
    const fastIconCompleted = new Promise<void>((resolve) => { reportFastIcon = resolve; });
    const manager = Object.create(
      ComparisonPanelManager.prototype,
    ) as unknown as ComparisonPanelHarness;
    Object.assign(manager, {
      panel: {
        webview: {
          postMessage: async (message: Record<string, unknown>) => {
            messages.push(message);
            return true;
          },
        },
      },
      workspaceState: new MemoryMemento({
        [selectionKey]: {
          leftConnectionId: left.id,
          leftLanguage: "en",
        },
      }),
      connectionStore: {
        list: () => [left],
        get: (id: string) => id === left.id ? left : undefined,
        getClientSecret: async () => "secret",
      },
      authoringClient: {
        loadItemIconReferences: async () => [{
          itemId: "fast-item",
          configuredIcon: "Applications/16x16/fast.png",
        }, {
          itemId: "slow-item",
          configuredIcon: "Applications/16x16/slow.png",
        }],
        loadItemIcon: async (
          _connection: XmCloudConnection,
          _secret: string,
          configuredIcon: string,
        ) => {
          if (configuredIcon.endsWith("slow.png")) {
            await slowIcon;
          } else {
            reportFastIcon?.();
          }
          return "data:image/png;base64,AQID";
        },
      },
      log: { debug: () => undefined },
      itemIconReferenceCache: new Map(),
      pendingItemIconReferences: new Map(),
      itemIconCache: new Map(),
      pendingItemIcons: new Map(),
      itemIconLoadWaiters: [],
      requestControllers: new Set(),
      activeItemIconLoads: 0,
      itemIconGeneration: 0,
      nextItemIconKey: 1,
    });

    const loading = manager.loadAndPostItemIcons(
      "left",
      left.id,
      "en",
      ["fast-item", "slow-item"],
    );
    await fastIconCompleted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const messagesBeforeSlowIcon = [...messages];

    releaseSlowIcon?.();
    await loading;

    strictEqual(messagesBeforeSlowIcon.length, 1);
    deepStrictEqual(messagesBeforeSlowIcon[0]?.items, [{
      itemId: "fast-item",
      iconKey: "item-icon-1",
    }]);
    strictEqual(messages.length, 2);
    deepStrictEqual(messages[1]?.items, [{
      itemId: "slow-item",
      iconKey: "item-icon-2",
    }]);
  },
}, {
  name: "keeps optional comparison icon failures out of the tree-loading contract",
  async execute(): Promise<void> {
    const left = connection("left", "Left");
    const messages: Array<Record<string, unknown>> = [];
    let debugCalls = 0;
    const manager = Object.create(
      ComparisonPanelManager.prototype,
    ) as unknown as ComparisonPanelHarness;
    Object.assign(manager, {
      panel: {
        webview: {
          postMessage: async (message: Record<string, unknown>) => {
            messages.push(message);
            return true;
          },
        },
      },
      workspaceState: new MemoryMemento({
        [selectionKey]: {
          leftConnectionId: left.id,
          leftLanguage: "en",
        },
      }),
      connectionStore: {
        list: () => [left],
        get: (id: string) => id === left.id ? left : undefined,
        getClientSecret: async () => "secret",
      },
      authoringClient: {
        loadItemIconReferences: async () => {
          throw new Error("metadata unavailable");
        },
      },
      log: { debug: () => { debugCalls += 1; } },
      itemIconReferenceCache: new Map(),
      pendingItemIconReferences: new Map(),
      itemIconCache: new Map(),
      pendingItemIcons: new Map(),
      itemIconLoadWaiters: [],
      requestControllers: new Set(),
      activeItemIconLoads: 0,
      itemIconGeneration: 0,
      nextItemIconKey: 1,
    });

    await manager.loadAndPostItemIcons("left", left.id, "en", ["item-1"]);

    strictEqual(debugCalls, 1);
    deepStrictEqual(messages, []);
  },
}];

function connection(id: string, name: string): XmCloudConnection {
  return {
    id,
    name,
    serverUrl: `https://${id}.example.test`,
    clientId: `${id}-client`,
    createdAt: "2026-09-12T00:00:00.000Z",
  };
}

function language(name: string): AuthoringLanguage {
  return { name, displayName: name, englishName: name, nativeName: name };
}

function treeLevel(path: string, itemId = `{${path}}`): AuthoringTreeLevel {
  return {
    item: {
      itemId,
      path,
      name: path.split("/").at(-1) ?? path,
      displayName: path.split("/").at(-1) ?? path,
      hasChildren: false,
    },
    children: [],
  };
}

function itemDetails(itemId: string): AuthoringItemDetails {
  return { itemId, name: itemId, displayName: itemId, path: "/sitecore/" + itemId, hasChildren: false,
    language: "fr", version: 1, template: { templateId: "template", name: "Page" }, availableVersions: [], fields: [] };
}
