import * as vscode from "vscode";
import { createHash } from "node:crypto";
import { copyFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import type { ConnectionStore } from "../connections/connectionStore";
import type { AuthoringContentClient } from "../sitecore/authoringClient";
import { LocalMcpBridge } from "./bridge";
import { McpService } from "./service";
import { McpAccessError } from "./tools";

const journalKey = "xmCloudSync.mcpOperations.v1";
export class McpAccessManager implements vscode.Disposable {
  private bridge?: LocalMcpBridge;
  private service?: McpService;
  private starting = false;
  private generation = 0;
  private disposed = false;
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  private readonly directory: string;
  constructor(private readonly context: Pick<vscode.ExtensionContext, "storageUri" | "globalStorageUri" | "workspaceState" | "extensionPath">, private readonly store: ConnectionStore,
    private readonly client: AuthoringContentClient) {
    const workspace = context.storageUri?.toString() ?? "no-workspace";
    this.directory = join(context.globalStorageUri.fsPath, "mcp", createHash("sha256").update(workspace).digest("hex").slice(0, 16));
    this.status.command = "xmCloudSync.stopMcpAccess";
    this.status.tooltip = "Local MCP access is active. Click to stop and revoke access.";
  }

  async start(): Promise<void> {
    if (this.starting || this.disposed) { return; }
    if (this.bridge) { await this.showSetup(); return; }
    if (!vscode.workspace.isTrusted) { await vscode.window.showErrorMessage("MCP access requires a trusted workspace."); return; }
    if (vscode.env.remoteName) { await vscode.window.showErrorMessage("Local MCP access currently requires a local VS Code window, not a remote extension host."); return; }
    this.starting = true; const generation = this.generation;
    let bridge: LocalMcpBridge | undefined; let service: McpService | undefined;
    try {
      const selected = await vscode.window.showQuickPick(this.store.list().map(connection => ({ label: connection.name,
        description: connection.serverUrl, connection })), { canPickMany: true, ignoreFocusOut: true,
        title: "Start MCP access", placeHolder: "Select connections the local agent may read. Mutations start disabled." });
      if (!selected?.length || generation !== this.generation || this.disposed) { return; }
      service = new McpService(this.store, this.client, selected.map(item => item.connection), {
        loadJournal: () => this.context.workspaceState.get<unknown>(journalKey, []),
        saveJournal: async records => { await this.context.workspaceState.update(journalKey, records); },
        confirm: async (preview, signal) => {
          signal.throwIfAborted();
          await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: "json", content: JSON.stringify(preview, null, 2) }), { preview: false });
          signal.throwIfAborted();
          return new Promise<boolean>(resolve => {
            const cancel = (): void => resolve(false);
            signal.addEventListener("abort", cancel, { once: true });
            void vscode.window.showWarningMessage("Execute the MCP mutation shown in the preview?",
              { modal: true, detail: "Review the connection, target items and values in the JSON preview. This changes Sitecore content." }, "Execute")
              .then(answer => { signal.removeEventListener("abort", cancel); resolve(!signal.aborted && answer === "Execute"); },
                () => { signal.removeEventListener("abort", cancel); resolve(false); });
          });
        },
      });
      const activeService = service;
      bridge = new LocalMcpBridge(join(this.directory, "endpoint.json"), (tool, args, signal) => activeService.call(tool, args, signal));
      await bridge.start();
      await copyFile(join(this.context.extensionPath, "out", "mcpServer.js"), join(this.directory, "server.cjs"));
      await chmod(join(this.directory, "server.cjs"), 0o600);
      if (generation !== this.generation || this.disposed) { service.dispose(); await bridge.stop(); return; }
      this.bridge = bridge; this.service = service;
      this.status.text = "$(plug) MCP: read only"; this.status.show();
      await this.showSetup();
    } catch (error) {
      service?.dispose(); await bridge?.stop(); this.bridge = undefined; this.service = undefined; this.status.hide();
      await vscode.window.showErrorMessage(error instanceof McpAccessError ? error.message : "Could not start local MCP access. Check the local storage directory and reload VS Code if needed.");
    } finally { this.starting = false; }
  }

  async enableMutations(): Promise<void> {
    const service = this.service;
    if (!service) { await vscode.window.showInformationMessage("Start MCP access first."); return; }
    const connections = await service.call("list_connections", {}, new AbortController().signal) as { id: string; name: string; serverUrl: string }[];
    const selected = await vscode.window.showQuickPick(connections.map(connection => ({ label: connection.name, description: connection.serverUrl, connection })),
      { title: "Enable MCP mutations", placeHolder: "Choose the development connection. Each mutation still requires a preview and confirmation." });
    if (!selected || this.service !== service) { return; }
    service.enableMutations(selected.connection.id);
    this.status.text = "$(plug) MCP: mutations enabled";
    await vscode.window.showInformationMessage(`MCP mutation requests enabled for ${selected.connection.name} until access stops. Each plan requires confirmation.`);
  }

  async stop(): Promise<void> {
    this.generation++;
    this.service?.dispose(); this.service = undefined;
    const bridge = this.bridge; this.bridge = undefined;
    this.status.hide(); await bridge?.stop();
  }
  dispose(): void { this.disposed = true; void this.stop(); this.status.dispose(); }

  private async showSetup(): Promise<void> {
    const args = [join(this.directory, "server.cjs"), join(this.directory, "endpoint.json")];
    const config = `[mcp_servers.xm_cloud_sync]\ncommand = "node"\nargs = ${JSON.stringify(args)}\ntool_timeout_sec = 190\n`;
    const content = `XM Cloud Sync MCP access is running locally (read access to selected connections).\n\nRequires Node.js 20.11+ on the MCP client's PATH and this VS Code window to remain open.\n\nAdd this block to your MCP client's config.toml, then reconnect/restart its MCP connection:\n\n${config}\nFor clients using JSON configuration:\n${JSON.stringify({ mcpServers: { xm_cloud_sync: { command: "node", args } } }, null, 2)}\n\nCredentials stay in VS Code SecretStorage. The endpoint file contains a temporary local access token; do not share it.\nUse Enable MCP Mutations only for a development connection. Each mutation opens a preview and requires confirmation in VS Code.\nClick the MCP status indicator or run Stop MCP Access to revoke access. Restarting VS Code does not automatically start access.\n`;
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ content, language: "plaintext" }), { preview: false });
  }
}
