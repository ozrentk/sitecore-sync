import {
  deepStrictEqual,
  match,
  strictEqual,
} from "node:assert/strict";
import * as vscode from "vscode";
import type { ConnectionStore } from "../../src/connections/connectionStore";
import type { AuthoringContentClient } from "../../src/sitecore/authoringClient";
import type { ItemTaskPlugin } from "../../src/tasks/itemTaskManifest";
import { ItemTaskRunner } from "../../src/tasks/itemTaskRunner";
import type { IntegrationTest } from "./testSupport";

const extensionId = "OzrenTK.sitecore-xm-cloud-sync";

interface DiscoverableItemTaskRunner {
  discoverPlugins(): Promise<readonly ItemTaskPlugin[]>;
}

class DiscoveryOutput {
  readonly lines: string[] = [];
  showCalls = 0;
  disposed = false;

  appendLine(value: string): void {
    this.lines.push(value);
  }

  show(): void {
    this.showCalls += 1;
  }

  dispose(): void {
    this.disposed = true;
  }
}

export const itemTaskRunnerTests: readonly IntegrationTest[] = [
  {
    name: "ItemTaskRunner discovers valid manifests and isolates invalid plug-ins",
    async execute(): Promise<void> {
      const workspace = vscode.workspace.workspaceFolders?.[0];
      if (!workspace) {
        throw new Error("The extension-host test workspace is unavailable.");
      }
      const fixtureRoot = vscode.Uri.joinPath(
        workspace.uri,
        ".xm-cloud-sync",
        "tasks",
        "integration-fixture",
      );
      const storageUri = vscode.Uri.joinPath(workspace.uri, ".item-task-test-storage");
      const output = new DiscoveryOutput();
      const runner = new ItemTaskRunner(
        storageUri,
        extensionUri(),
        {} as ConnectionStore,
        {} as AuthoringContentClient,
        output as unknown as vscode.OutputChannel,
      );
      try {
        await deleteIfPresent(fixtureRoot);
        await deleteIfPresent(storageUri);
        await writePlugin(fixtureRoot, "01-alpha", {
          id: "alpha",
          name: "Alpha task",
          script: "run.ps1",
          matches: { parentPaths: ["/sitecore/content/Tenant/Site"] },
        }, "run.ps1");
        await writePlugin(fixtureRoot, "02-zeta", {
          id: "zeta",
          name: "Zeta task",
          script: "run.mjs",
          execution: { type: "javascript" },
          matches: { templateIds: ["template-id"] },
          inputs: [{
            id: "confirm",
            label: "Confirm",
            type: "boolean",
            default: true,
          }],
        }, "run.mjs");
        await writePlugin(fixtureRoot, "03-duplicate", {
          id: "ALPHA",
          name: "Duplicate task",
          script: "run.ps1",
          matches: { itemIds: ["item-id"] },
        }, "run.ps1");
        await writePlugin(fixtureRoot, "04-traversal", {
          id: "traversal",
          name: "Traversal task",
          script: "../outside.ps1",
          matches: { itemIds: ["item-id"] },
        });
        await writePlugin(fixtureRoot, "05-missing", {
          id: "missing",
          name: "Missing script",
          script: "missing.ps1",
          matches: { itemIds: ["item-id"] },
        });
        const invalidDirectory = vscode.Uri.joinPath(fixtureRoot, "06-invalid-json");
        await vscode.workspace.fs.createDirectory(invalidDirectory);
        await vscode.workspace.fs.writeFile(
          vscode.Uri.joinPath(invalidDirectory, "task.json"),
          new TextEncoder().encode("{ invalid json"),
        );

        const plugins = await (
          runner as unknown as DiscoverableItemTaskRunner
        ).discoverPlugins();

        deepStrictEqual(plugins.map((plugin) => plugin.name), ["Alpha task", "Zeta task"]);
        deepStrictEqual(plugins.map((plugin) => plugin.execution.type), [
          "powershell",
          "javascript",
        ]);
        deepStrictEqual(plugins[1]?.inputs, [{
          id: "confirm",
          label: "Confirm",
          description: undefined,
          required: false,
          type: "boolean",
          defaultValue: true,
        }]);
        const diagnostics = output.lines.join("\n");
        match(diagnostics, /Duplicate task ID “ALPHA”/u);
        match(diagnostics, /must be inside its manifest directory/u);
        match(diagnostics, /Task script is unavailable/u);
        match(diagnostics, /Manifest is not valid JSON/u);
        strictEqual(output.showCalls, 0);
      } finally {
        runner.dispose();
        await deleteIfPresent(fixtureRoot);
        await deleteIfPresent(storageUri);
      }
      strictEqual(output.disposed, true);
    },
  },
];

async function writePlugin(
  fixtureRoot: vscode.Uri,
  directoryName: string,
  manifest: Readonly<Record<string, unknown>>,
  scriptName?: string,
): Promise<void> {
  const directory = vscode.Uri.joinPath(fixtureRoot, directoryName);
  await vscode.workspace.fs.createDirectory(directory);
  await vscode.workspace.fs.writeFile(
    vscode.Uri.joinPath(directory, "task.json"),
    new TextEncoder().encode(JSON.stringify(manifest)),
  );
  if (scriptName) {
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(directory, scriptName),
      new TextEncoder().encode("// integration fixture\n"),
    );
  }
}

async function deleteIfPresent(uri: vscode.Uri): Promise<void> {
  await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: false }).then(
    () => undefined,
    (error: unknown) => {
      if (!(error instanceof vscode.FileSystemError) || error.code !== "FileNotFound") {
        throw error;
      }
    },
  );
}

function extensionUri(): vscode.Uri {
  const extension = vscode.extensions.getExtension(extensionId);
  if (!extension) {
    throw new Error(`Extension ${extensionId} was not discovered by the test host.`);
  }
  return extension.extensionUri;
}
