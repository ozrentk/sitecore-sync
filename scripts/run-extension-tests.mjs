import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { runTests } from "@vscode/test-electron";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const extensionTestsPath = path.join(
  repositoryRoot,
  ".test-out",
  "integration",
  "index.js",
);
const workspacePath = await mkdtemp(
  path.join(tmpdir(), "xm-cloud-sync-extension-tests-"),
);

try {
  // A test-only contribution lets the suite exercise VS Code's native custom-document
  // lifecycle without exposing test commands/providers in the shipped extension.
  const editorFixturePath = path.join(workspacePath, ".editor-test-extension");
  await mkdir(editorFixturePath);
  await writeFile(path.join(editorFixturePath, "package.json"), JSON.stringify({
    name: "xm-editor-test", publisher: "test", version: "1.0.0", engines: { vscode: "^1.100.0" },
    contributes: { customEditors: [{ viewType: "xmCloudSync.testItemEditor", displayName: "Test Item Editor",
      selector: [{ filenamePattern: "*.xmitem" }], priority: "option" }] },
  }));
  await build({
    entryPoints: [path.join(repositoryRoot, "test", "integration", "index.ts")],
    bundle: true,
    external: ["vscode", "playwright-core"],
    format: "cjs",
    platform: "node",
    target: "node20",
    sourcemap: true,
    sourcesContent: true,
    outfile: extensionTestsPath,
  });

  await runTests({
    version: "1.100.0",
    extensionDevelopmentPath: [repositoryRoot, editorFixturePath],
    extensionTestsPath,
    launchArgs: [workspacePath, "--disable-extensions"],
  });
} finally {
  await rm(workspacePath, { recursive: true, force: true });
}
