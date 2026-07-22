import * as vscode from "vscode";
import type { ConnectionStore } from "../connections/connectionStore";
import {
  AuthoringContentClient,
  type AuthoringItemField,
  type ContentTransferProgress,
} from "../sitecore/authoringClient";
import { TransferQueueStore } from "./transferQueueStore";
import {
  fieldStateFingerprint,
  normalizeTransferId,
  type FieldValueTransferRecord,
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
    private readonly journalStorageUri: vscode.Uri,
    private readonly extensionVersion: string,
    private readonly log: vscode.LogOutputChannel,
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
        await this.store.setProcessorState("paused");
        this.log.info("Transfer queue is empty; processing paused.");
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

  private async processRecord(original: TransferRecord): Promise<boolean> {
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
    this.startEmitter.fire(active);
    this.log.info(`Processing transfer ${active.id} (${active.kind}).`);
    try {
      const completed = active.kind === "fieldValue"
        ? await this.executeFieldTransfer(active)
        : await this.executeSubtreeTransfer(active);
      if (!completed) {
        return false;
      }
      const latest = this.store.get(active.id) ?? active;
      await this.writeJournal(latest, "succeeded");
      await this.store.remove(active.id);
      this.completeEmitter.fire(latest);
      this.log.info(`Completed transfer ${active.id}.`);
      return true;
    } catch (error: unknown) {
      const message = errorMessage(error);
      this.log.error(`Transfer ${active.id} failed.`, error);
      const journalPath = await this.writeJournal(
        this.store.get(active.id) ?? active,
        "failed",
        message,
      );
      const failed = await this.store.update(active.id, (record) => ({
        ...record,
        status: "failed",
        error: message,
        journalPath,
      }));
      await this.store.setProcessorState("paused");
      if (failed) {
        this.failureEmitter.fire(failed);
      }
      await vscode.window.showErrorMessage(
        `Transfer failed and the queue was paused: ${message}`,
      );
      return false;
    }
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
        controller.signal,
        async (nextCheckpoint) => {
          await this.persistSubtreeCheckpoint(record.id, nextCheckpoint);
        },
        async (progress) => {
          await this.persistSubtreeProgress(record.id, progress);
        },
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
        },
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
    return true;
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
