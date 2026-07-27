import * as vscode from "vscode";
import type { ConnectionStore } from "../connections/connectionStore";
import {
  AuthoringContentClient,
  type AuthoringItemField,
  type ContentTransferProgress,
} from "../sitecore/authoringClient";
import {
  DeploymentClient,
  type DeploymentBaseline,
  type DeploymentCredentials,
} from "../sitecore/deploymentClient";
import { TransferQueueStore } from "./transferQueueStore";
import {
  fieldStateFingerprint,
  normalizeTransferId,
  subtreeTransferMode,
  type FieldValueTransferRecord,
  type OperationRecord,
  type SubtreeTransferRecord,
  type TransferRecord,
} from "./transferTypes";

export class TransferProcessor implements vscode.Disposable {
  private readonly startEmitter = new vscode.EventEmitter<TransferRecord>();
  private readonly completeEmitter = new vscode.EventEmitter<TransferRecord>();
  private readonly failureEmitter = new vscode.EventEmitter<TransferRecord>();
  private readonly disposables: vscode.Disposable[] = [];
  private pumping: Promise<void> | undefined;

  readonly onDidStartRecord = this.startEmitter.event;
  readonly onDidCompleteRecord = this.completeEmitter.event;
  readonly onDidFailRecord = this.failureEmitter.event;

  constructor(
    private readonly store: TransferQueueStore,
    private readonly connectionStore: ConnectionStore,
    private readonly authoringClient: AuthoringContentClient,
    private readonly deploymentClient: DeploymentClient,
    private readonly journalStorageUri: vscode.Uri,
    private readonly extensionVersion: string,
    private readonly log: vscode.LogOutputChannel,
    private readonly executePublishing?: (publishRunId: string) => Promise<void>,
  ) {
    this.disposables.push(store.onDidChange(() => {
      if (store.processorState === "running") {
        this.kick();
      }
      void this.updateContext();
    }));
    void this.updateContext();
  }

  async resumeIfRunning(): Promise<void> {
    if (this.store.processorState === "running") {
      this.kick();
    }
  }

  async start(): Promise<void> {
    await this.store.setProcessorState("running");
    this.kick();
  }

  async pause(): Promise<void> {
    if (!this.pumping) {
      await this.store.setProcessorState("paused");
      return;
    }
    await this.store.setProcessorState("pausing");
  }

  private kick(): void {
    if (this.pumping) {
      return;
    }
    this.pumping = this.pump().finally(() => {
      this.pumping = undefined;
      if (this.store.processorState === "running" && this.store.head()) {
        this.kick();
      }
    });
  }

  private async pump(): Promise<void> {
    while (this.store.processorState === "running") {
      const record = this.store.head();
      if (!record) {
        this.log.info("Operation queue is empty; processor remains ready for work.");
        return;
      }
      if (record.status === "failed") {
        await this.store.setProcessorState("paused");
        return;
      }
      const completed = await this.processRecord(record);
      if (!completed) {
        break;
      }
    }
    if (this.store.processorState === "pausing") {
      await this.store.setProcessorState("paused");
    }
  }

  private async processRecord(original: OperationRecord): Promise<boolean> {
    const startedAt = original.startedAt ?? new Date().toISOString();
    const active = await this.store.update(original.id, (record) => ({
      ...record,
      status: record.kind === "subtree" && record.checkpoint?.state === "Pending"
        ? "waitingForSitecore"
        : "preflighting",
      startedAt,
      error: undefined,
    }));
    if (!active) {
      return true;
    }
    if (active.kind !== "publishing") {
      this.startEmitter.fire(active);
    }
    this.log.info(`Processing operation ${active.id} (${active.kind}).`);
    try {
      const completed = active.kind === "publishing"
        ? await this.executePublishingOperation(active)
        : active.kind === "fieldValue"
          ? await this.executeFieldTransfer(active)
          : await this.executeSubtreeTransfer(active);
      if (!completed) {
        return false;
      }
      const latest = this.store.get(active.id) ?? active;
      if (latest.kind !== "publishing") {
        const journalPath = await this.writeJournal(latest, "succeeded");
        await this.store.update(latest.id, (record) => ({ ...record, journalPath }));
        this.completeEmitter.fire(latest);
      }
      await this.store.complete(active.id);
      this.log.info(`Completed operation ${active.id}.`);
      return true;
    } catch (error: unknown) {
      const message = errorMessage(error);
      this.log.error(`Operation ${active.id} failed.`, error);
      const current = this.store.get(active.id) ?? active;
      const journalPath = current.kind === "publishing"
        ? undefined
        : await this.writeJournal(current, "failed", message);
      const failed = await this.store.update(active.id, (record) => ({
        ...record,
        status: "failed",
        error: message,
        journalPath,
        ...(record.kind === "subtree" && error instanceof DeploymentChangedError
          ? { failureKind: "deploymentChanged" as const }
          : {}),
      }));
      await this.store.setProcessorState("paused");
      if (failed && failed.kind !== "publishing") {
        this.failureEmitter.fire(failed);
      }
      await vscode.window.showErrorMessage(
        `Operation failed and the queue was paused: ${message}`,
      );
      return false;
    }
  }

  private async executePublishingOperation(
    record: Extract<OperationRecord, { readonly kind: "publishing" }>,
  ): Promise<boolean> {
    if (!this.executePublishing) {
      throw new Error("Publishing execution is not available.");
    }
    await this.store.update(record.id, (current) => ({
      ...current,
      status: "executing",
    }));
    await this.executePublishing(record.publishRunId);
    return true;
  }

  private async executeFieldTransfer(record: FieldValueTransferRecord): Promise<boolean> {
    const sourceConnection = this.connectionStore.get(record.source.connectionId);
    const targetConnection = this.connectionStore.get(record.target.connectionId);
    if (!sourceConnection || !targetConnection) {
      throw new Error("A source or target connection no longer exists.");
    }
    const [sourceSecret, targetSecret] = await Promise.all([
      this.connectionStore.getClientSecret(sourceConnection.id),
      this.connectionStore.getClientSecret(targetConnection.id),
    ]);
    if (!sourceSecret || !targetSecret) {
      throw new Error("A source or target connection secret is missing.");
    }
    const controller = new AbortController();
    const [sourceDetails, targetDetails] = await Promise.all([
      this.authoringClient.loadItemDetails(
        sourceConnection,
        sourceSecret,
        record.source.itemId,
        record.source.language,
        controller.signal,
      ),
      this.authoringClient.loadItemDetails(
        targetConnection,
        targetSecret,
        record.target.itemId,
        record.target.language,
        controller.signal,
      ),
    ]);
    const sourceField = findField(sourceDetails.fields, record.source.fieldId);
    const targetField = findField(targetDetails.fields, record.target.fieldId);
    if (!sourceField || !targetField) {
      throw new Error("The queued field is no longer available on both items.");
    }
    if (sourceField.containsFallbackValue) {
      throw new Error("Fallback-derived values cannot be transferred as stored field values.");
    }
    if (fieldStateFingerprint(sourceDetails, sourceField) !== record.source.fingerprint) {
      throw new Error("The source field changed after this transfer was queued.");
    }
    if (sourceField.value === targetField.value) {
      return true;
    }
    if (fieldStateFingerprint(targetDetails, targetField) !== record.target.fingerprint) {
      throw new Error("The target field changed after this transfer was queued.");
    }
    await this.store.update(record.id, (current) => ({ ...current, status: "executing" }));
    await this.authoringClient.updateFieldValue(
      targetConnection,
      targetSecret,
      targetDetails.itemId,
      targetDetails.language,
      targetDetails.version,
      targetField.name,
      sourceField.value,
      controller.signal,
    );
    await this.store.update(record.id, (current) => ({ ...current, status: "verifying" }));
    const verifiedDetails = await this.authoringClient.loadItemDetails(
      targetConnection,
      targetSecret,
      targetDetails.itemId,
      targetDetails.language,
      controller.signal,
    );
    const verifiedField = findField(verifiedDetails.fields, targetField.fieldId);
    if (!verifiedField || verifiedField.value !== sourceField.value) {
      throw new Error("Target verification did not find the transferred field value.");
    }
    return true;
  }

  private async executeSubtreeTransfer(record: SubtreeTransferRecord): Promise<boolean> {
    const sourceConnection = this.connectionStore.get(record.sourceConnectionId);
    const targetConnection = this.connectionStore.get(record.targetConnectionId);
    if (!sourceConnection || !targetConnection) {
      throw new Error("A source or target connection no longer exists.");
    }
    const [sourceSecret, targetSecret] = await Promise.all([
      this.connectionStore.getClientSecret(sourceConnection.id),
      this.connectionStore.getClientSecret(targetConnection.id),
    ]);
    if (!sourceSecret || !targetSecret) {
      throw new Error("A source or target connection secret is missing.");
    }
    const controller = new AbortController();
    const monitoring = await this.deploymentMonitoring(record, controller.signal);
    let lastDeploymentCheck = Date.now();
    const checkDeployments = async (force = false): Promise<void> => {
      if (!monitoring || (!force && Date.now() - lastDeploymentCheck < 15_000)) {
        return;
      }
      lastDeploymentCheck = Date.now();
      await this.assertDeploymentBaselines(monitoring, controller.signal);
    };
    let checkpoint = record.checkpoint;
    if (!checkpoint) {
      await this.store.update(record.id, (current) => ({ ...current, status: "executing" }));
      checkpoint = await this.authoringClient.transferSubtree(
        sourceConnection,
        sourceSecret,
        targetConnection,
        targetSecret,
        record.sourcePath,
        record.sourceItemId,
        record.sourceLanguage,
        record.targetLanguage,
        mergeStrategy(subtreeTransferMode(record)),
        controller.signal,
        async (nextCheckpoint) => {
          await this.persistSubtreeCheckpoint(record.id, nextCheckpoint);
        },
        async (progress) => {
          await this.persistSubtreeProgress(record.id, progress);
          await checkDeployments();
        },
        checkDeployments,
      );
      await this.store.update(record.id, (current) => current.kind === "subtree"
        ? {
            ...current,
            checkpoint,
            status: checkpoint?.state === "Pending" ? "waitingForSitecore" : "verifying",
            progress: checkpoint?.state === "Pending"
              ? current.progress
              : { stage: "verifying" },
          }
        : current);
    }
    while (checkpoint.state === "Pending") {
      if (this.store.processorState !== "running") {
        return false;
      }
      const latest = this.store.get(record.id);
      const sitecorePhaseStartedAt = latest?.kind === "subtree" &&
          latest.progress?.stage === "sitecore"
        ? Date.parse(latest.progress.startedAt)
        : Date.now();
      checkpoint = await this.authoringClient.resumeSubtreeTransfer(
        targetConnection,
        targetSecret,
        record.targetLanguage,
        checkpoint,
        controller.signal,
        Number.isFinite(sitecorePhaseStartedAt) ? sitecorePhaseStartedAt : Date.now(),
        async (nextCheckpoint) => {
          await this.persistSubtreeCheckpoint(record.id, nextCheckpoint);
        },
        async (progress) => {
          await this.persistSubtreeProgress(record.id, progress);
          await checkDeployments();
        },
        checkDeployments,
      );
      await this.store.update(record.id, (current) => current.kind === "subtree"
        ? {
            ...current,
            checkpoint,
            status: checkpoint?.state === "Pending" ? "waitingForSitecore" : "verifying",
            progress: checkpoint?.state === "Pending"
              ? current.progress
              : { stage: "verifying" },
          }
        : current);
    }
    await this.store.update(record.id, (current) => current.kind === "subtree"
      ? { ...current, status: "verifying", progress: { stage: "verifying" } }
      : current);
    await checkDeployments(true);
    return true;
  }

  private async deploymentMonitoring(
    record: SubtreeTransferRecord,
    signal: AbortSignal,
  ): Promise<DeploymentMonitoringContext | undefined> {
    try {
      const [source, target] = await Promise.all([
        this.deploymentEndpoint(
          record.sourceConnectionId,
          record.sourceConnectionName,
          record.deploymentBaselines?.source,
          signal,
        ),
        this.deploymentEndpoint(
          record.targetConnectionId,
          record.targetConnectionName,
          record.deploymentBaselines?.target,
          signal,
        ),
      ]);
      let baselines = record.deploymentBaselines;
      if (!baselines) {
        const [sourceBaseline, targetBaseline] = await Promise.all([
          source.resolvedBaseline ?? this.deploymentClient.getLatestDeployment(
            source.environmentId,
            source.credentials,
            signal,
          ),
          target.resolvedBaseline ?? this.deploymentClient.getLatestDeployment(
            target.environmentId,
            target.credentials,
            signal,
          ),
        ]);
        baselines = { source: sourceBaseline, target: targetBaseline };
        await this.store.update(record.id, (current) => current.kind === "subtree"
          ? { ...current, deploymentBaselines: baselines }
          : current);
        this.log.info(
          `Transfer ${record.id} deployment baselines: source ${baselineLabel(sourceBaseline)}, target ${baselineLabel(targetBaseline)}.`,
        );
      }
      return { source, target, baselines };
    } catch (error: unknown) {
      this.log.warn(
        `Transfer ${record.id}: deployment monitoring is unavailable; continuing without it. ${errorMessage(error)}`,
      );
      return undefined;
    }
  }

  private async deploymentEndpoint(
    connectionId: string,
    connectionName: string,
    existingBaseline: DeploymentBaseline | undefined,
    signal: AbortSignal,
  ): Promise<DeploymentMonitoringEndpoint> {
    const connection = this.connectionStore.get(connectionId);
    if (!connection) {
      throw new Error(`The ${connectionName} connection no longer exists.`);
    }
    if (connection.deploymentClientId && connection.deploymentEnvironmentId) {
      const deploymentSecret = await this.connectionStore.getDeploymentClientSecret(connectionId);
      if (deploymentSecret) {
        return {
          connectionName,
          environmentId: connection.deploymentEnvironmentId,
          credentials: {
            clientId: connection.deploymentClientId,
            clientSecret: deploymentSecret,
          },
        };
      }
    }
    const connectionSecret = await this.connectionStore.getClientSecret(connectionId);
    if (!connectionSecret) {
      throw new Error(`The connection secret for ${connectionName} is missing.`);
    }
    const credentials = { clientId: connection.clientId, clientSecret: connectionSecret };
    if (existingBaseline) {
      return {
        connectionName,
        environmentId: existingBaseline.environmentId,
        credentials,
      };
    }
    const resolvedBaseline = await this.deploymentClient.resolveEnvironment(
      connection,
      credentials,
      signal,
    );
    return {
      connectionName,
      environmentId: resolvedBaseline.environmentId,
      credentials,
      resolvedBaseline,
    };
  }

  private async assertDeploymentBaselines(
    context: DeploymentMonitoringContext,
    signal: AbortSignal,
  ): Promise<void> {
    await Promise.all([
      this.checkDeploymentEndpoint(
        context.source,
        "source",
        context.baselines.source,
        signal,
      ),
      this.checkDeploymentEndpoint(
        context.target,
        "destination",
        context.baselines.target,
        signal,
      ),
    ]);
  }

  private async checkDeploymentEndpoint(
    endpoint: DeploymentMonitoringEndpoint,
    role: "source" | "destination",
    baseline: DeploymentBaseline,
    signal: AbortSignal,
  ): Promise<void> {
    let latest: DeploymentBaseline;
    try {
      latest = await this.deploymentClient.getLatestDeployment(
        endpoint.environmentId,
        endpoint.credentials,
        signal,
      );
    } catch (error: unknown) {
      this.log.warn(
        `Could not check the ${role} deployment for ${endpoint.connectionName}; the transfer continues. ${errorMessage(error)}`,
      );
      return;
    }
    assertUnchangedDeployment(endpoint.connectionName, role, baseline, latest);
  }

  private async persistSubtreeProgress(
    recordId: string,
    progress: ContentTransferProgress,
  ): Promise<void> {
    await this.store.update(recordId, (current) => {
      if (current.kind !== "subtree") {
        return current;
      }
      const persistedProgress = progress.stage === "sitecore"
        ? {
            ...progress,
            startedAt: current.progress?.stage === "sitecore"
              ? current.progress.startedAt
              : new Date().toISOString(),
          }
        : progress;
      return {
        ...current,
        progress: persistedProgress,
        status: progress.stage === "sitecore"
          ? "waitingForSitecore"
          : progress.stage === "verifying"
            ? "verifying"
            : "executing",
      };
    });
  }

  private async persistSubtreeCheckpoint(
    recordId: string,
    checkpoint: SubtreeTransferRecord["checkpoint"],
  ): Promise<void> {
    if (!checkpoint) {
      return;
    }
    await this.store.update(recordId, (current) => current.kind === "subtree"
      ? { ...current, checkpoint, status: "waitingForSitecore" }
      : current);
  }

  private async writeJournal(
    record: TransferRecord,
    outcome: "succeeded" | "failed",
    error?: string,
  ): Promise<string> {
    const directory = vscode.Uri.joinPath(this.journalStorageUri, "journals");
    await vscode.workspace.fs.createDirectory(directory);
    const uri = vscode.Uri.joinPath(
      directory,
      `journal-${journalTimestamp(new Date())}-${record.id.slice(0, 8)}.log`,
    );
    const content = JSON.stringify({
      journalFormatVersion: 2,
      extensionVersion: this.extensionVersion,
      mode: "queued-transfer",
      outcome,
      endedAt: new Date().toISOString(),
      error,
      record,
    }, null, 2);
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(`${content}\n`));
    return uri.fsPath;
  }

  private async updateContext(): Promise<void> {
    await Promise.all([
      vscode.commands.executeCommand(
        "setContext",
        "xmCloudSync.transferProcessorState",
        this.store.processorState,
      ),
      vscode.commands.executeCommand(
        "setContext",
        "xmCloudSync.hasQueuedTransfers",
        this.store.list().length > 0,
      ),
    ]);
  }

  dispose(): void {
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
    this.startEmitter.dispose();
    this.completeEmitter.dispose();
    this.failureEmitter.dispose();
  }
}

function mergeStrategy(
  mode: ReturnType<typeof subtreeTransferMode>,
): "KeepExistingItem" | "OverrideExistingItem" | "OverrideExistingTree" {
  switch (mode) {
    case "addMissing": return "KeepExistingItem";
    case "synchronize": return "OverrideExistingItem";
    case "exactMirror": return "OverrideExistingTree";
  }
}

function findField(
  fields: readonly AuthoringItemField[],
  fieldId: string,
): AuthoringItemField | undefined {
  const normalized = normalizeTransferId(fieldId);
  return fields.find((field) => normalizeTransferId(field.fieldId) === normalized);
}

function journalTimestamp(value: Date): string {
  const part = (number: number): string => String(number).padStart(2, "0");
  return `${value.getFullYear()}${part(value.getMonth() + 1)}${part(value.getDate())}-${part(value.getHours())}${part(value.getMinutes())}${part(value.getSeconds())}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface DeploymentMonitoringEndpoint {
  readonly connectionName: string;
  readonly environmentId: string;
  readonly credentials: DeploymentCredentials;
  readonly resolvedBaseline?: DeploymentBaseline;
}

interface DeploymentMonitoringContext {
  readonly source: DeploymentMonitoringEndpoint;
  readonly target: DeploymentMonitoringEndpoint;
  readonly baselines: {
    readonly source: DeploymentBaseline;
    readonly target: DeploymentBaseline;
  };
}

class DeploymentChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeploymentChangedError";
  }
}

function assertUnchangedDeployment(
  connectionName: string,
  role: "source" | "destination",
  baseline: DeploymentBaseline,
  latest: DeploymentBaseline,
): void {
  if (baseline.deploymentId === latest.deploymentId) {
    return;
  }
  throw new DeploymentChangedError(
    `The latest ${role} deployment for ${connectionName} changed while the transfer was running ` +
    `(${baselineLabel(baseline)} → ${baselineLabel(latest)}). The remote operation may be incomplete; retry starts a new transfer.`,
  );
}

function baselineLabel(baseline: DeploymentBaseline): string {
  const timestamp = baseline.createdAt ?? baseline.startedAt ?? baseline.deploymentStartedAt;
  if (!baseline.deploymentId) {
    return "no deployment";
  }
  return timestamp
    ? `${baseline.deploymentId} at ${timestamp}`
    : baseline.deploymentId;
}
