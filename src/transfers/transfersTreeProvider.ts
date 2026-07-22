import * as vscode from "vscode";
import type { ConnectionStore } from "../connections/connectionStore";
import type { TransferQueueStore } from "./transferQueueStore";
import type { TransferRecord } from "./transferTypes";

export class TransferTreeItem extends vscode.TreeItem {
  constructor(readonly record: TransferRecord, position: number, description: string) {
    super(transferLabel(record, position), vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.contextValue = `xmCloudTransfer.${record.status}`;
    this.iconPath = transferIcon(record);
    this.tooltip = transferTooltip(record);
  }
}

export class TransfersTreeProvider
implements vscode.TreeDataProvider<TransferTreeItem>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<TransferTreeItem | undefined>();
  private readonly storeSubscription: vscode.Disposable;

  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(
    private readonly store: TransferQueueStore,
    private readonly connections: ConnectionStore,
  ) {
    this.storeSubscription = store.onDidChange(() => this.changeEmitter.fire(undefined));
  }

  getTreeItem(element: TransferTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): TransferTreeItem[] {
    return this.store.list().map((record, index) => new TransferTreeItem(
      record,
      index + 1,
      this.description(record),
    ));
  }

  private description(record: TransferRecord): string {
    const sourceId = record.kind === "fieldValue"
      ? record.source.connectionId
      : record.sourceConnectionId;
    const targetId = record.kind === "fieldValue"
      ? record.target.connectionId
      : record.targetConnectionId;
    const sourceFallback = record.kind === "fieldValue"
      ? record.source.connectionName
      : record.sourceConnectionName;
    const targetFallback = record.kind === "fieldValue"
      ? record.target.connectionName
      : record.targetConnectionName;
    const source = this.connections.get(sourceId)?.name ?? sourceFallback;
    const target = this.connections.get(targetId)?.name ?? targetFallback;
    return `${source} → ${target} · ${statusLabel(record.status)}`;
  }

  dispose(): void {
    this.storeSubscription.dispose();
    this.changeEmitter.dispose();
  }
}

function transferLabel(record: TransferRecord, position: number): string {
  return record.kind === "fieldValue"
    ? `${position}. Field · ${record.source.fieldLabel}`
    : `${position}. Subtree · ${record.sourcePath}`;
}

function statusLabel(status: TransferRecord["status"]): string {
  switch (status) {
    case "queued": return "queued";
    case "preflighting": return "checking freshness";
    case "executing": return "transferring";
    case "waitingForSitecore": return "waiting for Sitecore";
    case "verifying": return "verifying";
    case "failed": return "failed";
  }
}

function transferIcon(record: TransferRecord): vscode.ThemeIcon {
  switch (record.status) {
    case "queued": return new vscode.ThemeIcon("clock");
    case "preflighting": return new vscode.ThemeIcon("search");
    case "executing": return new vscode.ThemeIcon("sync~spin");
    case "waitingForSitecore": return new vscode.ThemeIcon("cloud-download");
    case "verifying": return new vscode.ThemeIcon("pass-pending");
    case "failed": return new vscode.ThemeIcon("error", new vscode.ThemeColor("errorForeground"));
  }
}

function transferTooltip(record: TransferRecord): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString(undefined, true);
  tooltip.appendMarkdown(`**${record.kind === "fieldValue" ? "Field value" : "Subtree"} transfer**\n\n`);
  tooltip.appendMarkdown(`Status: ${statusLabel(record.status)}  \n`);
  tooltip.appendMarkdown(`Queued: ${record.enqueuedAt}  \n`);
  if (record.startedAt) {
    tooltip.appendMarkdown(`Started: ${record.startedAt}  \n`);
  }
  if (record.kind === "fieldValue") {
    tooltip.appendMarkdown(`Field: ${escapeMarkdown(record.source.fieldLabel)}  \n`);
    tooltip.appendMarkdown(`Source item: \`${record.source.itemId}\` (${record.source.language}, v${record.source.version})  \n`);
    tooltip.appendMarkdown(`Target item: \`${record.target.itemId}\` (${record.target.language}, v${record.target.version})  \n`);
  } else {
    tooltip.appendMarkdown(`Path: ${escapeMarkdown(record.sourcePath)}  \n`);
    tooltip.appendMarkdown(`Source item: \`${record.sourceItemId}\`  \n`);
    if (record.checkpoint) {
      tooltip.appendMarkdown(`Remote transfer: \`${record.checkpoint.transferId}\`  \n`);
    }
  }
  if (record.error) {
    tooltip.appendMarkdown(`\n**Error:** ${escapeMarkdown(record.error)}`);
  }
  return tooltip;
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+.!-]/gu, "\\$&");
}
