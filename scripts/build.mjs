import { build } from "esbuild";

await Promise.all([
  build({ entryPoints: ["webview/richTextVisual.ts"], bundle: true, format: "iife", platform: "browser", target: "chrome120", outfile: "out/webview/richTextVisual.js" }),
  build({
    entryPoints: ["src/mcp/server.ts"],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node20",
    outfile: "out/mcpServer.js",
  }),
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
