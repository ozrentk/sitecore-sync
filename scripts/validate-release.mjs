import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const tag = process.env.GITHUB_REF_NAME;
if (!/^v\d+\.\d+\.\d+$/u.test(tag ?? "") || tag !== `v${manifest.version}`) {
  throw new Error("Release tag must be vMAJOR.MINOR.PATCH and match package.json.");
}
if (lock.version !== manifest.version || lock.packages?.[""]?.version !== manifest.version) {
  throw new Error("Release package and lockfile versions must match.");
}
execFileSync("git", ["merge-base", "--is-ancestor", "HEAD", "origin/main"], { stdio: "inherit" });
console.log(`Validated ${tag} on main.`);
