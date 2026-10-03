import { strictEqual, rejects } from "node:assert/strict";
import { mock } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as vscode from "vscode";
import { McpAccessManager } from "../../src/mcp/accessManager";
import { callBridge } from "../../src/mcp/server";
import { AuthoringContentClient } from "../../src/sitecore/authoringClient";
import { ConnectionStore } from "../../src/connections/connectionStore";
import { MemoryMemento, MemorySecretStorage, type IntegrationTest } from "./testSupport";
import { noOpLogger } from "../unit/sitecoreClientTestHelpers";

export const mcpAccessTests: readonly IntegrationTest[] = [{
  name: "MCP access starts explicitly, reads selected connections with saved credentials and stops/restarts read-only",
  async execute() {
    const directory = await mkdtemp(join(tmpdir(), "xm-mcp-host-"));
    const secrets = new MemorySecretStorage(); const store = new ConnectionStore(new MemoryMemento(), secrets);
    const connection = await store.add({ name: "MCP dev", serverUrl: "https://cm.example.test", clientId: "client", clientSecret: "stored-test-secret" });
    const client = new AuthoringContentClient(noOpLogger);
    const manager = new McpAccessManager({ storageUri: vscode.Uri.file(join(directory, "workspace")), globalStorageUri: vscode.Uri.file(directory),
      workspaceState: new MemoryMemento(), extensionPath: vscode.extensions.getExtension("OzrenTK.sitecore-xm-cloud-sync")!.extensionPath }, store, client);
    const pick = mock.method(vscode.window, "showQuickPick", async (items: readonly unknown[], options: vscode.QuickPickOptions) => options.canPickMany ? [items[0]] : items[0]);
    const info = mock.method(vscode.window, "showInformationMessage", async () => undefined);
    const errors: string[] = []; const error = mock.method(vscode.window, "showErrorMessage", async (message: string) => { errors.push(message); });
    const languages = mock.method(client, "loadLanguages", async (...[actual, secret]: Parameters<AuthoringContentClient["loadLanguages"]>) => {
      strictEqual(actual.id, connection.id); strictEqual(secret, "stored-test-secret"); return [{ name: "en", displayName: "English", nativeName: "English", englishName: "English" }];
    });
    try {
      await manager.start(); strictEqual(errors.length, 0);
      const setup = vscode.window.activeTextEditor!.document.getText();
      strictEqual(setup.includes("stored-test-secret"), false);
      const args = JSON.parse(/^args = (.+)$/mu.exec(setup)![1]!) as string[];
      const file = args[1]!;
      const call = (tool: string, input: unknown) => callBridge(file, tool, input, new AbortController().signal);
      let connections = await call("list_connections", {}) as { mutationsEnabled: boolean }[];
      strictEqual(connections[0]!.mutationsEnabled, false);
      const result = await call("list_languages", { connectionId: connection.id }) as { name: string }[];
      strictEqual(result[0]!.name, "en");
      await manager.enableMutations(); connections = await call("list_connections", {}) as { mutationsEnabled: boolean }[];
      strictEqual(connections[0]!.mutationsEnabled, true);
      await manager.stop(); await rejects(call("list_connections", {}));
      await manager.start(); connections = await call("list_connections", {}) as { mutationsEnabled: boolean }[];
      strictEqual(connections[0]!.mutationsEnabled, false);
      await manager.stop(); strictEqual(errors.length, 0);
    } finally {
      await manager.stop(); manager.dispose(); pick.mock.restore(); info.mock.restore(); error.mock.restore(); languages.mock.restore();
      store.dispose(); secrets.dispose(); client.clear(); await rm(directory, { recursive: true, force: true });
    }
  },
}];
