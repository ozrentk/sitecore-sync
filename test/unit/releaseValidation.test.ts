import { strictEqual } from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

test("release validation requires matching versions and a commit on main", () => {
  const directory = mkdtempSync(join(tmpdir(), "xm-sync-release-test-"));
  const script = resolve("scripts/validate-release.mjs");
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: directory, stdio: "pipe" });
  };
  const validate = (tag: string): number | null => spawnSync(process.execPath, [script], {
    cwd: directory, env: { ...process.env, GITHUB_REF_NAME: tag }, encoding: "utf8",
  }).status;
  try {
    git("init");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "Release test");
    writeFileSync(join(directory, "package.json"), JSON.stringify({ version: "1.2.3" }));
    const lockPath = join(directory, "package-lock.json");
    writeFileSync(lockPath, JSON.stringify({ version: "1.2.3", packages: { "": { version: "1.2.3" } } }));
    git("add", "package.json", "package-lock.json");
    git("commit", "-m", "test fixture");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    strictEqual(validate("v1.2.3"), 0);
    for (const tag of ["v1.2.4", "1.2.3", "v1.2.3-preview", ""]) {
      strictEqual(validate(tag), 1);
    }
    writeFileSync(lockPath, JSON.stringify({ version: "1.2.3", packages: { "": { version: "1.2.4" } } }));
    strictEqual(validate("v1.2.3"), 1);
    git("checkout", "--", "package-lock.json");
    git("commit", "--allow-empty", "-m", "not on main");
    strictEqual(validate("v1.2.3"), 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
