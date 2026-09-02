import { mkdtemp, rm } from "node:fs/promises";
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
  await build({
    entryPoints: [path.join(repositoryRoot, "test", "integration", "index.ts")],
    bundle: true,
    external: ["vscode"],
    format: "cjs",
    platform: "node",
    target: "node20",
    sourcemap: true,
    sourcesContent: true,
    outfile: extensionTestsPath,
  });

  await runTests({
    version: "1.100.0",
    extensionDevelopmentPath: repositoryRoot,
    extensionTestsPath,
    launchArgs: [workspacePath, "--disable-extensions"],
  });
} finally {
  await rm(workspacePath, { recursive: true, force: true });
}
