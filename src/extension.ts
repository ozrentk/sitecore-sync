import * as vscode from "vscode";
import { ComparisonPanelManager } from "./comparison/comparisonPanel";
import {
  addConnection,
  configureDeploymentMonitoring,
  pasteAsConnectionUrl,
  removeConnection,
  testConnection,
} from "./connections/connectionCommands";
import { ConnectionStore } from "./connections/connectionStore";
import {
  ConnectionTreeItem,
  ConnectionTreeProvider,
  FavoriteTreeItem,
} from "./connections/connectionTreeProvider";
import { AuthoringContentClient } from "./sitecore/authoringClient";
import { DeploymentClient } from "./sitecore/deploymentClient";
import { ItemTaskRunner } from "./tasks/itemTaskRunner";
import { TransferProcessor } from "./transfers/transferProcessor";
import { TransferQueueStore } from "./transfers/transferQueueStore";
import { TransfersTreeProvider, TransferTreeItem } from "./transfers/transfersTreeProvider";
import { PublishingClient } from "./sitecore/publishingClient";
import { ExperienceEdgeClient } from "./sitecore/experienceEdgeClient";
import { PublishingManager } from "./publishing/publishingManager";
import { OperationDetailsPanel } from "./operations/operationDetailsPanel";

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("XM Cloud Sync", { log: true });
  const connectionStore = new ConnectionStore(context.globalState, context.secrets);
  const connectionProvider = new ConnectionTreeProvider(connectionStore);
  const authoringClient = new AuthoringContentClient(log);
  const deploymentClient = new DeploymentClient(log);
  const taskOutput = vscode.window.createOutputChannel("XM Cloud Tasks");
  const publishOutput = vscode.window.createOutputChannel("XM Cloud Publish");
  const publishingClient = new PublishingClient(log);
  const experienceEdgeClient = new ExperienceEdgeClient(log);
  const transferQueue = new TransferQueueStore(context.workspaceState);
  const operationDetails = new OperationDetailsPanel(
    context.extensionUri,
    [
      "xmCloudSync.retryPublishTraceVerification",
      "xmCloudSync.republishTrace",
      "xmCloudSync.recheckPublishTraceStatus",
    ],
  );
  const publishingManager = new PublishingManager(
    context.extensionUri,
    context.workspaceState,
    context.globalState,
    context.globalStorageUri,
    connectionStore,
    authoringClient,
    publishingClient,
    experienceEdgeClient,
    publishOutput,
    transferQueue,
    operationDetails,
  );
  const itemTaskRunner = new ItemTaskRunner(
    context.globalStorageUri,
    context.extensionUri,
    connectionStore,
    authoringClient,
    taskOutput,
  );
  const extensionVersion = String(context.extension.packageJSON.version ?? "unknown");
  const transferProcessor = new TransferProcessor(
    transferQueue,
    connectionStore,
    authoringClient,
    deploymentClient,
    context.globalStorageUri,
    extensionVersion,
    log,
    (runId) => publishingManager.executeQueued(runId),
  );
  const transfersProvider = new TransfersTreeProvider(transferQueue, connectionStore);
  const comparisonPanelManager = new ComparisonPanelManager(
    context.extensionUri,
    context.workspaceState,
    context.globalState,
    connectionStore,
    authoringClient,
    transferQueue,
    itemTaskRunner,
    publishingManager,
    log,
  );
  const connectionsView = vscode.window.createTreeView("xmCloudSync.connections", {
    treeDataProvider: connectionProvider,
  });
  const transfersView = vscode.window.createTreeView("xmCloudSync.operations", {
    treeDataProvider: transfersProvider,
  });
  const updateTransfersBadge = (): void => {
    const records = transferQueue.list();
    const queued = records.filter((record) => record.status === "queued").length;
    const failed = records.filter((record) => record.status === "failed").length;
    const running = records.length - queued - failed;
    const parts = [
      queued ? `${queued} queued` : undefined,
      running ? `${running} running/waiting` : undefined,
      failed ? `${failed} require attention` : undefined,
    ].filter((part): part is string => Boolean(part));
    transfersView.badge = records.length
      ? {
          value: records.length,
          tooltip: `${records.length} active operation(s): ${parts.join(", ")}`,
        }
      : undefined;
  };
  updateTransfersBadge();

  let selectedConnectionItem: ConnectionTreeItem | undefined;
  const connectionIsInUse = (connectionId: string): boolean =>
    comparisonPanelManager.isConnectionInOpenComparison(connectionId) ||
    transferQueue.referencesConnection(connectionId);
  const updateConnectionRemovalContext = async (): Promise<void> => {
    const selected = selectedConnectionItem?.connection;
    await Promise.all([
      vscode.commands.executeCommand(
        "setContext",
        "xmCloudSync.connectionSelected",
        Boolean(selected),
      ),
      vscode.commands.executeCommand(
        "setContext",
        "xmCloudSync.selectedConnectionRemovable",
        Boolean(selected && !connectionIsInUse(selected.id)),
      ),
    ]);
  };

  context.subscriptions.push(
    log,
    connectionStore,
    connectionProvider,
    transferQueue,
    transferProcessor,
    transfersProvider,
    operationDetails,
    itemTaskRunner,
    publishOutput,
    publishingManager,
    { dispose: () => {
      authoringClient.clear();
      deploymentClient.clear();
      publishingClient.clear();
      experienceEdgeClient.clear();
    } },
    comparisonPanelManager,
    connectionsView,
    transfersView,
    connectionsView.onDidChangeSelection((event) => {
      selectedConnectionItem = event.selection[0] instanceof ConnectionTreeItem
        ? event.selection[0]
        : undefined;
      void updateConnectionRemovalContext();
    }),
    comparisonPanelManager.onDidChangeComparisonState(() => {
      void updateConnectionRemovalContext();
    }),
    connectionStore.onDidChange(() => {
      if (selectedConnectionItem && !connectionStore.get(selectedConnectionItem.connection.id)) {
        selectedConnectionItem = undefined;
      }
      void updateConnectionRemovalContext();
    }),
    transferQueue.onDidChange(() => {
      updateTransfersBadge();
      void updateConnectionRemovalContext();
    }),
    transferProcessor.onDidStartRecord((record) => {
      void comparisonPanelManager.handleTransferStarted(record);
    }),
    transferProcessor.onDidCompleteRecord((record) => {
      void comparisonPanelManager.handleTransferCompleted(record);
    }),
    transferProcessor.onDidFailRecord((record) => {
      void comparisonPanelManager.handleTransferFailed(record);
    }),
    vscode.window.registerWebviewViewProvider(
      "xmCloudSync.fieldDiff",
      comparisonPanelManager.fieldDiffViewProvider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("xmCloudSync.addConnection", async () => {
      await addConnection(connectionStore, connectionProvider, authoringClient);
    }),
    vscode.commands.registerCommand("xmCloudSync.pasteAsConnectionUrl", async () => {
      await pasteAsConnectionUrl(connectionStore, connectionProvider, authoringClient);
    }),
    vscode.commands.registerCommand("xmCloudSync.testConnection", async (argument) => {
      await testConnection(argument, connectionStore, connectionProvider, authoringClient);
    }),
    vscode.commands.registerCommand("xmCloudSync.configureDeploymentMonitoring", async (argument) => {
      await configureDeploymentMonitoring(argument, connectionStore, deploymentClient);
    }),
    vscode.commands.registerCommand("xmCloudSync.removeConnection", async (argument) => {
      await removeConnection(
        argument instanceof ConnectionTreeItem ? argument : selectedConnectionItem,
        connectionStore,
        connectionIsInUse,
      );
    }),
    vscode.commands.registerCommand("xmCloudSync.openComparison", async () => {
      await comparisonPanelManager.open();
    }),
    vscode.commands.registerCommand("xmCloudSync.openFavorite", async (argument) => {
      if (argument instanceof FavoriteTreeItem) {
        await comparisonPanelManager.openFavorite(argument.connection.id, argument.path);
      }
    }),
    vscode.commands.registerCommand("xmCloudSync.removeFavorite", async (argument) => {
      if (argument instanceof FavoriteTreeItem) {
        await connectionStore.removeFavoritePath(argument.connection.id, argument.path);
      }
    }),
    vscode.commands.registerCommand("xmCloudSync.showLogs", () => log.show(true)),
    vscode.commands.registerCommand("xmCloudSync.showPublishOutput", () => publishOutput.show(true)),
    vscode.commands.registerCommand("xmCloudSync.showLatestPublishTrace", () => {
      publishingManager.showLatestTrace();
    }),
    vscode.commands.registerCommand(
      "xmCloudSync.retryPublishTraceVerification",
      async (runId: unknown) => {
        if (typeof runId === "string") {
          await publishingManager.retryFailedVerification(runId);
        }
      },
    ),
    vscode.commands.registerCommand("xmCloudSync.republishTrace", async (runId: unknown) => {
      if (typeof runId === "string") {
        await publishingManager.publishAgain(runId);
      }
    }),
    vscode.commands.registerCommand(
      "xmCloudSync.recheckPublishTraceStatus",
      async (runId: unknown) => {
        if (typeof runId === "string") {
          await publishingManager.recheckPublishStatus(runId);
        }
      },
    ),
    vscode.commands.registerCommand("xmCloudSync.abandonCurrentPublish", async () => {
      await publishingManager.abandonCurrentPublish();
    }),
    vscode.commands.registerCommand("xmCloudSync.configurePublishing", async (argument) => {
      await publishingManager.configureConnection(
        argument instanceof ConnectionTreeItem ? argument.connection.id : undefined,
      );
    }),
    vscode.commands.registerCommand("xmCloudSync.startTransfers", async () => {
      await transferProcessor.start();
    }),
    vscode.commands.registerCommand("xmCloudSync.pauseTransfers", async () => {
      await transferProcessor.pause();
    }),
    vscode.commands.registerCommand("xmCloudSync.toggleAllRecentOperations", () => {
      transfersProvider.toggleAllRecent();
    }),
    vscode.commands.registerCommand("xmCloudSync.retryTransfer", async (argument) => {
      if (argument instanceof TransferTreeItem) {
        await transferQueue.retry(argument.record.id);
      }
    }),
    vscode.commands.registerCommand("xmCloudSync.removeTransfer", async (argument) => {
      if (!(argument instanceof TransferTreeItem)) {
        return;
      }
      const current = transferQueue.get(argument.record.id);
      const removable = current && (
        current.status === "queued" ||
        current.status === "failed" ||
        (current.status === "waitingForSitecore" && transferQueue.processorState === "paused")
      );
      if (!removable) {
        await vscode.window.showInformationMessage(
          "This operation has started. Pause processing before removing it at a safe boundary.",
        );
        return;
      }
      const checkpointWarning = current.kind === "subtree" && current.checkpoint
        ? " The remote Sitecore operation may continue, but it will no longer be monitored."
        : "";
      const confirmed = await vscode.window.showWarningMessage(
        `Remove this operation from the queue?${checkpointWarning}`,
        { modal: true },
        "Remove Operation",
      );
      if (confirmed === "Remove Operation") {
        if (current.kind === "publishing") {
          await publishingManager.abandonQueuedRun(current.publishRunId);
        }
        await transferQueue.remove(current.id);
      }
    }),
    vscode.commands.registerCommand("xmCloudSync.moveOperationUp", async (argument) => {
      if (argument instanceof TransferTreeItem) {
        await transferQueue.move(argument.record.id, -1);
      }
    }),
    vscode.commands.registerCommand("xmCloudSync.moveOperationDown", async (argument) => {
      if (argument instanceof TransferTreeItem) {
        await transferQueue.move(argument.record.id, 1);
      }
    }),
    vscode.commands.registerCommand("xmCloudSync.openTransferJournal", async (argument) => {
      if (
        argument instanceof TransferTreeItem &&
        argument.record.kind !== "publishing" &&
        argument.record.journalPath
      ) {
        const document = await vscode.workspace.openTextDocument(argument.record.journalPath);
        await vscode.window.showTextDocument(document, { preview: false });
      }
    }),
    vscode.commands.registerCommand("xmCloudSync.openOperation", async (argument) => {
      if (!(argument instanceof TransferTreeItem)) {
        return;
      }
      const record = argument.record;
      if (record.kind === "publishing") {
        publishingManager.showTrace(record.publishRunId);
      } else {
        operationDetails.show(
          record.id,
          () => transferOperationHtml(record),
        );
      }
    }),
    vscode.commands.registerCommand("xmCloudSync.compareWithConnection", async (argument) => {
      if (!(argument instanceof ConnectionTreeItem) && !(argument instanceof FavoriteTreeItem)) {
        return;
      }
      const sourceConnection = argument.connection;
      const candidates = connectionStore.list();
      if (candidates.length === 0) {
        await vscode.window.showInformationMessage(
          "Add an XM Cloud connection before opening a comparison.",
        );
        return;
      }
      const selected = await vscode.window.showQuickPick(
        candidates.map((connection) => ({
          label: connection.name,
          description: connection.serverUrl,
          detail: connection.id === sourceConnection.id
            ? "Same connection; select different languages in the comparison tab"
            : undefined,
          connectionId: connection.id,
        })),
        { title: `Compare ${sourceConnection.name} with…`, placeHolder: "Select the right-side connection" },
      );
      if (selected) {
        if (argument instanceof FavoriteTreeItem) {
          await comparisonPanelManager.openFavoriteWith(
            sourceConnection.id,
            selected.connectionId,
            argument.path,
          );
        } else {
          await comparisonPanelManager.openWith(sourceConnection.id, selected.connectionId);
        }
      }
    }),
    vscode.commands.registerCommand("xmCloudSync.refreshAll", async () => {
      const requested = await comparisonPanelManager.refreshAll();
      if (!requested) {
        await vscode.window.showInformationMessage(
          "Open an XM Cloud comparison before refreshing its loaded data.",
        );
      }
    }),
    vscode.commands.registerCommand("xmCloudSync.openProductSpec", async () => {
      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.joinPath(context.extensionUri, "PRODUCT_SPEC.md"),
      );
      await vscode.window.showTextDocument(document, { preview: false });
    }),
  );
  void updateConnectionRemovalContext();
  void publishingManager.enqueuePendingRuns().then(() =>
    transferProcessor.resumeIfRunning()
  );
}

export function deactivate(): void {
  // VS Code disposes subscriptions registered on the extension context.
}

function transferOperationHtml(
  record: Exclude<TransferTreeItem["record"], { readonly kind: "publishing" }>,
): string {
  const title = record.kind === "fieldValue" ? "Field-value Transfer" : "Subtree Transfer";
  const source = record.kind === "fieldValue"
    ? `${record.source.connectionName}: ${record.source.itemPath}`
    : `${record.sourceConnectionName}: ${record.sourcePath}`;
  const target = record.kind === "fieldValue"
    ? `${record.target.connectionName}: ${record.target.itemPath}`
    : record.targetConnectionName;
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
body{font-family:var(--vscode-font-family);padding:24px;color:var(--vscode-foreground)}
.summary{border-left:3px solid var(--vscode-focusBorder);padding:12px;background:var(--vscode-editor-inactiveSelectionBackground)}
dt{font-weight:600;margin-top:10px}dd{margin-left:0}pre{padding:12px;overflow:auto;background:var(--vscode-textCodeBlock-background)}
</style></head><body>
<h1>${escapeHtml(title)}</h1>
<div class="summary"><strong>${escapeHtml(record.status)}</strong>${record.error ? ` — ${escapeHtml(record.error)}` : ""}</div>
<dl><dt>Source</dt><dd>${escapeHtml(source)}</dd><dt>Destination</dt><dd>${escapeHtml(target)}</dd>
<dt>Queued</dt><dd>${escapeHtml(record.enqueuedAt)}</dd>${record.startedAt ? `<dt>Started</dt><dd>${escapeHtml(record.startedAt)}</dd>` : ""}
${record.completedAt ? `<dt>Completed</dt><dd>${escapeHtml(record.completedAt)}</dd>` : ""}</dl>
<h2>Evidence</h2><pre>${escapeHtml(JSON.stringify(record, null, 2))}</pre>
</body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}
