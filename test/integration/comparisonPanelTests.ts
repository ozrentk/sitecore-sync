import { deepStrictEqual, strictEqual } from "node:assert/strict";
import * as vscode from "vscode";
import { ComparisonPanelManager } from "../../src/comparison/comparisonPanel";
import {
  SiteTreeItem,
  ConnectionTreeProvider,
  ConnectionTreeItem,
} from "../../src/connections/connectionTreeProvider";
import type { ConnectionStore } from "../../src/connections/connectionStore";
import type { XmCloudConnection } from "../../src/connections/connection";
import type {
  AuthoringLanguage,
  AuthoringTreeLevel,
} from "../../src/sitecore/authoringClient";
import { MemoryMemento, type IntegrationTest } from "./testSupport";

const selectionKey = "sitecoreXmCloudSync.comparisonSelection.v1";

interface ComparisonPanelHarness {
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
    });

    const firstNavigation = manager.openFavorite(left.id, firstPath);
    await firstAncestorStarted;
    await manager.openSite(left.id, secondPath);
    releaseFirstAncestor?.();
    await firstNavigation;

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
