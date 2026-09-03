import { strictEqual } from "node:assert/strict";
import * as vscode from "vscode";
import { operationSequenceStoreTests } from "./operationSequenceStoreTests";
import { transferProcessorTests } from "./transferProcessorTests";
import { transferQueueStoreTests } from "./transferQueueStoreTests";

const extensionId = "OzrenTK.sitecore-xm-cloud-sync";

interface ExtensionManifest {
  readonly contributes?: {
    readonly commands?: readonly {
      readonly command?: unknown;
    }[];
  };
}

interface IntegrationTest {
  readonly name: string;
  readonly execute: () => Promise<void>;
}

const integrationTests: readonly IntegrationTest[] = [
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
  ...operationSequenceStoreTests,
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
