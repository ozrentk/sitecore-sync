import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import {
  isTransferRecord,
  type TransferDraft,
  type TransferProcessorState,
  type TransferRecord,
} from "./transferTypes";

const queueStateKey = "sitecoreXmCloudSync.transferQueue.v1";

interface StoredQueueState {
  readonly processorState: TransferProcessorState;
  readonly nextSequence: number;
  readonly records: readonly TransferRecord[];
}

function initialState(): StoredQueueState {
  return { processorState: "paused", nextSequence: 1, records: [] };
}

export class TransferQueueStore implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private state: StoredQueueState;
  private pendingWrite: Promise<void> = Promise.resolve();

  readonly onDidChange = this.changeEmitter.event;

  constructor(private readonly workspaceState: vscode.Memento) {
    this.state = this.readState();
  }

  get processorState(): TransferProcessorState {
    return this.state.processorState;
  }

  list(): readonly TransferRecord[] {
    return [...this.state.records].sort((left, right) => left.sequence - right.sequence);
  }

  head(): TransferRecord | undefined {
    return this.list()[0];
  }

  get(recordId: string): TransferRecord | undefined {
    return this.state.records.find((record) => record.id === recordId);
  }

  referencesConnection(connectionId: string): boolean {
    return this.state.records.some((record) => record.kind === "fieldValue"
      ? record.source.connectionId === connectionId || record.target.connectionId === connectionId
      : record.sourceConnectionId === connectionId || record.targetConnectionId === connectionId);
  }

  async enqueue(draft: TransferDraft): Promise<{ readonly record: TransferRecord; readonly added: boolean }> {
    let result: { readonly record: TransferRecord; readonly added: boolean } | undefined;
    await this.commit(() => {
      const duplicate = this.state.records.find(
        (record) => record.duplicateKey === draft.duplicateKey,
      );
      if (duplicate) {
        result = { record: duplicate, added: false };
        return;
      }
      const base = {
        id: randomUUID(),
        sequence: this.state.nextSequence,
        status: "queued" as const,
        enqueuedAt: new Date().toISOString(),
      };
      const record: TransferRecord = draft.kind === "fieldValue"
        ? { ...draft, ...base }
        : { ...draft, ...base };
      this.state = {
        ...this.state,
        nextSequence: this.state.nextSequence + 1,
        records: [...this.state.records, record],
      };
      result = { record, added: true };
    });
    if (!result) {
      throw new Error("Unable to add the transfer to the queue.");
    }
    return result;
  }

  async update(
    recordId: string,
    updater: (record: TransferRecord) => TransferRecord,
  ): Promise<TransferRecord | undefined> {
    let updated: TransferRecord | undefined;
    await this.commit(() => {
      this.state = {
        ...this.state,
        records: this.state.records.map((record) => {
          if (record.id !== recordId) {
            return record;
          }
          updated = updater(record);
          return updated;
        }),
      };
    });
    return updated;
  }

  async remove(recordId: string): Promise<boolean> {
    let removed = false;
    await this.commit(() => {
      const records = this.state.records.filter((record) => record.id !== recordId);
      removed = records.length !== this.state.records.length;
      this.state = { ...this.state, records };
    });
    return removed;
  }

  async retry(recordId: string): Promise<void> {
    await this.update(recordId, (record) => ({
      ...record,
      status: record.kind === "subtree" && record.checkpoint?.state === "Pending"
        ? "waitingForSitecore"
        : "queued",
      error: undefined,
      journalPath: undefined,
    }));
  }

  async setProcessorState(processorState: TransferProcessorState): Promise<void> {
    await this.commit(() => {
      this.state = { ...this.state, processorState };
    });
  }

  private readState(): StoredQueueState {
    const stored = this.workspaceState.get<unknown>(queueStateKey);
    if (!stored || typeof stored !== "object") {
      return initialState();
    }
    const candidate = stored as Partial<StoredQueueState>;
    const records = Array.isArray(candidate.records)
      ? candidate.records.filter(isTransferRecord).map(recoverInterruptedRecord)
      : [];
    const maxSequence = records.reduce((maximum, record) => Math.max(maximum, record.sequence), 0);
    return {
      processorState: candidate.processorState === "running" ? "running" : "paused",
      nextSequence: typeof candidate.nextSequence === "number"
        ? Math.max(candidate.nextSequence, maxSequence + 1)
        : maxSequence + 1,
      records,
    };
  }

  private async commit(mutator: () => void): Promise<void> {
    const write = this.pendingWrite.then(async () => {
      mutator();
      await this.workspaceState.update(queueStateKey, this.state);
      this.changeEmitter.fire();
    });
    this.pendingWrite = write.catch(() => undefined);
    await write;
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}

function recoverInterruptedRecord(record: TransferRecord): TransferRecord {
  const recoveredProgress = recoverLegacySitecoreProgress(record);
  const recoveredRecord = recoveredProgress && record.kind === "subtree"
    ? { ...record, progress: recoveredProgress }
    : record;
  if (recoveredRecord.status === "failed" || recoveredRecord.status === "queued") {
    return recoveredRecord;
  }
  if (recoveredRecord.kind === "subtree" && recoveredRecord.checkpoint?.state === "Pending") {
    return { ...recoveredRecord, status: "waitingForSitecore" };
  }
  return { ...recoveredRecord, status: "queued" };
}

function recoverLegacySitecoreProgress(
  record: TransferRecord,
): Extract<TransferRecord, { readonly kind: "subtree" }>["progress"] | undefined {
  if (record.kind !== "subtree" || record.progress?.stage !== "sitecore") {
    return record.kind === "subtree" ? record.progress : undefined;
  }
  const candidate = record.progress as typeof record.progress & {
    readonly current?: number;
    readonly completed?: number;
    readonly startedAt?: string;
  };
  return {
    stage: "sitecore",
    completed: typeof candidate.completed === "number"
      ? candidate.completed
      : Math.max(0, (candidate.current ?? 1) - 1),
    total: candidate.total,
    startedAt: candidate.startedAt ?? record.startedAt ?? record.enqueuedAt,
  };
}
