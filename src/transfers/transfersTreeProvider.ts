import * as vscode from "vscode";
import type { ConnectionStore } from "../connections/connectionStore";
import type { TransferQueueStore } from "./transferQueueStore";
import {
  subtreeTransferMode,
  subtreeTransferModeLabel,
  type OperationRecord,
} from "./transferTypes";

export class TransferTreeItem extends vscode.TreeItem {
  constructor(readonly record: OperationRecord, description: string) {
    super(operationLabel(record), vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.contextValue = `xmCloudOperation.${record.kind}.${record.status}`;
    this.iconPath = operationIcon(record);
    this.tooltip = operationTooltip(record);
    this.command = {
      command: "xmCloudSync.openOperation",
      title: "Open Operation",
      arguments: [this],
    };
  }
}

class OperationGroupItem extends vscode.TreeItem {
  constructor(
    readonly group: "queue" | "recent",
    count: number,
  ) {
    super(
      group === "queue" ? "Queue" : "Recent Operations",
      vscode.TreeItemCollapsibleState.Expanded,
    );
    this.description = String(count);
    this.contextValue = `xmCloudOperationGroup.${group}`;
    this.iconPath = new vscode.ThemeIcon(group === "queue" ? "list-ordered" : "history");
  }
}

type OperationTreeElement = TransferTreeItem | OperationGroupItem;

export class TransfersTreeProvider
implements vscode.TreeDataProvider<OperationTreeElement>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<OperationTreeElement | undefined>();
  private readonly storeSubscription: vscode.Disposable;
  private readonly durationRefresh: ReturnType<typeof setInterval>;
  private showAllRecent = false;

  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(
    private readonly store: TransferQueueStore,
    private readonly connections: ConnectionStore,
  ) {
    this.storeSubscription = store.onDidChange(() => this.changeEmitter.fire(undefined));
    this.durationRefresh = setInterval(() => {
      if (store.list().some((record) =>
        record.kind === "subtree" &&
        record.status === "waitingForSitecore" &&
        record.progress?.stage === "sitecore"
      )) {
        this.changeEmitter.fire(undefined);
      }
    }, 5_000);
  }

  getTreeItem(element: OperationTreeElement): vscode.TreeItem {
    return element;
  }

  getChildren(element?: OperationTreeElement): OperationTreeElement[] {
    if (!element) {
      const queue = this.store.list();
      const recent = this.store.listRecent();
      return [
        new OperationGroupItem("queue", queue.length),
        new OperationGroupItem("recent", recent.length),
      ];
    }
    if (element instanceof TransferTreeItem) {
      return [];
    }
    const records = element.group === "queue"
      ? this.store.list()
      : this.showAllRecent
        ? this.store.listRecent()
        : this.store.listRecent().slice(0, 10);
    return records.map((record) => new TransferTreeItem(
      record,
      this.description(record),
    ));
  }

  toggleAllRecent(): void {
    this.showAllRecent = !this.showAllRecent;
    this.changeEmitter.fire(undefined);
  }

  private description(record: OperationRecord): string {
    if (record.kind === "publishing") {
      const connection = this.connections.get(record.connectionId)?.name ??
        record.connectionName;
      return `${connection} · ${record.language} · ${
        record.progressSummary ?? statusLabel(record)
      }`;
    }
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
    return `${source} → ${target} · ${statusLabel(record)}`;
  }

  dispose(): void {
    clearInterval(this.durationRefresh);
    this.storeSubscription.dispose();
    this.changeEmitter.dispose();
  }
}

function operationLabel(record: OperationRecord): string {
  if (record.kind === "publishing") {
    return `${publishKindLabel(record.publishKind)} · ${itemName(record.itemPath)}`;
  }
  return record.kind === "fieldValue"
    ? `Field ${fieldName(record)} · ${itemName(record.source.itemPath)}`
    : `Subtree · ${itemName(record.sourcePath)} · ${
        subtreeTransferModeLabel(subtreeTransferMode(record))
      }`;
}

function itemName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function publishKindLabel(kind: Extract<OperationRecord, { readonly kind: "publishing" }>["publishKind"]): string {
  switch (kind) {
    case "standard": return "Standard publish";
    case "traced": return "Traced publish";
    case "power": return "Power publish";
  }
}

function fieldName(record: Extract<OperationRecord, { readonly kind: "fieldValue" }>): string {
  return record.source.fieldName === record.target.fieldName
    ? record.source.fieldName
    : `${record.source.fieldName} → ${record.target.fieldName}`;
}

function fieldPath(itemPath: string, name: string): string {
  return `${itemPath.replace(/\/$/u, "")}/${name}`;
}

function statusLabel(record: OperationRecord): string {
  if (record.kind === "publishing") {
    switch (record.status) {
      case "queued": return "queued";
      case "preflighting": return "preparing";
      case "executing": return "publishing";
      case "waitingForSitecore": return "waiting for Sitecore";
      case "verifying": return "verifying";
      case "failed": return "failed";
      case "completed": return "completed";
    }
  }
  if (record.kind === "fieldValue") {
    switch (record.status) {
      case "queued": return "queued (1/4)";
      case "preflighting": return "checking freshness (2/4)";
      case "executing": return "updating field (3/4)";
      case "verifying": return "verifying (4/4)";
      case "waitingForSitecore": return "waiting for Sitecore";
      case "failed": return "failed";
      case "completed": return "completed";
    }
  }
  switch (record.status) {
    case "queued": return "queued (1/6)";
    case "preflighting": return "checking freshness (2/6)";
    case "executing": return subtreeProgressLabel(record) ?? "exporting content (3/6)";
    case "waitingForSitecore": return subtreeProgressLabel(record) ?? "Sitecore (5/6)";
    case "verifying": return "verifying (6/6)";
    case "failed": {
      const phase = subtreeProgressLabel(record);
      return phase ? `failed · ${phase}` : "failed";
    }
    case "completed": return "completed";
  }
}

function subtreeProgressLabel(
  record: Extract<OperationRecord, { readonly kind: "subtree" }>,
): string | undefined {
  switch (record.progress?.stage) {
    case "exportingContent": return "exporting content (3/6)";
    case "copyingChunks":
      return `copying chunks (4/6, chunk ${record.progress.current}/${record.progress.total})`;
    case "sitecore": {
      const elapsed = record.status === "waitingForSitecore"
        ? `, ${formatElapsed(record.progress.startedAt)}`
        : "";
      return `Sitecore (5/6, blob ${record.progress.completed}/${record.progress.total} imported${elapsed})`;
    }
    case "verifying": return "verifying (6/6)";
    default: return undefined;
  }
}

function operationIcon(record: OperationRecord): vscode.ThemeIcon {
  switch (record.status) {
    case "queued": return new vscode.ThemeIcon("clock");
    case "preflighting": return new vscode.ThemeIcon("search");
    case "executing": return new vscode.ThemeIcon("sync~spin");
    case "waitingForSitecore": return new vscode.ThemeIcon("sync~spin");
    case "verifying": return new vscode.ThemeIcon("pass-pending");
    case "failed": return new vscode.ThemeIcon("error", new vscode.ThemeColor("errorForeground"));
    case "completed": return new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed"));
  }
}

function operationTooltip(record: OperationRecord): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString(undefined, true);
  if (record.kind === "publishing") {
    tooltip.appendMarkdown(`**${publishKindLabel(record.publishKind)}**\n\n`);
    tooltip.appendMarkdown(`Status: ${statusLabel(record)}  \n`);
    tooltip.appendMarkdown(`Connection: ${escapeMarkdown(record.connectionName)}  \n`);
    tooltip.appendMarkdown(`Item: ${escapeMarkdown(record.itemPath)}  \n`);
    tooltip.appendMarkdown(`Language: ${escapeMarkdown(record.language)}  \n`);
    tooltip.appendMarkdown(`Queued: ${record.enqueuedAt}  \n`);
    if (record.completedAt) {
      tooltip.appendMarkdown(`Completed: ${record.completedAt}  \n`);
    }
    if (record.error) {
      tooltip.appendMarkdown(`\n**Error:** ${escapeMarkdown(record.error)}`);
    }
    return tooltip;
  }
  tooltip.appendMarkdown(`**${record.kind === "fieldValue" ? "Field value" : "Subtree"} transfer**\n\n`);
  tooltip.appendMarkdown(`Status: ${statusLabel(record)}  \n`);
  tooltip.appendMarkdown(`Queued: ${record.enqueuedAt}  \n`);
  if (record.startedAt) {
    tooltip.appendMarkdown(`Started: ${record.startedAt}  \n`);
  }
  if (record.kind === "fieldValue") {
    tooltip.appendMarkdown(`Field name: ${escapeMarkdown(fieldName(record))}  \n`);
    if (record.source.fieldLabel !== record.source.fieldName) {
      tooltip.appendMarkdown(`Field label: ${escapeMarkdown(record.source.fieldLabel)}  \n`);
    }
    tooltip.appendMarkdown(`Source field path: ${escapeMarkdown(fieldPath(record.source.itemPath, record.source.fieldName))}  \n`);
    tooltip.appendMarkdown(`Target field path: ${escapeMarkdown(fieldPath(record.target.itemPath, record.target.fieldName))}  \n`);
    tooltip.appendMarkdown(`Source item: \`${record.source.itemId}\` (${record.source.language}, v${record.source.version})  \n`);
    tooltip.appendMarkdown(`Target item: \`${record.target.itemId}\` (${record.target.language}, v${record.target.version})  \n`);
  } else {
    tooltip.appendMarkdown(
      `Type: ${subtreeTransferModeLabel(subtreeTransferMode(record))}  \n`,
    );
    tooltip.appendMarkdown(`Path: ${escapeMarkdown(record.sourcePath)}  \n`);
    tooltip.appendMarkdown(`Source item: \`${record.sourceItemId}\`  \n`);
    if (record.preflight) {
      tooltip.appendMarkdown(
        `Preflight: source ${record.preflight.sourceItems}, target ${record.preflight.targetItems}, ` +
        `add ${record.preflight.addItems}, update ${record.preflight.updateItems}, ` +
        `remove ${record.preflight.removeItems}  \n`,
      );
    }
    if (record.checkpoint) {
      tooltip.appendMarkdown(`Remote transfer: \`${record.checkpoint.transferId}\`  \n`);
    }
    if (record.deploymentBaselines) {
      tooltip.appendMarkdown(
        `Source deployment baseline: ${escapeMarkdown(deploymentBaselineLabel(record.deploymentBaselines.source))}  \n`,
      );
      tooltip.appendMarkdown(
        `Destination deployment baseline: ${escapeMarkdown(deploymentBaselineLabel(record.deploymentBaselines.target))}  \n`,
      );
    }
  }
  if (record.error) {
    tooltip.appendMarkdown(`\n**Error:** ${escapeMarkdown(record.error)}`);
  }
  return tooltip;
}

function deploymentBaselineLabel(
  baseline: NonNullable<Extract<OperationRecord, { readonly kind: "subtree" }>["deploymentBaselines"]>["source"],
): string {
  const timestamp = baseline.createdAt ?? baseline.startedAt ?? baseline.deploymentStartedAt;
  if (!baseline.deploymentId) {
    return "none";
  }
  return timestamp ? `${baseline.deploymentId} at ${timestamp}` : baseline.deploymentId;
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+.!-]/gu, "\\$&");
}

function formatElapsed(startedAt: string): string {
  const started = Date.parse(startedAt);
  const totalSeconds = Number.isFinite(started)
    ? Math.max(0, Math.floor((Date.now() - started) / 1_000))
    : 0;
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}
