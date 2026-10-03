import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import * as z from "zod";
import { McpAccessError } from "./tools";

export const descriptorSchema = z.object({ port: z.number().int().min(1).max(65535), token: z.string().regex(/^[a-f\d]{64}$/u), pid: z.number().int().positive() }).strict();
export type BridgeDescriptor = z.infer<typeof descriptorSchema>;
const requestSchema = z.object({ tool: z.string().max(80), args: z.unknown() }).strict();
export type BridgeHandler = (tool: string, args: unknown, signal: AbortSignal) => Promise<unknown>;

export class LocalMcpBridge {
  private server?: Server;
  private descriptor?: BridgeDescriptor;
  private readonly active = new Set<AbortController>();
  constructor(private readonly file: string, private readonly handle: BridgeHandler) {}

  async start(): Promise<void> {
    if (this.server) { throw new McpAccessError("MCP access is already running."); }
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    try {
      const previous = descriptorSchema.parse(JSON.parse(await readFile(this.file, "utf8")));
      let alive = true;
      try { process.kill(previous.pid, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== "ESRCH"; }
      if (alive) { throw new McpAccessError("Another VS Code window owns this MCP endpoint. Stop access there first."); }
      await unlink(this.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") { throw error; }
    }
    const server = createServer((request, response) => { void this.respond(request, response); });
    this.server = server;
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    server.maxHeadersCount = 24;
    try {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
      server.on("error", () => { this.shutdown(); });
      const address = server.address();
      if (!address || typeof address === "string") { throw new Error("No local address"); }
      this.descriptor = { port: address.port, token: randomBytes(32).toString("hex"), pid: process.pid };
      await writeFile(this.file, JSON.stringify(this.descriptor), { flag: "wx", mode: 0o600 });
    } catch (error) { this.shutdown(); throw error; }
  }

  shutdown(): void {
    for (const controller of this.active) { controller.abort(); }
    this.server?.close(); this.server?.closeAllConnections(); this.server = undefined;
  }

  async stop(): Promise<void> {
    this.shutdown();
    const own = this.descriptor; this.descriptor = undefined;
    if (!own) { return; }
    try {
      const saved = descriptorSchema.parse(JSON.parse(await readFile(this.file, "utf8")));
      if (saved.token === own.token) { await unlink(this.file); }
    } catch { /* Stopping already revokes the in-memory endpoint, even if file cleanup fails. */ }
  }

  private async respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const descriptor = this.descriptor;
    const supplied = request.headers.authorization ?? "";
    const expected = `Bearer ${descriptor?.token ?? ""}`;
    if (!descriptor || request.method !== "POST" || request.url !== "/call" || request.headers.origin !== undefined
      || request.headers.host !== `127.0.0.1:${descriptor.port}`
      || request.headers["content-type"] !== "application/json"
      || Buffer.byteLength(supplied) !== Buffer.byteLength(expected)
      || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
      response.writeHead(403); response.end(); return;
    }
    if (this.active.size >= 4) { response.writeHead(429); response.end(); return; }
    const controller = new AbortController(); this.active.add(controller);
    const timer = setTimeout(() => { controller.abort(); response.destroy(); }, 180_000);
    response.on("close", () => { if (!response.writableEnded) { controller.abort(); } });
    try {
      let bytes = 0; const chunks: Buffer[] = [];
      for await (const chunk of request) {
        const buffer = Buffer.from(chunk as Uint8Array); bytes += buffer.length;
        if (bytes > 64 * 1024) { throw new McpAccessError("MCP request exceeds the size limit."); }
        chunks.push(buffer);
      }
      controller.signal.throwIfAborted();
      const parsed = requestSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (!parsed.success) { throw new McpAccessError("Invalid MCP bridge request."); }
      const result = await this.handle(parsed.data.tool, parsed.data.args, controller.signal);
      controller.signal.throwIfAborted();
      const output = JSON.stringify({ result });
      if (Buffer.byteLength(output) > 8 * 1024 * 1024) { throw new McpAccessError("MCP response exceeds the size limit. Narrow the request."); }
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); response.end(output);
    } catch (error) {
      if (!response.destroyed) {
        response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        response.end(JSON.stringify({ error: error instanceof McpAccessError ? error.message
          : "MCP operation stopped or failed. Check the connection and operation journal before retrying a mutation." }));
      }
    } finally { clearTimeout(timer); this.active.delete(controller); }
  }
}
