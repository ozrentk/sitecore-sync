import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import type { ConnectionStore } from "./connectionStore";
import type { AuthoringContentClient } from "../sitecore/authoringClient";
import { buildFallbackProbes } from "../sitecore/fallbackDiagnostics";
import { createFallbackFixtures, fixtureGuid, planFallbackFixtures, type FallbackFixture } from "../sitecore/fallbackFixtures";

interface FixtureRun {
  readonly id: string;
  readonly connectionId: string;
  readonly serverUrl: string;
  readonly languages: string[];
  readonly fixtures: FallbackFixture[];
}
const key = "xmCloudSync.fallbackFixtureRuns";

export class FallbackFixtureCommands {
  private running = false;
  constructor(private readonly store: ConnectionStore, private readonly client: AuthoringContentClient,
    private readonly state: vscode.Memento, private readonly lifetime: AbortSignal) {}

  async run(diagnostic: boolean): Promise<void> {
    if (this.running) { await vscode.window.showInformationMessage("A fallback test command is already running."); return; }
    this.running = true;
    try {
      this.lifetime.throwIfAborted();
      if (diagnostic) { await this.diagnose(); } else { await this.create(); }
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) {
        await vscode.window.showErrorMessage("Fallback test command stopped. Check the saved connection and the test-run report before retrying; a failed creation may have completed remotely.");
      }
    } finally { this.running = false; }
  }

  private async create(): Promise<void> {
    const chosen = await vscode.window.showQuickPick(this.store.list().map(connection => ({ label: connection.name, connection })),
      { title: "Create fallback test items", placeHolder: "Choose the development connection" });
    if (!chosen) { return; }
    const parentId = await this.askId("Parent for new test items", "Existing content parent ID. Four new children will be created here.");
    if (!parentId) { return; }
    const exampleId = await this.askId("Representative page or component", "Existing item ID whose template should be used. Its values will not be copied.");
    if (!exampleId) { return; }
    const localeText = await vscode.window.showInputBox({ title: "Test locales", value: "en-NZ, en-AU, en",
      prompt: "Requested locale first, source locale last. Use the configured chain.", validateInput: value => {
        try { const locales = value.split(",").map(part => part.trim()); buildFallbackProbes(parentId, locales);
          return locales.length < 2 ? "Supply at least two locales." : undefined;
        } catch { return "Supply 2–8 distinct locale names."; }
      } });
    if (localeText === undefined) { return; }
    const languages = localeText.split(",").map(part => part.trim());
    buildFallbackProbes(parentId, languages);
    const connection = this.store.get(chosen.connection.id);
    if (!connection) { throw new Error("Connection removed"); }
    const secret = await this.store.getClientSecret(connection.id);
    if (!secret) { throw new Error("Missing credentials"); }
    const [parent, example] = await this.progress("Inspecting test template", async signal => Promise.all([
      this.client.loadItemDetails(connection, secret, parentId, languages.at(-1)!, signal),
      this.client.loadItemDetails(connection, secret, exampleId, languages.at(-1)!, signal),
    ]));
    const field = await vscode.window.showQuickPick(example.fields.filter(candidate => !candidate.name.startsWith("__")
      && !candidate.isStandardTemplate && candidate.scope === "VERSIONED"
      && ["single-line text", "multi-line text", "rich text"].includes(candidate.type.toLowerCase()))
      .map(candidate => ({ label: candidate.name, description: candidate.type })),
    { title: "Field for test markers", placeHolder: "Choose a versioned text field; template fallback rules stay unchanged" });
    if (!field) { return; }
    const run: FixtureRun = { id: randomUUID().replace(/-/gu, "").slice(0, 12), connectionId: connection.id,
      serverUrl: connection.serverUrl, languages, fixtures: [] };
    run.fixtures.push(...planFallbackFixtures(parent.itemId, parent.path, example.template.templateId, field.label, languages, run.id));
    const runs = this.state.get<FixtureRun[]>(key, []);
    const confirmation = await vscode.window.showWarningMessage(`Create four fallback test items on ${connection.name}?`,
      { modal: true, detail: `Parent: ${parent.path}\nTemplate: ${example.template.name}\nField: ${field.label}\n\nSource-only items in ${languages.at(-1)} with item fallback enabled/disabled; local value/empty controls in ${languages[0]}. No publishing or template changes. Created items remain for inspection.` }, "Create test items");
    if (confirmation !== "Create test items") { return; }
    const current = this.store.get(connection.id);
    if (!current || current.serverUrl !== connection.serverUrl || current.clientId !== connection.clientId) { throw new Error("Connection changed"); }
    runs.push(run);
    const checkpoint = (): Thenable<void> => this.state.update(key, runs);
    await checkpoint();
    try {
      await this.progress("Creating fallback test items", signal => createFallbackFixtures(run.fixtures,
        input => this.client.createItem(connection, secret, input, signal), async () => checkpoint(), signal));
    } finally { await this.show(run); }
  }

  private async diagnose(): Promise<void> {
    const runs = this.state.get<FixtureRun[]>(key, []);
    const chosen = await vscode.window.showQuickPick(runs.map(run => ({ label: run.id,
      description: `${run.fixtures.filter(fixture => fixture.status === "created").length}/4 created`, run })),
    { title: "Diagnose fallback test items", placeHolder: "Choose a recorded test run" });
    if (!chosen) { return; }
    const run = chosen.run;
    const connection = this.store.get(run.connectionId);
    if (!connection || connection.serverUrl !== run.serverUrl) { throw new Error("Test connection changed"); }
    const secret = await this.store.getClientSecret(connection.id);
    if (!secret) { throw new Error("Missing credentials"); }
    const observations: unknown[] = [];
    try {
      await this.progress("Diagnosing fallback test items", async signal => {
        for (const fixture of run.fixtures) {
          if (fixture.status !== "created" || !fixture.itemId) { continue; }
          signal.throwIfAborted();
          const report = await this.client.collectFallbackDiagnostic(connection, secret,
            { itemId: fixtureGuid(fixture.itemId), languages: run.languages }, signal);
          observations.push({ name: fixture.input.name, report: JSON.parse(report) as unknown });
        }
      });
    } finally { await this.show({ run, observations, notice: "Independent observations, not verified provenance. Only confirmed creations were probed. Unknown outcomes require inspection at their recorded paths before retrying. Empty controls have no candidate-language version; mixed-language and reset-versus-empty tests remain separate." }); }
  }

  private async askId(title: string, prompt: string): Promise<string | undefined> {
    const value = await vscode.window.showInputBox({ title, prompt, validateInput: input => {
      try { buildFallbackProbes(fixtureGuid(input.trim()), ["en"]); return undefined; } catch { return "Supply an item GUID."; }
    } });
    return value === undefined ? undefined : fixtureGuid(value.trim());
  }

  private async show(value: unknown): Promise<void> {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: "json", content: JSON.stringify(value, null, 2) }), { preview: false });
  }

  private async progress<T>(title: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (_progress, token) => {
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      const subscription = token.onCancellationRequested(abort);
      this.lifetime.addEventListener("abort", abort, { once: true });
      if (token.isCancellationRequested || this.lifetime.aborted) { abort(); }
      try { controller.signal.throwIfAborted(); return await work(controller.signal); }
      finally { subscription.dispose(); this.lifetime.removeEventListener("abort", abort); }
    });
  }
}
