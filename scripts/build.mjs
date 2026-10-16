import { build } from "esbuild";

const frame = await build({ entryPoints: ["webview/richTextFrameRuntime.ts"], bundle: true, write: false, format: "iife", platform: "browser", target: "chrome120", minify: true });

await Promise.all([
  build({ entryPoints: ["webview/richTextFrame.ts"], bundle: true, format: "iife", platform: "browser", target: "chrome120", outfile: "out/webview/richTextFrame.js", define: { __RICH_TEXT_FRAME_SCRIPT__: JSON.stringify(frame.outputFiles[0].text) } }),
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
