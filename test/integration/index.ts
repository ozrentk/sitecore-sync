import { strictEqual } from "node:assert/strict";
import * as vscode from "vscode";

const extensionId = "OzrenTK.sitecore-xm-cloud-sync";

interface ExtensionManifest {
  readonly contributes?: {
    readonly commands?: readonly {
      readonly command?: unknown;
    }[];
  };
}

interface SmokeTest {
  readonly name: string;
  readonly execute: () => Promise<void>;
}

const smokeTests: readonly SmokeTest[] = [
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
];

export async function run(): Promise<void> {
  const failures: string[] = [];
  for (const smokeTest of smokeTests) {
    try {
      await smokeTest.execute();
      console.log(`PASS ${smokeTest.name}`);
    } catch (error: unknown) {
      failures.push(smokeTest.name);
      console.error(`FAIL ${smokeTest.name}`, error);
    }
  }
  if (failures.length) {
    throw new Error(
      `${failures.length} extension-host smoke test(s) failed: ${failures.join(", ")}`,
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
