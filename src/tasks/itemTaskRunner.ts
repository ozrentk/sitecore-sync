import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import * as vscode from "vscode";
import type { ConnectionStore, SpeCredential } from "../connections/connectionStore";
import type {
  AuthoringContentClient,
  AuthoringItemDetails,
} from "../sitecore/authoringClient";
import {
  itemAncestorPaths,
  matchesItem,
  parseItemTaskManifest,
  validateNumberInput,
  type ItemTaskInputValue,
  type ItemTaskPlugin,
} from "./itemTaskManifest";
import { JavaScriptTaskHost } from "./javascriptTaskHost";

const maximumManifestCount = 200;
const speInstallCommand = "Install-Module -Name SPE -Scope CurrentUser";
const speGalleryUrl = "https://www.powershellgallery.com/packages/SPE";

interface ItemTaskResult {
  readonly status?: unknown;
  readonly message?: unknown;
}

export interface ItemTaskCandidateContext {
  readonly side: "left" | "right";
  readonly connection: {
    readonly id: string;
    readonly name: string;
    readonly serverUrl: string;
  };
  readonly language: string;
  readonly item: AuthoringItemDetails & {
    readonly name: string;
    readonly displayName: string;
    readonly hasChildren: boolean;
  };
}

interface ItemTaskExecutionContext extends ItemTaskCandidateContext {
  readonly schemaVersion: 1;
  readonly task: {
    readonly id: string;
    readonly name: string;
  };
  readonly parentPath?: string;
  readonly ancestorPaths: readonly string[];
  readonly inputs: Readonly<Record<string, ItemTaskInputValue>>;
}

interface TaskChoice extends vscode.QuickPickItem {
  readonly plugin: ItemTaskPlugin;
  readonly context: ItemTaskCandidateContext;
}

interface ProcessResult {
  readonly exitCode: number | null;
  readonly cancelled: boolean;
  readonly outputText: string;
}

export class ItemTaskRunner implements vscode.Disposable {
  private running = false;
  private readonly javaScriptHost: JavaScriptTaskHost;

  constructor(
    private readonly storageUri: vscode.Uri,
    private readonly extensionUri: vscode.Uri,
    private readonly connectionStore: ConnectionStore,
    authoringClient: AuthoringContentClient,
    private readonly output: vscode.OutputChannel,
  ) {
    this.javaScriptHost = new JavaScriptTaskHost(authoringClient);
  }

  async selectAndRun(candidates: readonly ItemTaskCandidateContext[]): Promise<void> {
    if (this.running) {
      await vscode.window.showInformationMessage(
        "Another item task is already running. Wait for it to finish or cancel it first.",
      );
      return;
    }
    if (!vscode.workspace.isTrusted) {
      await vscode.window.showWarningMessage(
        "Item tasks execute workspace PowerShell scripts and require a trusted workspace.",
      );
      return;
    }
    const plugins = await this.discoverPlugins();
    const choices: TaskChoice[] = [];
    for (const candidate of candidates) {
      for (const plugin of plugins) {
        if (matchesItem(plugin.matches, candidate.item)) {
          choices.push({
            label: plugin.name,
            description: `${capitalize(candidate.side)} · ${candidate.connection.name} · ${candidate.language}`,
            detail: `${candidate.item.path}${plugin.description ? ` — ${plugin.description}` : ""}`,
            plugin,
            context: candidate,
          });
        }
      }
    }
    if (choices.length === 0) {
      await vscode.window.showInformationMessage(
        plugins.length === 0
          ? "No item task plug-ins were found under .xm-cloud-sync/tasks."
          : "No item task plug-ins match this item on either side.",
      );
      return;
    }
    const choice = await vscode.window.showQuickPick(choices, {
      title: "Run item task",
      placeHolder: "Select a task and comparison side",
      matchOnDescription: true,
      matchOnDetail: true,
      ignoreFocusOut: true,
    });
    if (!choice) {
      return;
    }
    await this.run(choice.plugin, choice.context);
  }

  dispose(): void {
    this.output.dispose();
  }

  private async discoverPlugins(): Promise<readonly ItemTaskPlugin[]> {
    const manifests = await this.findTaskManifests();
    const plugins: ItemTaskPlugin[] = [];
    const ids = new Set<string>();
    let invalidManifestCount = 0;
    for (const manifestUri of [...manifests].sort((left, right) =>
      left.fsPath.localeCompare(right.fsPath, undefined, { sensitivity: "base" })
    )) {
      try {
        const plugin = await readPlugin(manifestUri);
        if (ids.has(plugin.id.toLowerCase())) {
          throw new Error(`Duplicate task ID “${plugin.id}”.`);
        }
        ids.add(plugin.id.toLowerCase());
        plugins.push(plugin);
      } catch (error: unknown) {
        invalidManifestCount += 1;
        this.output.appendLine(`[manifest] ${manifestUri.fsPath}: ${errorMessage(error)}`);
      }
    }
    if (invalidManifestCount > 0 && plugins.length === 0) {
      this.output.show(true);
    }
    return plugins.sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
    );
  }

  private async findTaskManifests(): Promise<readonly vscode.Uri[]> {
    const manifests: vscode.Uri[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const taskRoot = vscode.Uri.joinPath(folder.uri, ".xm-cloud-sync", "tasks");
      try {
        await collectTaskManifests(taskRoot, manifests);
      } catch (error: unknown) {
        if (!isFileNotFound(error)) {
          this.output.appendLine(
            `[discovery] ${taskRoot.fsPath}: ${errorMessage(error)}`,
          );
        }
      }
      if (manifests.length >= maximumManifestCount) {
        this.output.appendLine(
          `[discovery] Stopped after ${maximumManifestCount} task manifests.`,
        );
        break;
      }
    }
    return manifests.slice(0, maximumManifestCount);
  }

  private async run(
    plugin: ItemTaskPlugin,
    candidate: ItemTaskCandidateContext,
  ): Promise<void> {
    if (this.running) {
      await vscode.window.showInformationMessage("Another item task is already running.");
      return;
    }
    this.running = true;
    const runId = randomUUID();
    const runDirectory = vscode.Uri.joinPath(this.storageUri, "task-runs", runId);
    const contextUri = vscode.Uri.joinPath(runDirectory, "context.json");
    const resultUri = vscode.Uri.joinPath(runDirectory, "result.json");
    try {
      if (
        plugin.execution.type === "spe-remoting" &&
        !await this.ensureSpeModuleAvailable(plugin.directoryPath)
      ) {
        return;
      }
      const inputs = await promptForTaskInputs(plugin);
      if (!inputs) {
        return;
      }
      let speCredential = plugin.execution.type === "spe-remoting"
        ? await this.getOrPromptForSpeCredential(candidate, false)
        : undefined;
      if (plugin.execution.type === "spe-remoting" && !speCredential) {
        return;
      }
      const ancestorPaths = itemAncestorPaths(candidate.item.path);
      const executionContext: ItemTaskExecutionContext = {
        schemaVersion: 1,
        task: { id: plugin.id, name: plugin.name },
        ...candidate,
        parentPath: ancestorPaths.at(-1),
        ancestorPaths,
        inputs,
      };
      await vscode.workspace.fs.createDirectory(runDirectory);
      await vscode.workspace.fs.writeFile(
        contextUri,
        encodeUtf8WithBom(`${JSON.stringify(executionContext, null, 2)}\n`),
      );

      this.output.clear();
      this.output.appendLine(`*** Starting task: ${plugin.name} (${plugin.id})... ***`);
      this.output.appendLine(`Script: ${plugin.scriptPath}`);
      this.output.appendLine(`Item path: ${candidate.item.path}`);
      this.output.appendLine(
        `Context: ${candidate.connection.name} · ${candidate.language} · v${candidate.item.version}`,
      );
      this.output.appendLine("");
      this.output.show(true);

      let declaredResult: ItemTaskResult | undefined;
      let processResult: ProcessResult;
      if (plugin.execution.type === "javascript") {
        const connection = this.connectionStore.get(candidate.connection.id);
        const clientSecret = await this.connectionStore.getClientSecret(candidate.connection.id);
        if (!connection || !clientSecret) {
          throw new Error("The selected XM Cloud connection or its credentials are unavailable.");
        }
        const javaScriptOutcome = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Running item task “${plugin.name}”`,
            cancellable: true,
          },
          async (_progress, token) => await this.javaScriptHost.run({
            workerPath: vscode.Uri.joinPath(
              this.extensionUri,
              "out",
              "javascriptTaskWorker.js",
            ).fsPath,
            scriptPath: plugin.scriptPath,
            workingDirectory: plugin.directoryPath,
            context: executionContext,
            connection,
            clientSecret,
            defaultLanguage: candidate.language,
            cancellationToken: token,
            output: this.output,
          }),
        );
        declaredResult = javaScriptOutcome.result;
        processResult = {
          exitCode: javaScriptOutcome.exitCode,
          cancelled: javaScriptOutcome.cancelled,
          outputText: "",
        };
      } else {
        processResult = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Running item task “${plugin.name}”`,
            cancellable: plugin.execution.type === "powershell",
          },
          async (_progress, token) => await this.runPowerShell(
            plugin,
            contextUri.fsPath,
            resultUri.fsPath,
            token,
            speCredential,
          ),
        );
      }
      if (
        plugin.execution.type === "spe-remoting" &&
        !processResult.cancelled &&
        isAuthenticationFailure(processResult) &&
        speCredential
      ) {
        const replace = await vscode.window.showWarningMessage(
          `SPE authentication failed for ${candidate.connection.name}.`,
          "Replace Credentials",
        );
        if (replace === "Replace Credentials") {
          speCredential = await this.getOrPromptForSpeCredential(candidate, true);
          if (!speCredential) {
            return;
          }
          await vscode.workspace.fs.delete(resultUri, { useTrash: false }).then(
            () => undefined,
            () => undefined,
          );
          processResult = await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `Retrying item task “${plugin.name}”`,
              cancellable: false,
            },
            async (_progress, token) => await this.runPowerShell(
              plugin,
              contextUri.fsPath,
              resultUri.fsPath,
              token,
              speCredential,
            ),
          );
        }
      }
      if (processResult.cancelled) {
        this.output.appendLine("\nTask cancelled.");
        await vscode.window.showInformationMessage(`Task “${plugin.name}” was cancelled.`);
        return;
      }
      declaredResult ??= await readTaskResult(resultUri);
      const declaredStatus = typeof declaredResult?.status === "string"
        ? declaredResult.status.trim().toLowerCase()
        : undefined;
      const declaredError = ["error", "failed", "failure"].includes(declaredStatus ?? "");
      const failed = processResult.exitCode !== 0 || declaredError;
      const message = typeof declaredResult?.message === "string" && declaredResult.message.trim()
        ? declaredResult.message.trim()
        : failed
          ? `PowerShell exited with code ${processResult.exitCode ?? "unknown"}.`
          : "Task completed successfully.";
      this.output.appendLine(`\n${failed ? "ERROR" : "OK"}: ${message}`);
      if (failed) {
        await vscode.window.showErrorMessage(`Task “${plugin.name}” failed: ${message}`);
      } else {
        await vscode.window.showInformationMessage(`Task “${plugin.name}” finished: ${message}`);
      }
    } catch (error: unknown) {
      const message = errorMessage(error);
      this.output.appendLine(`\nERROR: ${message}`);
      await vscode.window.showErrorMessage(`Task “${plugin.name}” failed: ${message}`);
    } finally {
      await vscode.workspace.fs.delete(runDirectory, { recursive: true, useTrash: false }).then(
        () => undefined,
        (error: unknown) => this.output.appendLine(
          `Warning: could not remove temporary task context: ${errorMessage(error)}`,
        ),
      );
      this.running = false;
    }
  }

  private async runPowerShell(
    plugin: ItemTaskPlugin,
    contextPath: string,
    resultPath: string,
    cancellationToken: vscode.CancellationToken,
    speCredential?: SpeCredential,
  ): Promise<ProcessResult> {
    if (plugin.execution.type === "spe-remoting") {
      if (!speCredential) {
        throw new Error("SPE credentials are unavailable.");
      }
      const launcherPath = vscode.Uri.joinPath(
        this.extensionUri,
        "resources",
        "invoke-spe-task.ps1",
      ).fsPath;
      const args = [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        launcherPath,
        "-ScriptPath",
        plugin.scriptPath,
        "-ContextPath",
        contextPath,
        "-ResultPath",
        resultPath,
      ];
      const credentialJson = JSON.stringify(speCredential);
      if (process.platform === "win32") {
        return runProcess(
          "powershell.exe",
          args,
          plugin.directoryPath,
          cancellationToken,
          this.output,
          credentialJson,
        );
      }
      return runProcess(
        "pwsh",
        args,
        plugin.directoryPath,
        cancellationToken,
        this.output,
        credentialJson,
      );
    }
    const args = [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      plugin.scriptPath,
      "-ContextPath",
      contextPath,
      "-ResultPath",
      resultPath,
    ];
    try {
      return await runProcess(
        "pwsh",
        args,
        plugin.directoryPath,
        cancellationToken,
        this.output,
      );
    } catch (error: unknown) {
      if (processErrorCode(error) !== "ENOENT" || process.platform !== "win32") {
        throw error;
      }
      this.output.appendLine("PowerShell 7 (pwsh) was not found; trying Windows PowerShell.");
      return runProcess(
        "powershell.exe",
        args,
        plugin.directoryPath,
        cancellationToken,
        this.output,
      );
    }
  }

  private async getOrPromptForSpeCredential(
    candidate: ItemTaskCandidateContext,
    replace: boolean,
  ): Promise<SpeCredential | undefined> {
    if (!replace) {
      const stored = await this.connectionStore.getSpeCredential(candidate.connection.id);
      if (stored) {
        return stored;
      }
    }
    const username = await vscode.window.showInputBox({
      title: `SPE sign-in · ${candidate.connection.name}`,
      prompt: "Enter the Sitecore account authorized for SPE remoting.",
      placeHolder: "sitecore\\admin",
      ignoreFocusOut: true,
      validateInput: (value) => value.trim() ? undefined : "Username is required.",
    });
    if (!username) {
      return undefined;
    }
    const password = await vscode.window.showInputBox({
      title: `SPE sign-in · ${candidate.connection.name}`,
      prompt: `Enter the password for ${username.trim()}. It will be stored in VS Code Secret Storage.`,
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => value ? undefined : "Password is required.",
    });
    if (!password) {
      return undefined;
    }
    const credential = { username: username.trim(), password };
    await this.connectionStore.storeSpeCredential(candidate.connection.id, credential.username, password);
    return credential;
  }

  private async ensureSpeModuleAvailable(cwd: string): Promise<boolean> {
    const executable = process.platform === "win32" ? "powershell.exe" : "pwsh";
    const tokenSource = new vscode.CancellationTokenSource();
    let result: ProcessResult;
    try {
      result = await runProcess(
        executable,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "if (Get-Module -ListAvailable -Name SPE) { exit 0 } else { exit 3 }",
        ],
        cwd,
        tokenSource.token,
        this.output,
      );
    } catch (error: unknown) {
      const message = processErrorCode(error) === "ENOENT"
        ? `${executable} is unavailable, so SPE tasks cannot run.`
        : `Unable to check for the local SPE module: ${errorMessage(error)}`;
      this.output.appendLine(`[SPE preflight] ${message}`);
      this.output.show(true);
      void vscode.window.showErrorMessage(message);
      return false;
    } finally {
      tokenSource.dispose();
    }
    if (result.exitCode === 0) {
      return true;
    }

    this.output.appendLine("[SPE preflight] The local SPE remoting module is not installed.");
    this.output.appendLine(`Run in ${process.platform === "win32" ? "Windows PowerShell" : "PowerShell"}:`);
    this.output.appendLine(`  ${speInstallCommand}`);
    this.output.show(true);
    this.showSpeInstallSuggestion();
    return false;
  }

  private showSpeInstallSuggestion(): void {
    void (async () => {
      const selected = await vscode.window.showWarningMessage(
        "The local SPE remoting module is required before this task can run.",
        "Copy Install Command",
        "Open SPE Package",
      );
      if (selected === "Copy Install Command") {
        await vscode.env.clipboard.writeText(speInstallCommand);
        await vscode.window.showInformationMessage("SPE installation command copied to the clipboard.");
      } else if (selected === "Open SPE Package") {
        await vscode.env.openExternal(vscode.Uri.parse(speGalleryUrl));
      }
    })().catch((error: unknown) => {
      this.output.appendLine(`[SPE preflight] Unable to handle the installation action: ${errorMessage(error)}`);
    });
  }
}

async function readPlugin(manifestUri: vscode.Uri): Promise<ItemTaskPlugin> {
  const bytes = await vscode.workspace.fs.readFile(manifestUri);
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("Manifest is not valid JSON.");
  }
  const plugin = parseItemTaskManifest(raw, manifestUri.fsPath);
  try {
    const metadata = await vscode.workspace.fs.stat(vscode.Uri.file(plugin.scriptPath));
    if ((metadata.type & vscode.FileType.File) === 0) {
      throw new Error("Task script is not a file.");
    }
  } catch (error: unknown) {
    throw new Error(`Task script is unavailable: ${errorMessage(error)}`);
  }
  return plugin;
}

async function readTaskResult(uri: vscode.Uri): Promise<ItemTaskResult | undefined> {
  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(uri);
  } catch {
    return undefined;
  }
  try {
    const result = JSON.parse(decodeText(bytes)) as unknown;
    return result && typeof result === "object" ? result as ItemTaskResult : undefined;
  } catch {
    throw new Error("The task result file is not valid JSON.");
  }
}

function encodeUtf8WithBom(value: string): Uint8Array {
  const encoded = new TextEncoder().encode(value);
  const bytes = new Uint8Array(encoded.length + 3);
  bytes.set([0xef, 0xbb, 0xbf]);
  bytes.set(encoded, 3);
  return bytes;
}

function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return Buffer.from(bytes.subarray(2)).toString("utf16le");
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  return new TextDecoder().decode(bytes);
}

async function promptForTaskInputs(
  plugin: ItemTaskPlugin,
): Promise<Readonly<Record<string, ItemTaskInputValue>> | undefined> {
  const values: Record<string, ItemTaskInputValue> = {};
  for (const input of plugin.inputs) {
    if (input.type === "text") {
      const value = await vscode.window.showInputBox({
        title: `${plugin.name} · ${input.label}`,
        prompt: input.description,
        placeHolder: input.placeholder,
        value: input.defaultValue,
        ignoreFocusOut: true,
        validateInput: (candidate) => input.required && !candidate.trim()
          ? `${input.label} is required.`
          : undefined,
      });
      if (value === undefined) {
        return undefined;
      }
      if (value || input.required) {
        values[input.id] = value;
      }
      continue;
    }
    if (input.type === "number") {
      const value = await vscode.window.showInputBox({
        title: `${plugin.name} · ${input.label}`,
        prompt: input.description,
        placeHolder: input.placeholder,
        value: input.defaultValue?.toString(),
        ignoreFocusOut: true,
        validateInput: (candidate) => validateNumberInput(candidate, input),
      });
      if (value === undefined) {
        return undefined;
      }
      if (value.trim()) {
        values[input.id] = Number(value);
      }
      continue;
    }
    if (input.type === "boolean") {
      const choices = [
        { label: "Yes", value: true },
        { label: "No", value: false },
      ];
      if (!input.defaultValue) {
        choices.reverse();
      }
      const selected = await vscode.window.showQuickPick(choices, {
        title: `${plugin.name} · ${input.label}`,
        placeHolder: input.description,
        ignoreFocusOut: true,
      });
      if (!selected) {
        return undefined;
      }
      values[input.id] = selected.value;
      continue;
    }
    const choices = input.options.map((option) => ({
      label: option.label,
      description: option.description,
      picked: input.defaultValue !== undefined && option.value === input.defaultValue,
      value: option.value,
    }));
    if (!input.required) {
      choices.push({ label: "Skip", description: "Do not provide a value", picked: false, value: "" });
    }
    const selected = await vscode.window.showQuickPick(choices, {
      title: `${plugin.name} · ${input.label}`,
      placeHolder: input.description ?? `Select ${input.label}`,
      ignoreFocusOut: true,
    });
    if (!selected) {
      return undefined;
    }
    if (input.required || selected.label !== "Skip") {
      values[input.id] = selected.value;
    }
  }
  return values;
}

function isAuthenticationFailure(result: ProcessResult): boolean {
  return result.exitCode === 41 || /\b401\b|unauthori[sz]ed|authentication failed/iu.test(result.outputText);
}

function runProcess(
  executable: string,
  args: readonly string[],
  cwd: string,
  cancellationToken: vscode.CancellationToken,
  output: vscode.OutputChannel,
  standardInput?: string,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true });
    let cancelled = false;
    let outputText = "";
    const cancellation = cancellationToken.onCancellationRequested(() => {
      cancelled = true;
      child.kill();
    });
    child.stdout.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      outputText += text;
      output.append(text);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      outputText += text;
      output.append(text);
    });
    if (standardInput !== undefined) {
      child.stdin.end(standardInput);
    }
    child.once("error", (error) => {
      cancellation.dispose();
      reject(error);
    });
    child.once("close", (exitCode) => {
      cancellation.dispose();
      resolve({ exitCode, cancelled, outputText });
    });
  });
}

function processErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error &&
      typeof (error as { readonly code?: unknown }).code === "string"
    ? (error as { readonly code: string }).code
    : undefined;
}

async function collectTaskManifests(
  directory: vscode.Uri,
  manifests: vscode.Uri[],
): Promise<void> {
  if (manifests.length >= maximumManifestCount) {
    return;
  }
  const entries = await vscode.workspace.fs.readDirectory(directory);
  for (const [name, type] of entries) {
    if (manifests.length >= maximumManifestCount) {
      return;
    }
    const uri = vscode.Uri.joinPath(directory, name);
    if ((type & vscode.FileType.File) !== 0 && name.toLowerCase() === "task.json") {
      manifests.push(uri);
    } else if (
      (type & vscode.FileType.Directory) !== 0 &&
      (type & vscode.FileType.SymbolicLink) === 0
    ) {
      await collectTaskManifests(uri, manifests);
    }
  }
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof vscode.FileSystemError && error.code === "FileNotFound";
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
