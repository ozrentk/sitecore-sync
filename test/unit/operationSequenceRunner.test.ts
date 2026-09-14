import {
  deepStrictEqual,
  match,
  rejects,
  strictEqual,
} from "node:assert/strict";
import { test } from "node:test";
import type * as vscode from "vscode";
import type { OperationIntentService } from "../../src/operations/operationIntentService";
import { OperationSequenceRunner } from "../../src/operations/operationSequenceRunner";
import type { OperationSequenceStore } from "../../src/operations/operationSequenceStore";
import {
  operationDefinitionVersion,
  type FieldTransferIntent,
  type OperationIntent,
  type OperationSequenceRun,
  type SavedOperationSequence,
  type SequenceOperationContext,
} from "../../src/operations/operationTypes";
import type { TransferProcessor } from "../../src/transfers/transferProcessor";
import type { TransferQueueStore } from "../../src/transfers/transferQueueStore";
import type { OperationRecord } from "../../src/transfers/transferTypes";

test("start validates every operation and launches the first with sequence context", async () => {
  const harness = createHarness();
  const sequence = savedSequence([fieldIntent("First"), fieldIntent("Second")]);

  const run = await harness.runner.start(sequence);

  deepStrictEqual(harness.validated, sequence.operations);
  strictEqual(harness.enqueued.length, 1);
  deepStrictEqual(harness.enqueued[0]?.intent, sequence.operations[0]);
  strictEqual(harness.enqueued[0]?.context.sequenceRunId, run.id);
  strictEqual(harness.enqueued[0]?.context.sequenceOperationIndex, 0);
  strictEqual(run.status, "running");
  strictEqual(run.operationResults[0]?.status, "running");
  strictEqual(run.operationResults[0]?.operationRecordId, "operation-0");
  strictEqual(run.operationResults[1]?.status, "pending");
  strictEqual(run.definitionSnapshot === sequence, false);
  strictEqual(harness.runner.isStarting, false);
});

test("start enforces sequence, queue, and validation preconditions", async (context) => {
  await context.test("active run for this definition", async () => {
    const harness = createHarness();
    harness.runs.set("active", sequenceRun({ id: "active", sequenceId: "sequence-id", status: "paused" }));
    await rejects(harness.runner.start(savedSequence()), /already has a running or paused run/u);
  });

  await context.test("another running sequence", async () => {
    const harness = createHarness();
    harness.runs.set("other", sequenceRun({ id: "other", sequenceId: "other-sequence" }));
    await rejects(harness.runner.start(savedSequence()), /Another operation sequence is already running/u);
  });

  await context.test("standalone queue work", async () => {
    const harness = createHarness();
    harness.queuedRecords.push(operationRecord());
    await rejects(harness.runner.start(savedSequence()), /current standalone operation/u);
  });

  await context.test("empty definition", async () => {
    const harness = createHarness();
    await rejects(harness.runner.start(savedSequence([])), /Add at least one operation/u);
  });

  await context.test("invalid operation", async () => {
    const harness = createHarness();
    harness.validationProblem = "Credentials are unavailable.";
    await rejects(
      harness.runner.start(savedSequence([fieldIntent("First"), fieldIntent("Second")])),
      /Operation 1 requires attention: Credentials are unavailable/u,
    );
    strictEqual(harness.enqueued.length, 0);
    strictEqual(harness.runs.size, 0);
  });
});

test("start exposes its concurrency guard while validation is pending", async () => {
  const harness = createHarness();
  let releaseValidation: (() => void) | undefined;
  harness.validateIntent = () => new Promise((resolve) => {
    releaseValidation = () => resolve(undefined);
  });

  const starting = harness.runner.start(savedSequence());
  await waitFor(() => harness.runner.isStarting);
  await rejects(harness.runner.start(savedSequence()), /already starting/u);
  releaseValidation?.();
  await starting;
  strictEqual(harness.runner.isStarting, false);
});

test("paused processing defers start and resume until processing is running", async () => {
  const harness = createHarness();
  harness.processorState = "paused";

  const started = await harness.runner.start(savedSequence());
  strictEqual(started.status, "pausedByOperations");
  strictEqual(started.statusDetail, "Operation processing is paused.");
  strictEqual(harness.enqueued.length, 0);

  await harness.runner.resume(started.id);
  strictEqual(harness.runs.get(started.id)?.status, "pausedByOperations");
  strictEqual(
    harness.runs.get(started.id)?.statusDetail,
    "Start Operation Processing before resuming this sequence.",
  );

  harness.processorState = "running";
  await harness.runner.resume(started.id);
  strictEqual(harness.runs.get(started.id)?.status, "running");
  strictEqual(harness.runs.get(started.id)?.operationResults[0]?.operationRecordId, "operation-0");
});

test("launch pauses on preparation failure and discards work if processing pauses", async () => {
  const failed = createHarness();
  failed.enqueueError = new Error("Current source item is unavailable.");
  const failedRun = await failed.runner.start(savedSequence());
  strictEqual(failedRun.status, "pausedOnOperation");
  strictEqual(failedRun.operationResults[0]?.status, "failed");
  strictEqual(failedRun.operationResults[0]?.error, "Current source item is unavailable.");
  deepStrictEqual(failed.warnings, [
    `Sequence ${failedRun.id} paused while preparing operation: Current source item is unavailable.`,
  ]);

  const paused = createHarness();
  paused.afterEnqueue = () => {
    paused.processorState = "paused";
  };
  const pausedRun = await paused.runner.start(savedSequence());
  strictEqual(pausedRun.status, "pausedByOperations");
  strictEqual(pausedRun.operationResults[0]?.status, "pending");
  deepStrictEqual(paused.discardedRecords, ["operation-0"]);
});

test("completed records advance the sequence and finish it", async () => {
  const harness = createHarness();
  const started = await harness.runner.start(savedSequence([
    fieldIntent("First"),
    fieldIntent("Second"),
  ]));
  const first = operationRecord({
    id: "operation-0",
    sequenceRunId: started.id,
    sequenceOperationIndex: 0,
  });

  harness.processor.complete(first);
  await waitFor(() => harness.enqueued.length === 2);
  let run = harness.runs.get(started.id)!;
  strictEqual(run.currentOperationIndex, 1);
  strictEqual(run.operationResults[0]?.status, "completed");
  strictEqual(run.operationResults[1]?.operationRecordId, "operation-1");

  harness.processor.complete(operationRecord({
    id: "operation-1",
    sequenceRunId: started.id,
    sequenceOperationIndex: 1,
  }));
  await waitFor(() => harness.runs.get(started.id)?.status === "completed");
  run = harness.runs.get(started.id)!;
  strictEqual(run.currentOperationIndex, 2);
  strictEqual(run.operationResults[1]?.status, "completed");
  match(run.completedAt ?? "", /^\d{4}-/u);
});

test("pause and stop requests take effect after an active operation completes", async () => {
  const paused = createHarness();
  const pausedRun = await paused.runner.start(savedSequence([
    fieldIntent("First"),
    fieldIntent("Second"),
  ]));
  await paused.runner.pause(pausedRun.id);
  strictEqual(paused.runs.get(pausedRun.id)?.pauseRequested, true);
  paused.processor.complete(operationRecord({
    sequenceRunId: pausedRun.id,
    sequenceOperationIndex: 0,
  }));
  await waitFor(() => paused.runs.get(pausedRun.id)?.status === "paused");
  strictEqual(paused.runs.get(pausedRun.id)?.currentOperationIndex, 1);
  strictEqual(paused.enqueued.length, 1);

  const stopped = createHarness();
  const stoppedRun = await stopped.runner.start(savedSequence([
    fieldIntent("First"),
    fieldIntent("Second"),
  ]));
  await stopped.runner.stop(stoppedRun.id);
  strictEqual(stopped.runs.get(stoppedRun.id)?.stopRequested, true);
  stopped.processor.complete(operationRecord({
    sequenceRunId: stoppedRun.id,
    sequenceOperationIndex: 0,
  }));
  await waitFor(() => stopped.runs.get(stoppedRun.id)?.status === "stopped");
  strictEqual(stopped.runs.get(stoppedRun.id)?.currentOperationIndex, 1);
  strictEqual(stopped.enqueued.length, 1);
});

test("failed records are archived and pause or stop the sequence", async () => {
  const paused = createHarness();
  const pausedRun = await paused.runner.start(savedSequence());
  paused.processor.fail(operationRecord({
    id: "failed-operation",
    status: "failed",
    error: "Transfer failed.",
    sequenceRunId: pausedRun.id,
    sequenceOperationIndex: 0,
  }));
  await waitFor(() => paused.runs.get(pausedRun.id)?.status === "pausedOnOperation");
  strictEqual(paused.runs.get(pausedRun.id)?.operationResults[0]?.error, "Transfer failed.");
  deepStrictEqual(paused.archivedRecords, ["failed-operation"]);

  const stopped = createHarness();
  const stoppedRun = await stopped.runner.start(savedSequence());
  await stopped.runner.stop(stoppedRun.id);
  stopped.processor.fail(operationRecord({
    id: "failed-after-stop",
    status: "failed",
    error: "Stopped transfer failed.",
    sequenceRunId: stoppedRun.id,
    sequenceOperationIndex: 0,
  }));
  await waitFor(() => stopped.runs.get(stoppedRun.id)?.status === "stopped");
  strictEqual(stopped.runs.get(stoppedRun.id)?.statusDetail, "Stopped transfer failed.");
  deepStrictEqual(stopped.archivedRecords, ["failed-after-stop"]);
});

test("retry and skip recover a run paused on an operation", async () => {
  const retry = createHarness();
  const pausedRun = sequenceRun({
    status: "pausedOnOperation",
    operationResults: [{ index: 0, status: "failed", error: "Failed." }],
  });
  retry.runs.set(pausedRun.id, pausedRun);
  await retry.runner.retryOperation(pausedRun.id);
  strictEqual(retry.runs.get(pausedRun.id)?.status, "running");
  strictEqual(retry.runs.get(pausedRun.id)?.operationResults[0]?.status, "running");
  strictEqual(retry.enqueued.length, 1);

  const skipFinal = createHarness();
  skipFinal.runs.set(pausedRun.id, pausedRun);
  await skipFinal.runner.skipOperation(pausedRun.id);
  strictEqual(skipFinal.runs.get(pausedRun.id)?.status, "completed");
  strictEqual(skipFinal.runs.get(pausedRun.id)?.currentOperationIndex, 1);
  strictEqual(skipFinal.runs.get(pausedRun.id)?.operationResults[0]?.status, "skipped");

  const skipAndContinue = createHarness();
  const twoOperations = sequenceRun({
    status: "pausedOnOperation",
    definitionSnapshot: savedSequence([fieldIntent("First"), fieldIntent("Second")]),
    operationResults: [
      { index: 0, status: "failed", error: "Failed." },
      { index: 1, status: "pending" },
    ],
  });
  skipAndContinue.runs.set(twoOperations.id, twoOperations);
  await skipAndContinue.runner.skipOperation(twoOperations.id);
  strictEqual(skipAndContinue.runs.get(twoOperations.id)?.currentOperationIndex, 1);
  strictEqual(skipAndContinue.enqueued[0]?.context.sequenceOperationIndex, 1);
});

test("control methods reject invalid states, ignore terminal stops, and dispose subscriptions", async () => {
  const harness = createHarness();
  await rejects(harness.runner.pause("missing"), /run no longer exists/u);

  const running = sequenceRun();
  harness.runs.set(running.id, running);
  await rejects(harness.runner.resume(running.id), /not ready to resume/u);
  await rejects(harness.runner.retryOperation(running.id), /not paused on a failed operation/u);
  await rejects(harness.runner.skipOperation(running.id), /not paused on an operation/u);

  const completed = sequenceRun({ status: "completed", completedAt: "2026-01-01T00:01:00.000Z" });
  harness.runs.set(completed.id, completed);
  const saveCount = harness.savedRuns.length;
  await harness.runner.stop(completed.id);
  strictEqual(harness.savedRuns.length, saveCount);

  harness.runner.dispose();
  strictEqual(harness.processor.listenerCount, 0);
});

interface RunnerHarness {
  readonly runner: OperationSequenceRunner;
  readonly processor: FakeProcessor;
  readonly runs: Map<string, OperationSequenceRun>;
  readonly savedRuns: OperationSequenceRun[];
  readonly queuedRecords: OperationRecord[];
  readonly validated: OperationIntent[];
  readonly enqueued: Array<{ readonly intent: OperationIntent; readonly context: SequenceOperationContext }>;
  readonly discardedRecords: string[];
  readonly archivedRecords: string[];
  readonly warnings: string[];
  processorState: "paused" | "running" | "pausing";
  validationProblem: string | undefined;
  validateIntent: ((intent: OperationIntent) => Promise<string | undefined>) | undefined;
  enqueueError: Error | undefined;
  afterEnqueue: (() => void) | undefined;
}

function createHarness(): RunnerHarness {
  const runs = new Map<string, OperationSequenceRun>();
  const savedRuns: OperationSequenceRun[] = [];
  const queuedRecords: OperationRecord[] = [];
  const validated: OperationIntent[] = [];
  const enqueued: Array<RunnerHarness["enqueued"][number]> = [];
  const discardedRecords: string[] = [];
  const archivedRecords: string[] = [];
  const warnings: string[] = [];
  const processor = new FakeProcessor();
  const harness = {} as RunnerHarness;

  const sequences = {
    activeRunForDefinition: (sequenceId: string) => [...runs.values()].find((run) =>
      run.sequenceId === sequenceId && !isTerminal(run)
    ),
    runningRun: () => [...runs.values()].find((run) => run.status === "running"),
    saveRun: async (run: OperationSequenceRun) => {
      runs.set(run.id, run);
      savedRuns.push(run);
    },
    getRun: (runId: string) => runs.get(runId),
  };
  const operations = {
    get processorState() {
      return harness.processorState;
    },
    list: () => queuedRecords,
    archive: async (recordId: string) => {
      archivedRecords.push(recordId);
      return undefined;
    },
  };
  const intents = {
    validate: async (intent: OperationIntent) => {
      validated.push(intent);
      return harness.validateIntent
        ? harness.validateIntent(intent)
        : harness.validationProblem;
    },
    enqueue: async (intent: OperationIntent, context: SequenceOperationContext) => {
      if (harness.enqueueError) {
        throw harness.enqueueError;
      }
      enqueued.push({ intent, context });
      const record = operationRecord({
        id: `operation-${context.sequenceOperationIndex}`,
        intent,
        sequenceRunId: context.sequenceRunId,
        sequenceOperationIndex: context.sequenceOperationIndex,
      });
      harness.afterEnqueue?.();
      return record;
    },
    discardPrepared: async (record: OperationRecord) => {
      discardedRecords.push(record.id);
    },
  };
  const log = { warn: (message: string) => warnings.push(message) };

  Object.assign(harness, {
    runner: new OperationSequenceRunner(
      sequences as unknown as OperationSequenceStore,
      operations as unknown as TransferQueueStore,
      processor as unknown as TransferProcessor,
      intents as unknown as OperationIntentService,
      log as unknown as vscode.LogOutputChannel,
    ),
    processor,
    runs,
    savedRuns,
    queuedRecords,
    validated,
    enqueued,
    discardedRecords,
    archivedRecords,
    warnings,
    processorState: "running",
    validationProblem: undefined,
    validateIntent: undefined,
    enqueueError: undefined,
    afterEnqueue: undefined,
  });
  return harness;
}

class FakeProcessor {
  private readonly completed = new Set<(record: OperationRecord) => void>();
  private readonly failed = new Set<(record: OperationRecord) => void>();

  readonly onDidCompleteRecord = (listener: (record: OperationRecord) => void): vscode.Disposable => {
    this.completed.add(listener);
    return { dispose: () => this.completed.delete(listener) };
  };

  readonly onDidFailRecord = (listener: (record: OperationRecord) => void): vscode.Disposable => {
    this.failed.add(listener);
    return { dispose: () => this.failed.delete(listener) };
  };

  get listenerCount(): number {
    return this.completed.size + this.failed.size;
  }

  complete(record: OperationRecord): void {
    for (const listener of this.completed) {
      listener(record);
    }
  }

  fail(record: OperationRecord): void {
    for (const listener of this.failed) {
      listener(record);
    }
  }
}

function savedSequence(
  operations: readonly OperationIntent[] = [fieldIntent("Title")],
): SavedOperationSequence {
  return {
    id: "sequence-id",
    definitionVersion: operationDefinitionVersion,
    name: "Content release",
    operations,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function sequenceRun(overrides: Partial<OperationSequenceRun> = {}): OperationSequenceRun {
  return {
    id: "run-id",
    sequenceId: "sequence-id",
    definitionSnapshot: savedSequence(),
    status: "running",
    currentOperationIndex: 0,
    operationResults: [{ index: 0, status: "running", operationRecordId: "operation-0" }],
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function fieldIntent(label: string): FieldTransferIntent {
  return {
    kind: "fieldValue",
    source: {
      connectionId: "source",
      itemId: "source-item",
      itemPath: "/sitecore/content/Source",
      language: "en",
      fieldId: "field-id",
      fieldName: "Title",
      fieldLabel: label,
    },
    destination: {
      connectionId: "destination",
      itemId: "destination-item",
      itemPath: "/sitecore/content/Destination",
      language: "en",
      fieldId: "field-id",
      fieldName: "Title",
      fieldLabel: label,
    },
  };
}

function operationRecord(overrides: Partial<OperationRecord> = {}): OperationRecord {
  return {
    kind: "fieldValue",
    id: "operation-0",
    sequence: 1,
    duplicateKey: "sequence-operation",
    status: "queued",
    enqueuedAt: "2026-01-01T00:00:00.000Z",
    direction: "leftToRight",
    source: {
      connectionId: "source",
      connectionName: "Source",
      itemId: "source-item",
      itemPath: "/sitecore/content/Source",
      language: "en",
      version: 1,
      fieldId: "field-id",
      fieldName: "Title",
      fieldLabel: "Title",
      fingerprint: "source-fingerprint",
    },
    target: {
      connectionId: "destination",
      connectionName: "Destination",
      itemId: "destination-item",
      itemPath: "/sitecore/content/Destination",
      language: "en",
      version: 1,
      fieldId: "field-id",
      fieldName: "Title",
      fieldLabel: "Title",
      fingerprint: "destination-fingerprint",
    },
    ...overrides,
  } as OperationRecord;
}

function isTerminal(run: OperationSequenceRun): boolean {
  return run.status === "completed" || run.status === "stopped" || run.status === "failed";
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for asynchronous sequence transition.");
}
