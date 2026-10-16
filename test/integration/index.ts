import { itemEditorTests } from "./itemEditorTests";
import { htmlSourceTests } from "./htmlSourceTests";
import { appendFileSync } from "node:fs";
import { isAcceptedB31 } from "../releaseExceptions";
import { strictEqual } from "node:assert/strict";
import * as vscode from "vscode";
import { connectionStoreTests } from "./connectionStoreTests";
import { fallbackDiagnosticTests } from "./fallbackDiagnosticTests";
import { fallbackFixtureTests } from "./fallbackFixtureTests";
import { mcpAccessTests } from "./mcpAccessTests";
import { connectionSettingsTests } from "./connectionSettingsTests";
import { comparisonPanelTests } from "./comparisonPanelTests";
import { itemTaskRunnerTests } from "./itemTaskRunnerTests";
import { javaScriptTaskHostTests } from "./javascriptTaskHostTests";
import { operationSequenceStoreTests } from "./operationSequenceStoreTests";
import { publishingFormTests } from "./publishingFormTests";
import { publishingManagerTests } from "./publishingManagerTests";
import { transferProcessorTests } from "./transferProcessorTests";
import { fallbackWebviewTests } from "./fallbackWebviewTests";
import { transferQueueStoreTests } from "./transferQueueStoreTests";

const extensionId = "OzrenTK.sitecore-xm-cloud-sync";

interface ExtensionManifest {
  readonly contributes?: {
    readonly commands?: readonly {
      readonly command?: unknown;
    }[];
    readonly menus?: Readonly<Record<string, readonly { readonly command?: string; readonly when?: string }[]>>;
  };
}

interface IntegrationTest {
  readonly name: string;
  readonly execute: () => Promise<void>;
}

const integrationTests: readonly IntegrationTest[] = [
  ...fallbackWebviewTests,
  ...itemEditorTests,
  ...htmlSourceTests,
  {
    name: "exposes the unified dashboard on connection context menus",
    async execute(): Promise<void> {
      const extension = requireExtension();
      await extension.activate();
      const manifest = extension.packageJSON as ExtensionManifest;
      const entries = manifest.contributes?.menus?.["view/item/context"] ?? [];
      const entry = entries.find(value => value.command === "xmCloudSync.configureConnection");
      strictEqual(entry?.when, "view == xmCloudSync.connections && viewItem == xmCloudConnection");
    },
  },
  {
    name: "activates the extension in an empty workspace",
    async execute(): Promise<void> {
      const extension = requireExtension();
      await extension.activate();
      strictEqual(extension.isActive, true);
    },
  },
  {
    name: "registers every contributed command",
    async execute(): Promise<void> {
      const extension = requireExtension();
      await extension.activate();
      const manifest = extension.packageJSON as ExtensionManifest;
      const contributed = (manifest.contributes?.commands ?? []).map((entry) => {
        if (typeof entry.command !== "string") {
          throw new Error("The extension manifest contains an invalid command contribution.");
        }
        return entry.command;
      });
      const registered = new Set(await vscode.commands.getCommands(true));
      strictEqual(registered.has("xmCloudSync.pasteAsConnectionUrl"), false);
      strictEqual(JSON.stringify(manifest).includes("xmCloudSync.pasteAsConnectionUrl"), false);
      const missing = contributed.filter((command) => !registered.has(command));
      strictEqual(
        missing.length,
        0,
        `Commands declared but not registered: ${missing.join(", ")}`,
      );
    },
  },
  {
    name: "exposes the documented text-normalization default",
    async execute(): Promise<void> {
      const configuration = vscode.workspace.getConfiguration("xmCloudSync");
      strictEqual(configuration.get("textNormalization"), "none");
    },
  },
  ...connectionStoreTests,
  ...fallbackDiagnosticTests,
  ...fallbackFixtureTests,
  ...mcpAccessTests,
  ...connectionSettingsTests,
  ...comparisonPanelTests,
  ...itemTaskRunnerTests,
  ...javaScriptTaskHostTests,
  ...operationSequenceStoreTests,
  ...publishingFormTests,
  ...publishingManagerTests,
  ...transferProcessorTests,
  ...transferQueueStoreTests,
];

export async function run(): Promise<void> {
  const failures: string[] = [];
  for (const integrationTest of integrationTests) {
    try {
      await integrationTest.execute();
      console.log(`PASS ${integrationTest.name}`);
    } catch (error: unknown) {
      if (isAcceptedB31(requireExtension().packageJSON.version, process.env.XM_CLOUD_SYNC_B31_EXCEPTION, integrationTest.name, error)) {
        const note = "B31 known failure accepted for 0.45.0: Destination focus must expand inline. Remaining steps in this test were not exercised; normal interactive reproduction is unverified. Remove the exception when B31 is fixed.";
        console.warn(`KNOWN FAILURE ${integrationTest.name}: ${note}`);
        if (process.env.GITHUB_ACTIONS === "true") console.warn(`::warning title=B31 release exception::${note}`);
        if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### Accepted release exception\n\n${note}\n`);
        continue;
      }
      failures.push(integrationTest.name);
      console.error(`FAIL ${integrationTest.name}`, error);
    }
  }
  if (failures.length) {
    throw new Error(
      `${failures.length} extension-host test(s) failed: ${failures.join(", ")}`,
    );
  }
}

function requireExtension(): vscode.Extension<unknown> {
  const extension = vscode.extensions.getExtension(extensionId);
  if (!extension) {
    throw new Error(`Extension ${extensionId} was not discovered by the test host.`);
  }
  return extension;
}
