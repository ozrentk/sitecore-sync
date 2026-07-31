import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { TransferProcessor } from "../transfers/transferProcessor";
import type { TransferQueueStore } from "../transfers/transferQueueStore";
import type { OperationRecord } from "../transfers/transferTypes";
import { OperationIntentService } from "./operationIntentService";
import { OperationSequenceStore } from "./operationSequenceStore";
import type {
  OperationSequenceRun,
  SavedOperationSequence,
  SequenceOperationResult,
} from "./operationTypes";

export class OperationSequenceRunner implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private starting = false;

  constructor(
    private readonly sequences: OperationSequenceStore,
    private readonly operations: TransferQueueStore,
    processor: TransferProcessor,
    private readonly intents: OperationIntentService,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.disposables.push(
      processor.onDidCompleteRecord((record) => void this.operationCompleted(record)),
      processor.onDidFailRecord((record) => void this.operationFailed(record)),
    );
  }

  get isStarting(): boolean {
    return this.starting;
  }

  async start(sequence: SavedOperationSequence): Promise<OperationSequenceRun> {
    if (this.starting) {
      throw new Error("Another operation sequence is already starting.");
    }
    this.starting = true;
    let run: OperationSequenceRun;
    let processorPaused: boolean;
    try {
      if (this.sequences.activeRunForDefinition(sequence.id)) {
        throw new Error("This operation sequence already has a running or paused run.");
      }
      if (this.sequences.runningRun()) {
        throw new Error("Another operation sequence is already running.");
      }
      if (this.operations.list().length) {
        throw new Error("Finish or pause the current standalone operation before running a sequence.");
      }
      if (!sequence.operations.length) {
        throw new Error("Add at least one operation before running this sequence.");
      }
      await this.validateDefinition(sequence);
      const now = new Date().toISOString();
      processorPaused = this.operations.processorState !== "running";
      run = {
        id: randomUUID(),
        sequenceId: sequence.id,
        definitionSnapshot: structuredClone(sequence),
        status: processorPaused ? "pausedByOperations" : "running",
        currentOperationIndex: 0,
        operationResults: sequence.operations.map((_operation, index) => ({
          index,
          status: "pending",
        })),
        startedAt: now,
        updatedAt: now,
        statusDetail: processorPaused ? "Operation processing is paused." : undefined,
      };
      await this.sequences.saveRun(run);
    } finally {
      this.starting = false;
    }
    if (!processorPaused) {
      await this.launchCurrent(run);
    }
    return this.sequences.getRun(run.id) ?? run;
  }

  async pause(runId: string): Promise<void> {
    const run = this.requireRun(runId);
    if (run.status !== "running") {
      return;
    }
    const active = currentResult(run);
    await this.sequences.saveRun(active?.status === "running"
      ? {
          ...run,
          pauseRequested: true,
          statusDetail: "Pausing after the current operation.",
          updatedAt: new Date().toISOString(),
        }
      : {
          ...run,
          status: "paused",
          statusDetail: undefined,
          updatedAt: new Date().toISOString(),
        });
  }

  async resume(runId: string): Promise<void> {
    const run = this.requireRun(runId);
    if (!new Set(["paused", "pausedByOperations"]).has(run.status)) {
      throw new Error("This sequence is not ready to resume.");
    }
    if (this.sequences.runningRun()) {
      throw new Error("Another operation sequence is already running.");
    }
    if (this.operations.list().length) {
      throw new Error("Finish or pause the current standalone operation before resuming this sequence.");
    }
    if (this.operations.processorState !== "running") {
      await this.sequences.saveRun({
        ...run,
        status: "pausedByOperations",
        statusDetail: "Start Operation Processing before resuming this sequence.",
        updatedAt: new Date().toISOString(),
      });
      return;
    }
    const resumed = {
      ...run,
      status: "running" as const,
      pauseRequested: undefined,
      statusDetail: undefined,
      updatedAt: new Date().toISOString(),
    };
    await this.sequences.saveRun(resumed);
    await this.launchCurrent(resumed);
  }

  async retryOperation(runId: string): Promise<void> {
    const run = this.requireRun(runId);
    if (run.status !== "pausedOnOperation") {
      throw new Error("This sequence is not paused on a failed operation.");
    }
    if (this.sequences.runningRun()) {
      throw new Error("Another operation sequence is already running.");
    }
    if (this.operations.list().length) {
      throw new Error("Finish the current standalone operation before retrying this sequence.");
    }
    const results = replaceResult(run.operationResults, run.currentOperationIndex, {
      index: run.currentOperationIndex,
      status: "pending",
    });
    const retried: OperationSequenceRun = {
      ...run,
      status: this.operations.processorState === "running" ? "running" : "pausedByOperations",
      operationResults: results,
      statusDetail: this.operations.processorState === "running"
        ? undefined
        : "Start Operation Processing before retrying this operation.",
      updatedAt: new Date().toISOString(),
    };
    await this.sequences.saveRun(retried);
    if (retried.status === "running") {
      await this.launchCurrent(retried);
    }
  }

  async skipOperation(runId: string): Promise<void> {
    const run = this.requireRun(runId);
    if (run.status !== "pausedOnOperation") {
      throw new Error("This sequence is not paused on an operation.");
    }
    if (this.sequences.runningRun()) {
      throw new Error("Another operation sequence is already running.");
    }
    const now = new Date().toISOString();
    const results = replaceResult(run.operationResults, run.currentOperationIndex, {
      ...run.operationResults[run.currentOperationIndex]!,
      status: "skipped",
      completedAt: now,
    });
    const nextIndex = run.currentOperationIndex + 1;
    if (nextIndex >= run.definitionSnapshot.operations.length) {
      await this.sequences.saveRun({
        ...run,
        status: "completed",
        currentOperationIndex: nextIndex,
        operationResults: results,
        completedAt: now,
        updatedAt: now,
        statusDetail: "Completed with one or more skipped operations.",
      });
      return;
    }
    const canRun = this.operations.processorState === "running" &&
      !this.operations.list().length;
    const continued: OperationSequenceRun = {
      ...run,
      status: canRun ? "running" : "paused",
      currentOperationIndex: nextIndex,
      operationResults: results,
      statusDetail: canRun ? undefined : "Ready to resume at the next operation.",
      updatedAt: now,
    };
    await this.sequences.saveRun(continued);
    if (canRun) {
      await this.launchCurrent(continued);
    }
  }

  async stop(runId: string): Promise<void> {
    const run = this.requireRun(runId);
    if (isTerminal(run)) {
      return;
    }
    const active = currentResult(run);
    if (run.status === "running" && active?.status === "running") {
      await this.sequences.saveRun({
        ...run,
        stopRequested: true,
        pauseRequested: undefined,
        statusDetail: "Stopping after the current operation.",
        updatedAt: new Date().toISOString(),
      });
      return;
    }
    const now = new Date().toISOString();
    await this.sequences.saveRun({
      ...run,
      status: "stopped",
      completedAt: now,
      updatedAt: now,
      pauseRequested: undefined,
      stopRequested: undefined,
      statusDetail: undefined,
    });
  }

  private async validateDefinition(sequence: SavedOperationSequence): Promise<void> {
    for (let index = 0; index < sequence.operations.length; index += 1) {
      const problem = await this.intents.validate(sequence.operations[index]!);
      if (problem) {
        throw new Error(`Operation ${index + 1} requires attention: ${problem}`);
      }
    }
  }

  private async launchCurrent(run: OperationSequenceRun): Promise<void> {
    const intent = run.definitionSnapshot.operations[run.currentOperationIndex];
    if (!intent) {
      const now = new Date().toISOString();
      await this.sequences.saveRun({
        ...run,
        status: "completed",
        completedAt: now,
        updatedAt: now,
      });
      return;
    }
    try {
      const startedAt = new Date().toISOString();
      const preparing: OperationSequenceRun = {
        ...(this.sequences.getRun(run.id) ?? run),
        status: "running",
        operationResults: replaceResult(run.operationResults, run.currentOperationIndex, {
          index: run.currentOperationIndex,
          status: "running",
          startedAt,
        }),
        updatedAt: startedAt,
        statusDetail: `Preparing operation ${run.currentOperationIndex + 1}.`,
      };
      await this.sequences.saveRun(preparing);
      const record = await this.intents.enqueue(intent, {
        sequenceRunId: run.id,
        sequenceOperationIndex: run.currentOperationIndex,
      });
      if (this.operations.processorState !== "running") {
        await this.intents.discardPrepared(record);
        const latest = this.sequences.getRun(run.id) ?? preparing;
        await this.sequences.saveRun({
          ...latest,
          status: "pausedByOperations",
          operationResults: replaceResult(latest.operationResults, run.currentOperationIndex, {
            index: run.currentOperationIndex,
            status: "pending",
          }),
          updatedAt: new Date().toISOString(),
          statusDetail: "Operation processing was paused before this operation started.",
        });
        return;
      }
      const now = new Date().toISOString();
      const latest = this.sequences.getRun(run.id) ?? preparing;
      await this.sequences.saveRun({
        ...latest,
        status: "running",
        operationResults: replaceResult(latest.operationResults, run.currentOperationIndex, {
          index: run.currentOperationIndex,
          status: "running",
          operationRecordId: record.id,
          startedAt,
        }),
        updatedAt: now,
        statusDetail: undefined,
      });
    } catch (error: unknown) {
      await this.pauseOnPreparationFailure(run, errorMessage(error));
    }
  }

  private async pauseOnPreparationFailure(
    run: OperationSequenceRun,
    error: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    const latest = this.sequences.getRun(run.id) ?? run;
    if (latest.stopRequested) {
      await this.sequences.saveRun({
        ...latest,
        status: "stopped",
        operationResults: replaceResult(latest.operationResults, run.currentOperationIndex, {
          index: run.currentOperationIndex,
          status: "failed",
          completedAt: now,
          error,
        }),
        completedAt: now,
        updatedAt: now,
        stopRequested: undefined,
        statusDetail: error,
      });
      return;
    }
    await this.sequences.saveRun({
      ...latest,
      status: "pausedOnOperation",
      operationResults: replaceResult(latest.operationResults, run.currentOperationIndex, {
        index: run.currentOperationIndex,
        status: "failed",
        completedAt: now,
        error,
      }),
      updatedAt: now,
      statusDetail: error,
    });
    this.log.warn(`Sequence ${run.id} paused while preparing operation: ${error}`);
  }

  private async operationCompleted(record: OperationRecord): Promise<void> {
    if (!record.sequenceRunId || record.sequenceOperationIndex === undefined) {
      return;
    }
    const run = this.sequences.getRun(record.sequenceRunId);
    if (!run || isTerminal(run)) {
      return;
    }
    const now = new Date().toISOString();
    const results = replaceResult(run.operationResults, record.sequenceOperationIndex, {
      ...run.operationResults[record.sequenceOperationIndex]!,
      status: "completed",
      operationRecordId: record.id,
      completedAt: now,
      error: undefined,
    });
    const nextIndex = record.sequenceOperationIndex + 1;
    if (run.stopRequested) {
      await this.sequences.saveRun({
        ...run,
        status: "stopped",
        currentOperationIndex: nextIndex,
        operationResults: results,
        completedAt: now,
        updatedAt: now,
        stopRequested: undefined,
        statusDetail: undefined,
      });
      return;
    }
    if (nextIndex >= run.definitionSnapshot.operations.length) {
      await this.sequences.saveRun({
        ...run,
        status: "completed",
        currentOperationIndex: nextIndex,
        operationResults: results,
        completedAt: now,
        updatedAt: now,
        pauseRequested: undefined,
        statusDetail: undefined,
      });
      return;
    }
    if (run.pauseRequested) {
      await this.sequences.saveRun({
        ...run,
        status: "paused",
        currentOperationIndex: nextIndex,
        operationResults: results,
        pauseRequested: undefined,
        updatedAt: now,
        statusDetail: undefined,
      });
      return;
    }
    if (this.operations.processorState !== "running") {
      await this.sequences.saveRun({
        ...run,
        status: "pausedByOperations",
        currentOperationIndex: nextIndex,
        operationResults: results,
        updatedAt: now,
        statusDetail: "Operation processing is paused.",
      });
      return;
    }
    const continued: OperationSequenceRun = {
      ...run,
      currentOperationIndex: nextIndex,
      operationResults: results,
      updatedAt: now,
      statusDetail: undefined,
    };
    await this.sequences.saveRun(continued);
    await this.launchCurrent(continued);
  }

  private async operationFailed(record: OperationRecord): Promise<void> {
    if (!record.sequenceRunId || record.sequenceOperationIndex === undefined) {
      return;
    }
    const run = this.sequences.getRun(record.sequenceRunId);
    if (!run || isTerminal(run)) {
      return;
    }
    await this.operations.archive(record.id);
    const now = new Date().toISOString();
    if (run.stopRequested) {
      await this.sequences.saveRun({
        ...run,
        status: "stopped",
        operationResults: replaceResult(run.operationResults, record.sequenceOperationIndex, {
          ...run.operationResults[record.sequenceOperationIndex]!,
          status: "failed",
          completedAt: now,
          error: record.error,
        }),
        completedAt: now,
        updatedAt: now,
        stopRequested: undefined,
        statusDetail: record.error,
      });
      return;
    }
    await this.sequences.saveRun({
      ...run,
      status: "pausedOnOperation",
      operationResults: replaceResult(run.operationResults, record.sequenceOperationIndex, {
        ...run.operationResults[record.sequenceOperationIndex]!,
        status: "failed",
        completedAt: now,
        error: record.error,
      }),
      updatedAt: now,
      pauseRequested: undefined,
      statusDetail: record.error ?? "The operation failed.",
    });
  }

  private requireRun(runId: string): OperationSequenceRun {
    const run = this.sequences.getRun(runId);
    if (!run) {
      throw new Error("The operation sequence run no longer exists.");
    }
    return run;
  }

  dispose(): void {
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }
}

function currentResult(run: OperationSequenceRun): SequenceOperationResult | undefined {
  return run.operationResults[run.currentOperationIndex];
}

function replaceResult(
  results: readonly SequenceOperationResult[],
  index: number,
  result: SequenceOperationResult,
): readonly SequenceOperationResult[] {
  return results.map((candidate, candidateIndex) => candidateIndex === index ? result : candidate);
}

function isTerminal(run: OperationSequenceRun): boolean {
  return run.status === "completed" || run.status === "stopped" || run.status === "failed";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
