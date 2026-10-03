import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { descriptorSchema, type BridgeHandler } from "./bridge";
import { isMcpToolName, toolDescriptions, toolSchemas } from "./tools";

export function createMcpServer(call: BridgeHandler): Server {
  const server = new Server({ name: "xm-cloud-sync", version: "0.29.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: Object.entries(toolSchemas).map(([name, schema]) => ({
    name, description: toolDescriptions[name as keyof typeof toolSchemas], inputSchema: z.toJSONSchema(schema) as { type: "object" },
    annotations: { readOnlyHint: name !== "execute_plan", destructiveHint: name === "execute_plan", openWorldHint: true },
  })) }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name;
    if (!isMcpToolName(name)) { return { isError: true, content: [{ type: "text", text: "Unknown tool." }] }; }
    const args = toolSchemas[name].safeParse(request.params.arguments ?? {});
    if (!args.success) { return { isError: true, content: [{ type: "text", text: "Invalid tool arguments. Check the advertised schema." }] }; }
    try {
      const result = await call(name, args.data, extra.signal);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof BridgeError ? error.message
        : "Cannot reach XM Cloud Sync. Start MCP access in VS Code and check its operation journal before retrying a mutation." }] };
    }
  });
  return server;
}

class BridgeError extends Error {}
export async function callBridge(file: string, tool: string, args: unknown, signal: AbortSignal): Promise<unknown> {
  if ((await stat(file)).size > 4096) { throw new Error("Invalid descriptor"); }
  const endpoint = descriptorSchema.parse(JSON.parse(await readFile(file, "utf8")));
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/call`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${endpoint.token}` },
    body: JSON.stringify({ tool, args }), signal: AbortSignal.any([signal, AbortSignal.timeout(185_000)]), redirect: "error",
  });
  if (!response.ok || !response.body) { throw new Error("Bridge unavailable"); }
  let bytes = 0; const chunks: Uint8Array[] = [];
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 8 * 1024 * 1024) { throw new Error("Oversized bridge response"); }
    chunks.push(chunk);
  }
  const payload = z.object({ result: z.unknown().optional(), error: z.string().max(500).optional() }).strict()
    .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  if (payload.error) { throw new BridgeError(payload.error); }
  return payload.result;
}

if (require.main === module) {
  const file = process.argv[2];
  if (!file) { process.stderr.write("Pass the endpoint file shown by Start MCP Access in VS Code.\n"); process.exitCode = 1; }
  else {
    const server = createMcpServer((tool, args, signal) => callBridge(file, tool, args, signal));
    server.connect(new StdioServerTransport()).catch(() => { process.stderr.write("MCP startup failed.\n"); process.exitCode = 1; });
  }
}
