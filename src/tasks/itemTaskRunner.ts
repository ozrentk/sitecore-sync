import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import * as path from "node:path";
import * as vscode from "vscode";
import type { AuthoringItemDetails } from "../sitecore/authoringClient";

const maximumManifestCount = 200;

interface ItemTaskMatchRules {
  readonly templateIds: readonly string[];
  readonly itemIds: readonly string[];
  readonly parentPaths: readonly string[];
  readonly ancestorPaths: readonly string[];
}

interface ItemTaskPlugin {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly scriptPath: string;
  readonly directoryPath: string;
  readonly matches: ItemTaskMatchRules;
}

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
}

interface TaskChoice extends vscode.QuickPickItem {
  readonly plugin: ItemTaskPlugin;
  readonly context: ItemTaskCandidateContext;
}

interface ProcessResult {
  readonly exitCode: number | null;
  readonly cancelled: boolean;
}

export class ItemTaskRunner implements vscode.Disposable {
  private running = false;

  constructor(
    private readonly storageUri: vscode.Uri,
    private readonly output: vscode.OutputChannel,
  ) {}

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
    const ancestorPaths = itemAncestorPaths(candidate.item.path);
    const executionContext: ItemTaskExecutionContext = {
      schemaVersion: 1,
      task: { id: plugin.id, name: plugin.name },
      ...candidate,
      parentPath: ancestorPaths.at(-1),
      ancestorPaths,
    };
    try {
      await vscode.workspace.fs.createDirectory(runDirectory);
      await vscode.workspace.fs.writeFile(
        contextUri,
        encodeUtf8WithBom(`${JSON.stringify(executionContext, null, 2)}\n`),
      );

      this.output.clear();
      this.output.appendLine(`Task: ${plugin.name} (${plugin.id})`);
      this.output.appendLine(`Item: ${candidate.item.path}`);
      this.output.appendLine(
        `Context: ${capitalize(candidate.side)} · ${candidate.connection.name} · ${candidate.language} · v${candidate.item.version}`,
      );
      this.output.appendLine(`Script: ${plugin.scriptPath}`);
      this.output.appendLine("");
      this.output.show(true);

      const processResult = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Running item task “${plugin.name}”`,
          cancellable: true,
        },
        async (_progress, token) => await this.runPowerShell(
          plugin,
          contextUri.fsPath,
          resultUri.fsPath,
          token,
        ),
      );
      if (processResult.cancelled) {
        this.output.appendLine("\nTask cancelled.");
        await vscode.window.showInformationMessage(`Task “${plugin.name}” was cancelled.`);
        return;
      }
      const declaredResult = await readTaskResult(resultUri);
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
  ): Promise<ProcessResult> {
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
}

async function readPlugin(manifestUri: vscode.Uri): Promise<ItemTaskPlugin> {
  const bytes = await vscode.workspace.fs.readFile(manifestUri);
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("Manifest is not valid JSON.");
  }
  if (!raw || typeof raw !== "object") {
    throw new Error("Manifest must contain a JSON object.");
  }
  const candidate = raw as Record<string, unknown>;
  const id = requiredText(candidate.id, "id");
  const name = requiredText(candidate.name, "name");
  const script = requiredText(candidate.script, "script");
  const matches = parseMatchRules(candidate.matches);
  const directoryPath = path.dirname(manifestUri.fsPath);
  const scriptPath = path.resolve(directoryPath, script);
  const relativeScriptPath = path.relative(directoryPath, scriptPath);
  if (relativeScriptPath.startsWith("..") || path.isAbsolute(relativeScriptPath)) {
    throw new Error("The task script must be inside its manifest directory.");
  }
  if (path.extname(scriptPath).toLowerCase() !== ".ps1") {
    throw new Error("The initial task-plugin version supports .ps1 scripts only.");
  }
  try {
    const metadata = await vscode.workspace.fs.stat(vscode.Uri.file(scriptPath));
    if ((metadata.type & vscode.FileType.File) === 0) {
      throw new Error("Task script is not a file.");
    }
  } catch (error: unknown) {
    throw new Error(`Task script is unavailable: ${errorMessage(error)}`);
  }
  return {
    id,
    name,
    description: optionalText(candidate.description),
    scriptPath,
    directoryPath,
    matches,
  };
}

function parseMatchRules(value: unknown): ItemTaskMatchRules {
  if (!value || typeof value !== "object") {
    throw new Error("Manifest property “matches” is required.");
  }
  const candidate = value as Record<string, unknown>;
  const matches = {
    templateIds: stringArray(candidate.templateIds, "matches.templateIds"),
    itemIds: stringArray(candidate.itemIds, "matches.itemIds"),
    parentPaths: stringArray(candidate.parentPaths, "matches.parentPaths"),
    ancestorPaths: stringArray(candidate.ancestorPaths, "matches.ancestorPaths"),
  };
  if (Object.values(matches).every((entries) => entries.length === 0)) {
    throw new Error("At least one item-matching rule is required.");
  }
  return matches;
}

function matchesItem(rules: ItemTaskMatchRules, item: AuthoringItemDetails): boolean {
  const itemId = normalizeId(item.itemId);
  const templateId = normalizeId(item.template.templateId);
  const pathValue = normalizePath(item.path);
  const ancestors = itemAncestorPaths(pathValue).map((entry) => entry.toLowerCase());
  const parent = ancestors.at(-1);
  return rules.itemIds.some((value) => normalizeId(value) === itemId) ||
    rules.templateIds.some((value) => normalizeId(value) === templateId) ||
    rules.parentPaths.some((value) => normalizePath(value).toLowerCase() === parent) ||
    rules.ancestorPaths.some((value) => ancestors.includes(normalizePath(value).toLowerCase()));
}

function itemAncestorPaths(itemPath: string): readonly string[] {
  const segments = normalizePath(itemPath).split("/").filter(Boolean);
  const ancestors: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    ancestors.push(`/${segments.slice(0, index).join("/")}`);
  }
  return ancestors;
}

function normalizePath(value: string): string {
  const normalized = value.trim().replace(/\\/gu, "/").replace(/\/{2,}/gu, "/");
  if (!normalized.startsWith("/")) {
    return `/${normalized}`.replace(/\/$/u, "") || "/";
  }
  return normalized.replace(/\/$/u, "") || "/";
}

function normalizeId(value: string): string {
  return value.replace(/[{}-]/gu, "").toLowerCase();
}

function requiredText(value: unknown, property: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Manifest property “${property}” must be a non-empty string.`);
  }
  return value.trim();
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown, property: string): readonly string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error(`Manifest property “${property}” must be an array of non-empty strings.`);
  }
  return value.map((entry) => String(entry).trim());
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

function runProcess(
  executable: string,
  args: readonly string[],
  cwd: string,
  cancellationToken: vscode.CancellationToken,
  output: vscode.OutputChannel,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true });
    let cancelled = false;
    const cancellation = cancellationToken.onCancellationRequested(() => {
      cancelled = true;
      child.kill();
    });
    child.stdout.on("data", (chunk: Buffer | string) => output.append(chunk.toString()));
    child.stderr.on("data", (chunk: Buffer | string) => output.append(chunk.toString()));
    child.once("error", (error) => {
      cancellation.dispose();
      reject(error);
    });
    child.once("close", (exitCode) => {
      cancellation.dispose();
      resolve({ exitCode, cancelled });
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
