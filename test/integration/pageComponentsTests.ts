import * as vscode from "vscode";
import { strictEqual, match, doesNotMatch, rejects } from "node:assert/strict";
import { mock } from "node:test";
import { PageComponentsPanel } from "../../src/editor/pageComponentsPanel";
import type { ConnectionStore } from "../../src/connections/connectionStore";
import type { AuthoringContentClient } from "../../src/sitecore/authoringClient";
import type { IntegrationTest } from "./testSupport";
const id = "11111111111111111111111111111111";
function dependencies() {
  const connection = { id: "test", name: "Test", serverUrl: "https://example.test", clientId: "client" };
  return {
    connection,
    connections: {
      get: () => connection, getClientSecret: async () => "authoring-secret", getPreviewToken: async () => "preview-secret",
      listVerifiedSites: () => [{ name: "Example", rootPath: "/sitecore/content/Example" }],
    } as unknown as ConnectionStore,
    authoring: {
      loadItem: async () => ({ itemId: id, name: "Page", displayName: "Page", path: "/sitecore/content/Example/home/Page" }),
      loadLanguages: async () => [{ name: "en" }, { name: "en-AU" }],
    } as unknown as AuthoringContentClient,
  };
}
const report = { status: "collected", rendered: { sitecore: {
  context: { site: { name: "Example" }, language: "en" },
  route: { itemId: id, name: "Page", databaseName: "master", itemLanguage: "en", itemVersion: 1,
    placeholders: { main: [{ uid: id, componentName: "<RichText>", dataSource: "", isContentResolved: true }] } },
} } };
export const pageComponentsTests: readonly IntegrationTest[] = [{
  name: "page components opens an isolated read-only webview with validated Preview context",
  async execute() {
    const { connections, authoring } = dependencies();
    let panel: vscode.WebviewPanel | undefined;
    const original = vscode.window.createWebviewPanel;
    const spy = mock.method(vscode.window, "createWebviewPanel", (...args: Parameters<typeof original>) => {
      panel = original(...args); return panel;
    });
    const provider = new PageComponentsPanel(connections, authoring, { collect: async (_origin, token, selection) => {
      strictEqual(token, "preview-secret"); strictEqual(selection.route, "/Page"); return report;
    } });
    try {
      await provider.open({ connectionId: "test", itemId: id, language: "en" });
      match(panel!.webview.html, /&lt;RichText&gt;/u);
      match(panel!.webview.html, /Source locale: unknown/u);
      match(panel!.webview.html, /default-src 'none'/u);
      doesNotMatch(panel!.webview.html, /preview-secret|authoring-secret|<RichText>/u);
      strictEqual(panel!.webview.options.localResourceRoots?.length, 0);
    } finally { provider.dispose(); spy.mock.restore(); }
  },
}, {
  name: "closing page components cancels an outstanding Preview read",
  async execute() {
    const { connections, authoring } = dependencies();
    let panel: vscode.WebviewPanel | undefined, received: AbortSignal | undefined;
    let started!: () => void;
    const startedPromise = new Promise<void>(resolve => { started = resolve; });
    const original = vscode.window.createWebviewPanel;
    const spy = mock.method(vscode.window, "createWebviewPanel", (...args: Parameters<typeof original>) => {
      panel = original(...args); return panel;
    });
    const provider = new PageComponentsPanel(connections, authoring, { collect: async (_origin, _token, _selection, signal) => {
      received = signal; started();
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Error("cancelled")), { once: true }));
    } });
    try {
      const opening = provider.open({ connectionId: "test", itemId: id, language: "en" });
      await startedPromise;
      panel!.dispose();
      await opening;
      strictEqual(received!.aborted, true);
      await rejects(provider.open({ connectionId: "test", itemId: "invalid", language: "en" }));
    } finally { provider.dispose(); spy.mock.restore(); }
  },
}];
