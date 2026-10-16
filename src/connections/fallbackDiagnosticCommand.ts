import * as vscode from "vscode";
import type { ConnectionStore } from "./connectionStore";
import type { AuthoringContentClient } from "../sitecore/authoringClient";
import { buildFallbackProbes } from "../sitecore/fallbackDiagnostics";

export async function runFallbackDiagnostic(store: ConnectionStore, client: AuthoringContentClient, lifetime?: AbortSignal): Promise<void> {
  try {
    lifetime?.throwIfAborted();
    const connections = store.list();
    if (!connections.length) {
      await vscode.window.showInformationMessage("Add a connection before collecting Authoring diagnostics.");
      return;
    }
    const selected = await vscode.window.showQuickPick(connections.map(connection => ({ label: connection.name, connection })),
      { title: "Authoring fallback diagnostic", placeHolder: "Choose the connection to inspect" });
    if (!selected) { return; }
    const scope = await vscode.window.showQuickPick([
      { label: "Schema only", probes: false },
      { label: "Item probes and fallback configuration", probes: true },
    ], { title: "Authoring fallback diagnostic", placeHolder: "Read-only report; item probes include field content" });
    if (!scope) { return; }
    let selection: { itemId: string; languages: string[] } | undefined;
    if (scope.probes) {
      const itemId = await vscode.window.showInputBox({ ignoreFocusOut: true, title: "Item to inspect", prompt: "Paste the item ID (GUID). Existing content will not be changed.",
        validateInput: value => validate(value.trim(), ["en"]) });
      if (itemId === undefined) { return; }
      const languages = await vscode.window.showInputBox({ ignoreFocusOut: true, title: "Locales to inspect", prompt: "Comma-separated locales: requested locale first, then up to seven candidate locales. These do not assert a fallback chain.",
        placeHolder: "en-NZ, en-AU, en", validateInput: value => validate(itemId.trim(), splitLanguages(value)) });
      if (languages === undefined) { return; }
      selection = { itemId: itemId.trim(), languages: splitLanguages(languages) };
    }
    const connection = store.get(selected.connection.id);
    if (!connection) { throw new Error("Connection removed"); }
    const secret = await store.getClientSecret(connection.id);
    if (!secret) { await vscode.window.showErrorMessage("This connection has no stored client secret."); return; }
    const report = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Collecting Authoring fallback diagnostic", cancellable: true },
      async (progress, token) => {
        const controller = new AbortController();
        const subscription = token.onCancellationRequested(() => controller.abort());
        const cancel = (): void => controller.abort();
        lifetime?.addEventListener("abort", cancel, { once: true });
        if (token.isCancellationRequested || lifetime?.aborted) { controller.abort(); }
        try {
          return await client.collectFallbackDiagnostic(connection, secret, selection, controller.signal, message => progress.report({ message }));
        } finally { subscription.dispose(); lifetime?.removeEventListener("abort", cancel); }
      });
    lifetime?.throwIfAborted();
    const document = await vscode.workspace.openTextDocument({ language: "json", content: report });
    await vscode.window.showTextDocument(document, { preview: false });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") { return; }
    await vscode.window.showErrorMessage("Could not collect the Authoring diagnostic. Check the saved connection and credentials, then retry. No content was changed.");
  }
}

function splitLanguages(value: string): string[] { return value.split(",").map(part => part.trim()); }
function validate(itemId: string, languages: readonly string[]): string | undefined {
  try { buildFallbackProbes(itemId, languages); return undefined; }
  catch (error) { return error instanceof Error ? error.message : "Invalid probe selection."; }
}
