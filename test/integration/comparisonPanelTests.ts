import { deepStrictEqual, strictEqual } from "node:assert/strict";
import * as vscode from "vscode";
import { ComparisonPanelManager } from "../../src/comparison/comparisonPanel";
import type { XmCloudConnection } from "../../src/connections/connection";
import type { AuthoringLanguage } from "../../src/sitecore/authoringClient";
import { MemoryMemento, type IntegrationTest } from "./testSupport";

const selectionKey = "sitecoreXmCloudSync.comparisonSelection.v1";

interface ComparisonPanelHarness {
  handleMessage(message: unknown): Promise<void>;
  loadAndPostItemIcons(
    side: "left" | "right",
    connectionId: string,
    language: string,
    itemIds: readonly string[],
  ): Promise<void>;
}

export const comparisonPanelTests: readonly IntegrationTest[] = [{
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
}, {
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
