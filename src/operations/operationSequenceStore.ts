import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import {
  isOperationSequenceRun,
  isSavedOperationSequence,
  operationDefinitionVersion,
  type OperationIntent,
  type OperationSequenceRun,
  type SavedOperationSequence,
} from "./operationTypes";

const definitionsKey = "sitecoreXmCloudSync.operationSequences.v1";
const runsKey = "sitecoreXmCloudSync.operationSequenceRuns.v1";
const terminalStatuses = new Set<OperationSequenceRun["status"]>([
  "completed",
  "stopped",
  "failed",
]);

export interface OperationSequenceStoreRuntime {
  createId(): string;
  now(): string;
}

const defaultRuntime: OperationSequenceStoreRuntime = {
  createId: () => randomUUID(),
  now: () => new Date().toISOString(),
};

export class OperationSequenceStore implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private definitions: readonly SavedOperationSequence[];
  private runs: readonly OperationSequenceRun[];
  private pendingWrite: Promise<void> = Promise.resolve();

  readonly onDidChange = this.changeEmitter.event;

  constructor(
    private readonly workspaceState: vscode.Memento,
    private readonly runtime: OperationSequenceStoreRuntime = defaultRuntime,
  ) {
    const definitions = workspaceState.get<unknown>(definitionsKey, []);
    const runs = workspaceState.get<unknown>(runsKey, []);
    this.definitions = Array.isArray(definitions)
      ? definitions.filter(isSavedOperationSequence)
      : [];
    this.runs = Array.isArray(runs)
      ? runs.filter(isOperationSequenceRun).map((run) =>
          recoverInterruptedRun(run, this.runtime.now())
        )
      : [];
  }

  listDefinitions(): readonly SavedOperationSequence[] {
    return [...this.definitions].sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
    );
  }

  getDefinition(sequenceId: string): SavedOperationSequence | undefined {
    return this.definitions.find((sequence) => sequence.id === sequenceId);
  }

  listActiveRuns(): readonly OperationSequenceRun[] {
    return this.runs
      .filter((run) => !terminalStatuses.has(run.status))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  }

  listRecentRuns(): readonly OperationSequenceRun[] {
    return this.runs
      .filter((run) => terminalStatuses.has(run.status))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, 10);
  }

  getRun(runId: string): OperationSequenceRun | undefined {
    return this.runs.find((run) => run.id === runId);
  }

  runningRun(): OperationSequenceRun | undefined {
    return this.runs.find((run) => run.status === "running");
  }

  activeRunForDefinition(sequenceId: string): OperationSequenceRun | undefined {
    return this.runs.find((run) =>
      run.sequenceId === sequenceId && !terminalStatuses.has(run.status)
    );
  }

  isDefinitionLocked(sequenceId: string): boolean {
    return Boolean(this.activeRunForDefinition(sequenceId));
  }

  referencesConnection(connectionId: string): boolean {
    return this.definitions.some((sequence) => sequence.operations.some((intent) => {
      switch (intent.kind) {
        case "fieldValue":
          return intent.source.connectionId === connectionId ||
            intent.destination.connectionId === connectionId;
        case "subtree":
          return intent.source.connectionId === connectionId ||
            intent.destination.connectionId === connectionId;
        case "publishing":
          return intent.connectionId === connectionId;
      }
    }));
  }

  async create(
    name: string,
    description: string | undefined,
    operations: readonly OperationIntent[],
  ): Promise<SavedOperationSequence> {
    const now = this.runtime.now();
    const sequence: SavedOperationSequence = {
      id: this.runtime.createId(),
      definitionVersion: operationDefinitionVersion,
      name: name.trim(),
      description: description?.trim() || undefined,
      operations: [...operations],
      createdAt: now,
      updatedAt: now,
    };
    await this.commit(() => {
      this.definitions = [...this.definitions, sequence];
    });
    return sequence;
  }

  async updateDetails(
    sequenceId: string,
    name: string,
    description: string | undefined,
  ): Promise<void> {
    this.assertEditable(sequenceId);
    await this.commit(() => {
      this.definitions = this.definitions.map((sequence) => sequence.id === sequenceId
        ? {
            ...sequence,
            name: name.trim(),
            description: description?.trim() || undefined,
            updatedAt: this.runtime.now(),
          }
        : sequence);
    });
  }

  async addOperation(sequenceId: string, intent: OperationIntent): Promise<void> {
    this.assertEditable(sequenceId);
    await this.commit(() => {
      this.definitions = this.definitions.map((sequence) => sequence.id === sequenceId
        ? {
            ...sequence,
            operations: [...sequence.operations, intent],
            updatedAt: this.runtime.now(),
          }
        : sequence);
    });
  }

  async moveOperation(sequenceId: string, index: number, direction: -1 | 1): Promise<void> {
    this.assertEditable(sequenceId);
    await this.commit(() => {
      this.definitions = this.definitions.map((sequence) => {
        if (sequence.id !== sequenceId) {
          return sequence;
        }
        const destination = index + direction;
        if (index < 0 || destination < 0 || destination >= sequence.operations.length) {
          return sequence;
        }
        const operations = [...sequence.operations];
        [operations[index], operations[destination]] = [
          operations[destination]!,
          operations[index]!,
        ];
        return { ...sequence, operations, updatedAt: this.runtime.now() };
      });
    });
  }

  async removeOperation(sequenceId: string, index: number): Promise<void> {
    this.assertEditable(sequenceId);
    await this.commit(() => {
      this.definitions = this.definitions.map((sequence) => sequence.id === sequenceId
        ? {
            ...sequence,
            operations: sequence.operations.filter((_operation, operationIndex) =>
              operationIndex !== index
            ),
            updatedAt: this.runtime.now(),
          }
        : sequence);
    });
  }

  async delete(sequenceId: string): Promise<void> {
    this.assertEditable(sequenceId);
    await this.commit(() => {
      this.definitions = this.definitions.filter((sequence) => sequence.id !== sequenceId);
    });
  }

  async saveRun(run: OperationSequenceRun): Promise<void> {
    await this.commit(() => {
      if (
        run.status === "running" &&
        this.runs.some((candidate) => candidate.status === "running" && candidate.id !== run.id)
      ) {
        throw new Error("Another operation sequence is already running.");
      }
      const existing = this.runs.some((candidate) => candidate.id === run.id);
      const next = existing
        ? this.runs.map((candidate) => candidate.id === run.id ? run : candidate)
        : [...this.runs, run];
      const active = next.filter((candidate) => !terminalStatuses.has(candidate.status));
      const recent = next
        .filter((candidate) => terminalStatuses.has(candidate.status))
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
        .slice(0, 10);
      this.runs = [...active, ...recent];
    });
  }

  private assertEditable(sequenceId: string): void {
    if (!this.getDefinition(sequenceId)) {
      throw new Error("The saved operation sequence no longer exists.");
    }
    if (this.isDefinitionLocked(sequenceId)) {
      throw new Error("A running or paused sequence run keeps this definition immutable.");
    }
  }

  private async commit(mutator: () => void): Promise<void> {
    const write = this.pendingWrite.then(async () => {
      mutator();
      await Promise.all([
        this.workspaceState.update(definitionsKey, this.definitions),
        this.workspaceState.update(runsKey, this.runs),
      ]);
      this.changeEmitter.fire();
    });
    this.pendingWrite = write.catch(() => undefined);
    await write;
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}

function recoverInterruptedRun(
  run: OperationSequenceRun,
  recoveredAt: string,
): OperationSequenceRun {
  if (run.status !== "running") {
    return run;
  }
  return {
    ...run,
    status: "pausedOnOperation",
    statusDetail: "Extension execution was interrupted while an operation was active.",
    pauseRequested: undefined,
    updatedAt: recoveredAt,
    operationResults: run.operationResults.map((result) =>
      result.status === "running"
        ? { ...result, status: "failed", error: "Execution was interrupted." }
        : result
    ),
  };
}
