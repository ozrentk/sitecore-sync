import { readdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const unitTestRoot = path.join(repositoryRoot, "test", "unit");
const testFiles = await findTests(unitTestRoot);

if (!testFiles.length) {
  throw new Error(`No TypeScript unit tests were found under ${unitTestRoot}.`);
}

const exitCode = await new Promise((resolve, reject) => {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--test", ...testFiles],
    {
      cwd: repositoryRoot,
      stdio: "inherit",
    },
  );
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (signal) {
      reject(new Error(`Unit tests terminated with signal ${signal}.`));
      return;
    }
    resolve(code ?? 1);
  });
});

if (exitCode !== 0) {
  throw new Error(`Unit tests failed with exit code ${exitCode}.`);
}

async function findTests(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name)
  )) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await findTests(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(entryPath);
    }
  }
  return files;
}
