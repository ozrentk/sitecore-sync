import { strictEqual } from "node:assert/strict";
import { mock } from "node:test";
import * as vscode from "vscode";
import { FallbackFixtureCommands } from "../../src/connections/fallbackFixtureCommands";
import { ConnectionStore } from "../../src/connections/connectionStore";
import { AuthoringContentClient, type AuthoringItemDetails } from "../../src/sitecore/authoringClient";
import { MemoryMemento, MemorySecretStorage, type IntegrationTest } from "./testSupport";
import { noOpLogger } from "../unit/sitecoreClientTestHelpers";

export const fallbackFixtureTests: readonly IntegrationTest[] = [{
  name: "fallback fixture commands confirm creation, persist recovery and diagnose after reload",
  async execute() {
    const secrets = new MemorySecretStorage(); const state = new MemoryMemento();
    const store = new ConnectionStore(new MemoryMemento(), secrets);
    const client = new AuthoringContentClient(noOpLogger);
    await store.add({ name: "Fixture dev", serverUrl: "https://cm.example.test", clientId: "fixture", clientSecret: "fixture-secret" });
    const id = "00000000-0000-0000-0000-000000000001";
    const details: AuthoringItemDetails = { itemId: id, name: "Test", displayName: "Test", path: "/sitecore/content/Test",
      language: "en", version: 1, hasChildren: false, availableVersions: [], template: { templateId: id, name: "Page" },
      fields: [{ fieldId: id, name: "Title", label: "Title", value: "original", type: "Single-Line Text", typeKey: "single-line text", scope: "VERSIONED",
        sortOrder: 0, sectionName: "Content", sectionSortOrder: 0, isStandardTemplate: false, containsFallbackValue: false,
        containsInheritedValue: false, containsStandardValue: false, textual: true }] };
    const picks = mock.method(vscode.window, "showQuickPick", async (items: readonly unknown[]) => items[0]);
    let inputs = 0; const input = mock.method(vscode.window, "showInputBox", async () => ++inputs % 3 === 0 ? "en-NZ, en-AU, en" : id);
    let confirm = false;
    const warning = mock.method(vscode.window, "showWarningMessage", async () => confirm ? "Create test items" : undefined);
    const load = mock.method(client, "loadItemDetails", async () => details);
    let creations = 0;
    const create = mock.method(client, "createItem", async (...[, secret, request]: Parameters<AuthoringContentClient["createItem"]>) => {
      strictEqual(secret, "fixture-secret"); strictEqual(state.updateCalls > 0, true); creations++;
      return { ...details, name: request.name, path: `${details.path}/${request.name}` };
    });
    let reads = 0;
    const diagnostic = mock.method(client, "collectFallbackDiagnostic", async (...[, secret, selection]: Parameters<AuthoringContentClient["collectFallbackDiagnostic"]>) => {
      strictEqual(secret, "fixture-secret"); strictEqual(selection?.languages[0], "en-NZ"); reads++; return '{"formatVersion":2}';
    });
    const errors: string[] = []; const error = mock.method(vscode.window, "showErrorMessage", async (message: string) => { errors.push(message); });
    try {
      const commands = new FallbackFixtureCommands(store, client, state, new AbortController().signal);
      await commands.run(false); strictEqual(creations, 0); strictEqual(state.updateCalls, 0);
      confirm = true; await commands.run(false); strictEqual(creations, 4);
      strictEqual(vscode.window.activeTextEditor?.document.isUntitled, true);
      const report = JSON.parse(vscode.window.activeTextEditor!.document.getText()) as { fixtures: { status: string }[] };
      strictEqual(report.fixtures.every(fixture => fixture.status === "created"), true);
      await new FallbackFixtureCommands(store, client, state, new AbortController().signal).run(true);
      strictEqual(reads, 4); strictEqual(errors.length, 0);
      create.mock.mockImplementation(async () => { throw new Error("remote outcome unknown"); });
      await commands.run(false);
      const failed = JSON.parse(vscode.window.activeTextEditor!.document.getText()) as { fixtures: { status: string }[] };
      strictEqual(failed.fixtures[0].status, "outcome-unknown"); strictEqual(failed.fixtures[1].status, "planned");
      strictEqual(errors.length, 1);
    } finally {
      picks.mock.restore(); input.mock.restore(); warning.mock.restore(); load.mock.restore(); create.mock.restore(); diagnostic.mock.restore(); error.mock.restore();
      store.dispose(); secrets.dispose(); client.clear();
    }
  },
}];
