import { strictEqual, rejects } from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { LocalMcpBridge, descriptorSchema } from "../../src/mcp/bridge";
import { callBridge, createMcpServer } from "../../src/mcp/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("local MCP bridge authenticates, rejects browser origins/foreign hosts and revokes on stop", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xm-mcp-")); const file = join(directory, "endpoint.json"); let calls = 0;
  const bridge = new LocalMcpBridge(file, async () => { calls++; return { safe: true }; });
  try {
    await bridge.start(); const endpoint = descriptorSchema.parse(JSON.parse(await readFile(file, "utf8")));
    if (process.platform !== "win32") { strictEqual((await stat(file)).mode & 0o777, 0o600); }
    const send = (headers: Record<string, string>) => fetch(`http://127.0.0.1:${endpoint.port}/call`, { method: "POST", headers,
      body: JSON.stringify({ tool: "list_connections", args: {} }) });
    strictEqual((await send({ "Content-Type": "application/json" })).status, 403);
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${endpoint.token}` };
    strictEqual((await send({ ...headers, Origin: "https://evil.example" })).status, 403);
    const foreignHost = await new Promise<number | undefined>((resolve, reject) => {
      const call = request({ host: "127.0.0.1", port: endpoint.port, path: "/call", method: "POST", headers: { ...headers, Host: "evil.example" } }, response => {
        response.resume(); resolve(response.statusCode);
      });
      call.on("error", reject); call.end(JSON.stringify({ tool: "list_connections", args: {} }));
    });
    strictEqual(foreignHost, 403);
    strictEqual(calls, 0);
    strictEqual((await callBridge(file, "list_connections", {}, new AbortController().signal) as { safe: boolean }).safe, true);
    await rejects(new LocalMcpBridge(file, async () => null).start(), /Another VS Code/u);
    await bridge.stop(); await rejects(readFile(file));
    await rejects(callBridge(file, "list_connections", {}, new AbortController().signal));
  } finally { await bridge.stop(); await rm(directory, { recursive: true, force: true }); }
});
test("MCP SDK advertises tools and validates arguments without exposing internal errors", async () => {
  let calls = 0; const server = createMcpServer(async () => { calls++; throw new Error("private server credential"); });
  const client = new Client({ name: "test", version: "1" }); const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(right); await client.connect(left);
    strictEqual((await client.listTools()).tools.length, 15);
    const invalid = await client.callTool({ name: "read_item", arguments: { connectionId: "x", item: "../../file", language: "en" } });
    strictEqual(invalid.isError, true); strictEqual(calls, 0);
    const failed = await client.callTool({ name: "list_connections", arguments: {} });
    strictEqual(failed.isError, true); strictEqual(JSON.stringify(failed).includes("private server credential"), false);
  } finally { await client.close(); await server.close(); }
});
test("real stdio MCP child completes handshake and calls the authenticated local bridge", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xm-mcp-stdio-")); const file = join(directory, "endpoint.json");
  const bridge = new LocalMcpBridge(file, async name => ({ tool: name, ready: true }));
  const client = new Client({ name: "stdio-test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "src/mcp/server.ts", file], stderr: "pipe" });
  try {
    await bridge.start(); await client.connect(transport);
    strictEqual((await client.listTools()).tools.some(tool => tool.name === "execute_plan"), true);
    const result = await client.callTool({ name: "list_connections", arguments: {} });
    strictEqual(result.isError, undefined); strictEqual(JSON.stringify(result).includes('ready'), true);
  } finally { await client.close(); await transport.close(); await bridge.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("stopping MCP access cancels active work and removes the endpoint capability", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xm-mcp-cancel-")); const file = join(directory, "endpoint.json");
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; }); let aborted = false;
  const bridge = new LocalMcpBridge(file, async (_tool, _args, signal) => {
    started(); return new Promise((_resolve, reject) => signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true }));
  });
  try {
    await bridge.start(); const pending = callBridge(file, "list_connections", {}, new AbortController().signal);
    const rejected = rejects(pending); await ready; await bridge.stop(); await rejected;
    strictEqual(aborted, true); await rejects(readFile(file));
  } finally { await bridge.stop(); await rm(directory, { recursive: true, force: true }); }
});
