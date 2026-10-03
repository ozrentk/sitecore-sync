import { strictEqual, deepStrictEqual } from "node:assert/strict";
import { mock } from "node:test";
import * as vscode from "vscode";
import { runFallbackDiagnostic } from "../../src/connections/fallbackDiagnosticCommand";
import { ConnectionStore } from "../../src/connections/connectionStore";
import { AuthoringContentClient } from "../../src/sitecore/authoringClient";
import { MemoryMemento, MemorySecretStorage, type IntegrationTest } from "./testSupport";
import { noOpLogger } from "../unit/sitecoreClientTestHelpers";

export const fallbackDiagnosticTests: readonly IntegrationTest[] = [{
  name: "fallback diagnostic uses stored credentials and opens an unsaved JSON report; cancellation is quiet",
  async execute() {
    const secrets = new MemorySecretStorage();
    const store = new ConnectionStore(new MemoryMemento(), secrets);
    const client = new AuthoringContentClient(noOpLogger);
    const connection = await store.add({ name: "Diagnostic fixture", serverUrl: "https://cm.example.test", clientId: "fixture", clientSecret: "fixture-secret" });
    let cancel = false;
    let probeScope = false;
    const selectionCalls: unknown[] = [];
    const pick = mock.method(vscode.window, "showQuickPick", async (items: readonly { connection?: unknown; probes?: boolean }[]) =>
      items[0]?.connection ? items[0] : items[probeScope ? 1 : 0]);
    let inputIndex = 0;
    const input = mock.method(vscode.window, "showInputBox", async () =>
      inputIndex++ % 2 === 0 ? "00000000-0000-0000-0000-000000000001" : "en-NZ, en");
    const errors: string[] = [];
    const error = mock.method(vscode.window, "showErrorMessage", async (message: string) => { errors.push(message); });
    const collect = mock.method(client, "collectFallbackDiagnostic", async (...[actual, secret, selection]: Parameters<AuthoringContentClient["collectFallbackDiagnostic"]>) => {
      strictEqual(actual.id, connection.id); strictEqual(secret, "fixture-secret");
      selectionCalls.push(selection);
      if (cancel) { throw new DOMException("Cancelled", "AbortError"); }
      return JSON.stringify({ formatVersion: 1, schema: { status: "complete" }, observations: [] });
    });
    try {
      await runFallbackDiagnostic(store, client);
      strictEqual(vscode.window.activeTextEditor?.document.isUntitled, true);
      strictEqual(vscode.window.activeTextEditor?.document.languageId, "json");
      strictEqual(JSON.parse(vscode.window.activeTextEditor!.document.getText()).formatVersion, 1);
      deepStrictEqual(selectionCalls, [undefined]);
      probeScope = true;
      await runFallbackDiagnostic(store, client);
      deepStrictEqual(selectionCalls[1], { itemId: "00000000-0000-0000-0000-000000000001", languages: ["en-NZ", "en"] });
      cancel = true;
      await runFallbackDiagnostic(store, client);
      strictEqual(errors.length, 0);
    } finally {
      pick.mock.restore(); input.mock.restore(); error.mock.restore(); collect.mock.restore();
      store.dispose(); secrets.dispose(); client.clear();
    }
  },
}];
