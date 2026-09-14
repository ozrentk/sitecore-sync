import { build } from "esbuild";

await Promise.all([
  build({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    external: ["vscode", "playwright-core"],
    format: "cjs",
    platform: "node",
    target: "node20",
    sourcemap: true,
    sourcesContent: true,
    outfile: "out/extension.js",
  }),
  build({
    entryPoints: ["src/tasks/javascriptTaskWorker.ts"],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node20",
    sourcemap: true,
    sourcesContent: true,
    outfile: "out/javascriptTaskWorker.js",
  }),
]);
