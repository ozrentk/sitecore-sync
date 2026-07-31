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
import {
  OperationSequenceTreeItem,
  SequenceOperationTreeItem,
  SequenceRunTreeItem,
  TransfersTreeProvider,
  TransferTreeItem,
} from "./transfers/transfersTreeProvider";
import { PublishingClient } from "./sitecore/publishingClient";
import { ExperienceEdgeClient } from "./sitecore/experienceEdgeClient";
import {
  PowerPublishReviewRequiredError,
  PublishingManager,
} from "./publishing/publishingManager";
import { OperationDetailsPanel } from "./operations/operationDetailsPanel";
import { OperationIntentService } from "./operations/operationIntentService";
import { OperationSequenceRunner } from "./operations/operationSequenceRunner";
import { OperationSequenceStore } from "./operations/operationSequenceStore";
import {
  operationIntentLabel,
  type OperationIntent,
  type OperationSequenceRun,
  type SavedOperationSequence,
} from "./operations/operationTypes";

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
  const sequenceStore = new OperationSequenceStore(context.workspaceState);
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
  const operationIntents = new OperationIntentService(
    connectionStore,
    authoringClient,
    transferQueue,
    publishingManager,
  );
  const sequenceRunner = new OperationSequenceRunner(
    sequenceStore,
    transferQueue,
    transferProcessor,
    operationIntents,
    log,
  );
  transferQueue.setStandaloneEnqueueGuard(() =>
    !sequenceRunner.isStarting && !sequenceStore.runningRun()
  );
  const transfersProvider = new TransfersTreeProvider(
    transferQueue,
    connectionStore,
    sequenceStore,
  );
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
    const standaloneRecords = records.filter((record) => !record.sequenceRunId);
    const sequenceRuns = sequenceStore.listActiveRuns();
    const queued = standaloneRecords.filter((record) => record.status === "queued").length;
    const failed = standaloneRecords.filter((record) => record.status === "failed").length;
    const running = standaloneRecords.length - queued - failed;
    const parts = [
      queued ? `${queued} queued` : undefined,
      running ? `${running} running/waiting` : undefined,
      failed ? `${failed} require attention` : undefined,
    ].filter((part): part is string => Boolean(part));
    const badgeCount = standaloneRecords.length + sequenceRuns.length;
    transfersView.badge = badgeCount
      ? {
          value: badgeCount,
          tooltip: [
            standaloneRecords.length
              ? `${standaloneRecords.length} standalone operation(s): ${parts.join(", ")}`
              : undefined,
            sequenceRuns.length ? `${sequenceRuns.length} active or paused sequence run(s)` : undefined,
          ].filter((part): part is string => Boolean(part)).join("; "),
        }
      : undefined;
  };
  updateTransfersBadge();

  let selectedConnectionItem: ConnectionTreeItem | undefined;
  const connectionIsInUse = (connectionId: string): boolean =>
    comparisonPanelManager.isConnectionInOpenComparison(connectionId) ||
    transferQueue.referencesConnection(connectionId) ||
    sequenceStore.referencesConnection(connectionId);
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
    sequenceStore,
    transferProcessor,
    sequenceRunner,
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
    sequenceStore.onDidChange(() => {
      updateTransfersBadge();
      void updateConnectionRemovalContext();
      for (const sequence of sequenceStore.listDefinitions()) {
        const run = sequenceStore.activeRunForDefinition(sequence.id);
        operationDetails.renderIfDisplayed(
          `sequence:${sequence.id}`,
          () => sequenceHtml(sequence, run),
        );
      }
      for (const run of [
        ...sequenceStore.listActiveRuns(),
        ...sequenceStore.listRecentRuns(),
      ]) {
        operationDetails.renderIfDisplayed(
          `sequence-run:${run.id}`,
          () => sequenceHtml(run.definitionSnapshot, run),
        );
      }
    }),
    transferProcessor.onDidStartRecord((record) => {
      if (record.kind !== "publishing") {
        void comparisonPanelManager.handleTransferStarted(record);
      }
    }),
    transferProcessor.onDidCompleteRecord((record) => {
      if (record.kind !== "publishing") {
        void comparisonPanelManager.handleTransferCompleted(record);
      }
    }),
    transferProcessor.onDidFailRecord((record) => {
      if (record.kind !== "publishing") {
        void comparisonPanelManager.handleTransferFailed(record);
      }
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
    vscode.commands.registerCommand("xmCloudSync.repairPowerPublish", async (runId: unknown) => {
      if (typeof runId === "string") {
        await publishingManager.repairPowerPublish(runId);
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
    vscode.commands.registerCommand("xmCloudSync.replayOperation", async (argument) => {
      if (!(argument instanceof TransferTreeItem)) {
        return;
      }
      const intent = operationIntents.intentForRecord(argument.record);
      if (!intent) {
        await vscode.window.showInformationMessage(
          "This older operation does not contain enough reusable input to replay safely.",
        );
        return;
      }
      try {
        const problem = await operationIntents.validate(intent);
        if (problem) {
          throw new Error(problem);
        }
        const replayed = await operationIntents.enqueue(intent);
        await vscode.window.showInformationMessage(
          `${operationIntentLabel(intent)} added to Operations for replay.`,
        );
        if (replayed.kind === "publishing") {
          publishingManager.showTrace(replayed.publishRunId);
        }
      } catch (error: unknown) {
        if (error instanceof PowerPublishReviewRequiredError && intent.kind === "publishing") {
          const choice = await vscode.window.showWarningMessage(
            `${error.message} Review Power Publish scope before replaying.`,
            "Review Power Publish Scope",
          );
          if (choice === "Review Power Publish Scope") {
            await publishingManager.start("power", {
              connectionId: intent.connectionId,
              side: "left",
              itemId: intent.rootItemId,
              path: intent.rootPath,
              language: intent.language,
            });
          }
          return;
        }
        await vscode.window.showErrorMessage(`Unable to replay operation: ${errorMessage(error)}`);
      }
    }),
    vscode.commands.registerCommand("xmCloudSync.createSequenceFromOperation", async (argument) => {
      if (!(argument instanceof TransferTreeItem)) {
        return;
      }
      const intent = operationIntents.intentForRecord(argument.record);
      if (!intent) {
        await vscode.window.showInformationMessage(
          "This older operation does not contain enough reusable input for a sequence.",
        );
        return;
      }
      const name = await vscode.window.showInputBox({
        title: "Create Operation Sequence",
        prompt: "Sequence name",
        value: sequenceNameFromIntent(intent, connectionStore),
        ignoreFocusOut: true,
        validateInput: (value) => value.trim() ? undefined : "Enter a sequence name.",
      });
      if (!name) {
        return;
      }
      const description = await vscode.window.showInputBox({
        title: "Create Operation Sequence",
        prompt: "Optional description",
        ignoreFocusOut: true,
      });
      if (description === undefined) {
        return;
      }
      await sequenceStore.create(name, description, [intent]);
      await vscode.window.showInformationMessage(`Created operation sequence “${name}”.`);
    }),
    vscode.commands.registerCommand("xmCloudSync.addOperationToSequence", async (argument) => {
      if (!(argument instanceof TransferTreeItem)) {
        return;
      }
      const intent = operationIntents.intentForRecord(argument.record);
      if (!intent) {
        await vscode.window.showInformationMessage(
          "This older operation does not contain enough reusable input for a sequence.",
        );
        return;
      }
      const available = sequenceStore.listDefinitions().filter((sequence) =>
        !sequenceStore.isDefinitionLocked(sequence.id)
      );
      const selected = await vscode.window.showQuickPick(
        available.map((sequence) => ({
          label: sequence.name,
          description: `${sequence.operations.length} operation(s)`,
          sequenceId: sequence.id,
        })),
        { title: "Add Operation to Sequence", placeHolder: "Select an editable sequence" },
      );
      if (!selected) {
        if (!available.length) {
          await vscode.window.showInformationMessage("No editable operation sequence is available.");
        }
        return;
      }
      await sequenceStore.addOperation(selected.sequenceId, intent);
    }),
    vscode.commands.registerCommand("xmCloudSync.runSequence", async (argument) => {
      if (!(argument instanceof OperationSequenceTreeItem)) {
        return;
      }
      await runSequenceCommand(() => sequenceRunner.start(argument.sequence));
    }),
    vscode.commands.registerCommand("xmCloudSync.pauseSequence", async (argument) => {
      const run = activeRunFromItem(argument, sequenceStore);
      if (run) {
        await runSequenceCommand(() => sequenceRunner.pause(run.id));
      }
    }),
    vscode.commands.registerCommand("xmCloudSync.resumeSequence", async (argument) => {
      const run = activeRunFromItem(argument, sequenceStore);
      if (run) {
        await runSequenceCommand(() => sequenceRunner.resume(run.id));
      }
    }),
    vscode.commands.registerCommand("xmCloudSync.retrySequenceOperation", async (argument) => {
      const run = activeRunFromItem(argument, sequenceStore);
      if (run) {
        await runSequenceCommand(() => sequenceRunner.retryOperation(run.id));
      }
    }),
    vscode.commands.registerCommand("xmCloudSync.skipSequenceOperation", async (argument) => {
      const run = activeRunFromItem(argument, sequenceStore);
      if (run) {
        const confirmed = await vscode.window.showWarningMessage(
          "Skip the current failed operation and continue this sequence?",
          { modal: true },
          "Skip Operation",
        );
        if (confirmed === "Skip Operation") {
          await runSequenceCommand(() => sequenceRunner.skipOperation(run.id));
        }
      }
    }),
    vscode.commands.registerCommand("xmCloudSync.stopSequence", async (argument) => {
      const run = activeRunFromItem(argument, sequenceStore);
      if (!run) {
        return;
      }
      const confirmed = await vscode.window.showWarningMessage(
        "Stop this sequence? An operation already submitted to Sitecore will be allowed to finish.",
        { modal: true },
        "Stop Sequence",
      );
      if (confirmed === "Stop Sequence") {
        await runSequenceCommand(() => sequenceRunner.stop(run.id));
      }
    }),
    vscode.commands.registerCommand("xmCloudSync.editSequence", async (argument) => {
      if (!(argument instanceof OperationSequenceTreeItem)) {
        return;
      }
      const name = await vscode.window.showInputBox({
        title: "Edit Operation Sequence",
        value: argument.sequence.name,
        validateInput: (value) => value.trim() ? undefined : "Enter a sequence name.",
      });
      if (!name) {
        return;
      }
      const description = await vscode.window.showInputBox({
        title: "Edit Operation Sequence",
        prompt: "Optional description",
        value: argument.sequence.description ?? "",
      });
      if (description === undefined) {
        return;
      }
      await runSequenceCommand(() =>
        sequenceStore.updateDetails(argument.sequence.id, name, description)
      );
    }),
    vscode.commands.registerCommand("xmCloudSync.duplicateSequence", async (argument) => {
      if (!(argument instanceof OperationSequenceTreeItem)) {
        return;
      }
      const name = await vscode.window.showInputBox({
        title: "Duplicate Operation Sequence",
        value: `${argument.sequence.name} - Copy`,
        validateInput: (value) => value.trim() ? undefined : "Enter a sequence name.",
      });
      if (name) {
        await sequenceStore.create(
          name,
          argument.sequence.description,
          argument.sequence.operations,
        );
      }
    }),
    vscode.commands.registerCommand("xmCloudSync.deleteSequence", async (argument) => {
      if (!(argument instanceof OperationSequenceTreeItem)) {
        return;
      }
      const confirmed = await vscode.window.showWarningMessage(
        `Delete operation sequence “${argument.sequence.name}”? Historical runs will remain available.`,
        { modal: true },
        "Delete Sequence",
      );
      if (confirmed === "Delete Sequence") {
        await runSequenceCommand(() => sequenceStore.delete(argument.sequence.id));
      }
    }),
    vscode.commands.registerCommand("xmCloudSync.moveSequenceOperationUp", async (argument) => {
      if (argument instanceof SequenceOperationTreeItem) {
        await runSequenceCommand(() =>
          sequenceStore.moveOperation(argument.sequence.id, argument.operationIndex, -1)
        );
      }
    }),
    vscode.commands.registerCommand("xmCloudSync.moveSequenceOperationDown", async (argument) => {
      if (argument instanceof SequenceOperationTreeItem) {
        await runSequenceCommand(() =>
          sequenceStore.moveOperation(argument.sequence.id, argument.operationIndex, 1)
        );
      }
    }),
    vscode.commands.registerCommand("xmCloudSync.removeSequenceOperation", async (argument) => {
      if (argument instanceof SequenceOperationTreeItem) {
        await runSequenceCommand(() =>
          sequenceStore.removeOperation(argument.sequence.id, argument.operationIndex)
        );
      }
    }),
    vscode.commands.registerCommand("xmCloudSync.openSequence", (argument) => {
      if (argument instanceof OperationSequenceTreeItem) {
        const run = sequenceStore.activeRunForDefinition(argument.sequence.id);
        operationDetails.show(
          `sequence:${argument.sequence.id}`,
          () => sequenceHtml(argument.sequence, run),
        );
      }
    }),
    vscode.commands.registerCommand("xmCloudSync.openSequenceRun", (argument) => {
      if (argument instanceof SequenceRunTreeItem) {
        operationDetails.show(
          `sequence-run:${argument.run.id}`,
          () => sequenceHtml(argument.run.definitionSnapshot, argument.run),
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
  const recoverInterruptedSequenceOperations = async (): Promise<void> => {
    for (const record of transferQueue.list().filter((candidate) => candidate.sequenceRunId)) {
      const run = record.sequenceRunId ? sequenceStore.getRun(record.sequenceRunId) : undefined;
      if (run?.status === "running") {
        continue;
      }
      if (record.kind === "publishing") {
        await publishingManager.abandonQueuedRun(record.publishRunId);
      }
      await transferQueue.archive(record.id);
    }
  };
  void recoverInterruptedSequenceOperations()
    .then(() => publishingManager.enqueuePendingRuns())
    .then(() => transferProcessor.resumeIfRunning());
}

export function deactivate(): void {
  // VS Code disposes subscriptions registered on the extension context.
}

function transferOperationHtml(
  record: Exclude<TransferTreeItem["record"], { readonly kind: "publishing" }>,
): string {
  const title = record.kind === "fieldValue" ? "Field Transfer" : "Subtree Transfer";
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
dt{font-weight:600;margin-top:10px}dd{margin-left:0}
details{margin-top:20px}summary{cursor:pointer;color:var(--vscode-textLink-foreground)}
pre{padding:12px;overflow:auto;background:var(--vscode-textCodeBlock-background)}
</style></head><body>
<h1>${escapeHtml(title)}</h1>
<div class="summary"><strong>${escapeHtml(record.status)}</strong>${record.error ? ` — ${escapeHtml(record.error)}` : ""}</div>
<dl><dt>Source</dt><dd>${escapeHtml(source)}</dd><dt>Destination</dt><dd>${escapeHtml(target)}</dd>
<dt>Queued</dt><dd>${escapeHtml(record.enqueuedAt)}</dd>${record.startedAt ? `<dt>Started</dt><dd>${escapeHtml(record.startedAt)}</dd>` : ""}
${record.completedAt ? `<dt>Completed</dt><dd>${escapeHtml(record.completedAt)}</dd>` : ""}</dl>
<details><summary>Show evidence</summary>
<pre>${escapeHtml(JSON.stringify(record, null, 2))}</pre>
</details>
</body></html>`;
}

function activeRunFromItem(
  argument: unknown,
  store: OperationSequenceStore,
): OperationSequenceRun | undefined {
  return argument instanceof OperationSequenceTreeItem
    ? store.activeRunForDefinition(argument.sequence.id)
    : undefined;
}

async function runSequenceCommand(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error: unknown) {
    await vscode.window.showErrorMessage(`Operation sequence: ${errorMessage(error)}`);
  }
}

function sequenceHtml(
  sequence: SavedOperationSequence,
  run: OperationSequenceRun | undefined,
): string {
  const results = new Map(run?.operationResults.map((result) => [result.index, result]) ?? []);
  const operations = sequence.operations.map((intent, index) => {
    const result = results.get(index);
    const status = result?.status ?? "saved";
    return `<section class="operation">
      <div class="number">${index + 1}</div>
      <div><h2>${escapeHtml(operationIntentLabel(intent))}</h2>
      <p class="status">${escapeHtml(status)}${result?.error ? ` — ${escapeHtml(result.error)}` : ""}</p>
      <details><summary>Show input</summary><pre>${escapeHtml(JSON.stringify(intent, null, 2))}</pre></details></div>
    </section>`;
  }).join("");
  const status = run ? sequenceRunStatus(run) : "Created";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{font-family:var(--vscode-font-family);padding:24px;color:var(--vscode-foreground);max-width:1100px}
.summary{border-left:3px solid var(--vscode-focusBorder);padding:14px;background:var(--vscode-editor-inactiveSelectionBackground);margin:20px 0}
.operation{display:grid;grid-template-columns:34px 1fr;gap:12px;padding:18px 0;border-bottom:1px solid var(--vscode-panel-border)}
.number{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}
h1{margin-bottom:6px}h2{font-size:1.05rem;margin:2px 0 6px}.muted,.status{color:var(--vscode-descriptionForeground)}
summary{cursor:pointer;color:var(--vscode-textLink-foreground)}pre{padding:12px;overflow:auto;background:var(--vscode-textCodeBlock-background)}
</style></head><body><h1>${escapeHtml(sequence.name)}</h1>
${sequence.description ? `<p class="muted">${escapeHtml(sequence.description)}</p>` : ""}
<div class="summary"><strong>${escapeHtml(status)}</strong>${run?.statusDetail ? `<p>${escapeHtml(run.statusDetail)}</p>` : ""}</div>
${operations || "<p>This sequence has no operations.</p>"}
<details><summary>Show sequence definition</summary><pre>${escapeHtml(JSON.stringify(sequence, null, 2))}</pre></details>
</body></html>`;
}

function sequenceNameFromIntent(
  intent: OperationIntent,
  connections: ConnectionStore,
): string {
  const base = operationIntentLabel(intent);
  if (intent.kind === "publishing") {
    return base;
  }
  const sourceId = intent.source.connectionId;
  const destinationId = intent.destination.connectionId;
  const source = connections.get(sourceId)?.name ?? sourceId;
  const destination = connections.get(destinationId)?.name ?? destinationId;
  return `${base} - ${source} > ${destination}`;
}

function sequenceRunStatus(run: OperationSequenceRun): string {
  switch (run.status) {
    case "running": return run.stopRequested
      ? "Stopping after current operation"
      : run.pauseRequested ? "Pausing after current operation" : "Running";
    case "paused": return "Paused";
    case "pausedOnOperation": return "Paused on operation";
    case "pausedByOperations": return "Paused by Operations";
    case "completed": return "Completed";
    case "stopped": return "Stopped";
    case "failed": return "Failed";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
