import { strictEqual, rejects } from "node:assert/strict";
import { mock } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as vscode from "vscode";
import { McpAccessManager } from "../../src/mcp/accessManager";
import { callBridge } from "../../src/mcp/server";
import { AuthoringContentClient, type AuthoringItemDetails } from "../../src/sitecore/authoringClient";
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
    const itemId = "00000000-0000-0000-0000-000000000001";
    let details: AuthoringItemDetails = { itemId, name: "Test", displayName: "Test", path: "/sitecore/content/Test",
      language: "en", version: 0, hasChildren: false, template: { templateId: itemId, name: "Page" }, availableVersions: [], fields: [] };
    const read = mock.method(client, "loadItem", async () => details);
    const validate = mock.method(client, "validateAddItemVersion", async () => undefined);
    const confirm = mock.method(vscode.window, "showWarningMessage", async () => undefined);
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
      const versionPlan = await call("preview_language_version", { connectionId: connection.id, item: itemId, language: "en" }) as { planId: string };
      strictEqual(validate.mock.callCount(), 1);
      await rejects(call("execute_plan", { planId: versionPlan.planId }), /cancelled/u);
      details = { ...details, version: 1, fields: [{ fieldId: itemId, name: "Title", label: "Title", value: "local",
        scope: "VERSIONED", type: "Single-Line Text", typeKey: "text", textual: true, isStandardTemplate: false,
        containsFallbackValue: false, containsInheritedValue: false, containsStandardValue: false,
        sortOrder: 0, sectionSortOrder: 0, sectionName: "Content" }] };
      const resetPlan = await call("preview_field_reset", { connectionId: connection.id, item: itemId, language: "en", version: 1, fieldId: itemId }) as { planId: string };
      await rejects(call("execute_plan", { planId: resetPlan.planId }), /cancelled/u);
      strictEqual(confirm.mock.callCount(), 2);
      const explicitVersion = await call("read_item", { connectionId: connection.id, item: itemId, language: "en", version: 1 }) as AuthoringItemDetails;
      strictEqual(explicitVersion.version, 1);
      await rejects(call("preview_scope_version", { connectionId: connection.id,
        fixtureId: "00000000-0000-4000-8000-000000000001", language: "en" }), /completed isolated/u);
      await manager.stop(); await rejects(call("list_connections", {}));
      await manager.start(); connections = await call("list_connections", {}) as { mutationsEnabled: boolean }[];
      strictEqual(connections[0]!.mutationsEnabled, false);
      await manager.stop(); strictEqual(errors.length, 0);
    } finally {
      await manager.stop(); manager.dispose(); pick.mock.restore(); info.mock.restore(); error.mock.restore(); languages.mock.restore();
      read.mock.restore(); validate.mock.restore(); confirm.mock.restore();
      store.dispose(); secrets.dispose(); client.clear(); await rm(directory, { recursive: true, force: true });
    }
  },
}];
