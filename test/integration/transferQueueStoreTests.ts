import {
  deepStrictEqual,
  match,
  rejects,
  strictEqual,
} from "node:assert/strict";
import * as vscode from "vscode";
import { TransferQueueStore } from "../../src/transfers/transferQueueStore";
import type {
  FieldValueTransferDraft,
  FieldValueTransferRecord,
  PublishingOperationDraft,
  PublishingOperationRecord,
  SubtreeTransferDraft,
  SubtreeTransferRecord,
  TransferRecordStatus,
} from "../../src/transfers/transferTypes";

const queueStateKey = "sitecoreXmCloudSync.transferQueue.v1";

interface IntegrationTest {
  readonly name: string;
  readonly execute: () => Promise<void>;
}

export class MemoryMemento implements vscode.Memento {
  readonly writes: unknown[] = [];
  updateCalls = 0;
  updateOverride:
    | ((key: string, value: unknown, call: number) => Promise<void>)
    | undefined;
  private readonly values = new Map<string, unknown>();

  constructor(queueState?: unknown) {
    if (queueState !== undefined) {
      this.values.set(queueStateKey, queueState);
    }
  }

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.updateCalls += 1;
    await this.updateOverride?.(key, value, this.updateCalls);
    if (value === undefined) {
      this.values.delete(key);
    } else {
      this.values.set(key, value);
    }
    this.writes.push(value);
  }

  keys(): readonly string[] {
    return [...this.values.keys()];
  }

  readQueueState(): unknown {
    return this.values.get(queueStateKey);
  }
}

export const transferQueueStoreTests: readonly IntegrationTest[] = [
  {
    name: "TransferQueueStore initializes safely from missing or malformed state",
    async execute(): Promise<void> {
      const empty = new TransferQueueStore(new MemoryMemento());
      const malformed = new TransferQueueStore(new MemoryMemento({
        processorState: "pausing",
        nextSequence: "invalid",
        records: [{ kind: "fieldValue" }],
        history: "invalid",
      }));
      try {
        strictEqual(empty.processorState, "paused");
        deepStrictEqual(empty.list(), []);
        deepStrictEqual(empty.listRecent(), []);
        strictEqual(empty.head(), undefined);
        strictEqual(malformed.processorState, "paused");
        deepStrictEqual(malformed.list(), []);
        deepStrictEqual(malformed.listRecent(), []);
      } finally {
        empty.dispose();
        malformed.dispose();
      }
    },
  },
  {
    name: "TransferQueueStore recovers interrupted and legacy persisted records",
    async execute(): Promise<void> {
      const interruptedField = fieldRecord("field", 4, "executing");
      const pendingSubtree = {
        ...subtreeRecord("pending", 7, "executing"),
        startedAt: "2026-01-02T03:04:05.000Z",
        checkpoint: pendingCheckpoint(),
        progress: { stage: "sitecore", current: 3, total: 8 },
      };
      const interruptedPublish = publishingRecord("publish", 10, "verifying");
      const failed = fieldRecord("failed", 12, "failed");
      const memento = new MemoryMemento({
        processorState: "running",
        nextSequence: 2,
        records: [
          interruptedField,
          pendingSubtree,
          interruptedPublish,
          failed,
          { kind: "subtree", id: 42 },
        ],
        history: [],
      });
      const store = new TransferQueueStore(memento);
      try {
        strictEqual(store.processorState, "running");
        strictEqual(store.get("field")?.status, "queued");
        strictEqual(store.get("pending")?.status, "waitingForSitecore");
        strictEqual(store.get("publish")?.status, "queued");
        strictEqual(store.get("failed")?.status, "failed");
        strictEqual(store.list().length, 4);

        const recovered = store.get("pending");
        strictEqual(recovered?.kind, "subtree");
        if (recovered?.kind !== "subtree") {
          throw new Error("Expected the recovered subtree record.");
        }
        deepStrictEqual(recovered.progress, {
          stage: "sitecore",
          completed: 2,
          total: 8,
          startedAt: "2026-01-02T03:04:05.000Z",
        });

        const added = await store.enqueue(fieldDraft("after-recovery"));
        strictEqual(added.record.sequence, 13);
      } finally {
        store.dispose();
      }
    },
  },
  {
    name: "TransferQueueStore enqueues, deduplicates, orders, and emits changes",
    async execute(): Promise<void> {
      const memento = new MemoryMemento();
      const store = new TransferQueueStore(memento);
      let changes = 0;
      const subscription = store.onDidChange(() => {
        changes += 1;
      });
      try {
        const second = await store.enqueue(fieldDraft("field-b"));
        const first = await store.enqueue(subtreeDraft("subtree-a"));
        const duplicate = await store.enqueue(fieldDraft("field-b"));
        const publish = await store.enqueuePublishing(publishingDraft("publish-c"));
        const duplicatePublish = await store.enqueuePublishing(publishingDraft("publish-c"));

        strictEqual(second.added, true);
        strictEqual(first.added, true);
        strictEqual(duplicate.added, false);
        strictEqual(duplicate.record.id, second.record.id);
        strictEqual(publish.added, true);
        strictEqual(duplicatePublish.added, false);
        strictEqual(duplicatePublish.record.id, publish.record.id);
        deepStrictEqual(store.list().map((record) => record.sequence), [1, 2, 3]);
        strictEqual(store.head()?.id, second.record.id);
        strictEqual(store.get(first.record.id), first.record);
        match(second.record.id, /^[0-9a-f-]{36}$/u);
        match(second.record.enqueuedAt, /^\d{4}-\d{2}-\d{2}T/u);
        strictEqual(memento.updateCalls, 5);
        strictEqual(changes, 5);
        strictEqual(typeof memento.readQueueState(), "object");
      } finally {
        subscription.dispose();
        store.dispose();
      }
    },
  },
  {
    name: "TransferQueueStore enforces the standalone enqueue guard",
    async execute(): Promise<void> {
      const store = new TransferQueueStore(new MemoryMemento());
      let standaloneAllowed = false;
      store.setStandaloneEnqueueGuard(() => standaloneAllowed);
      try {
        await rejects(
          store.enqueue(fieldDraft("blocked")),
          /Pause the running operation sequence/u,
        );
        const sequenced = await store.enqueue({
          ...fieldDraft("sequenced"),
          sequenceRunId: "run-1",
        });
        strictEqual(sequenced.added, true);

        standaloneAllowed = true;
        const standalone = await store.enqueuePublishing(publishingDraft("allowed"));
        strictEqual(standalone.added, true);
      } finally {
        store.dispose();
      }
    },
  },
  {
    name: "TransferQueueStore serializes concurrent persistence writes",
    async execute(): Promise<void> {
      const memento = new MemoryMemento();
      let releaseFirstWrite: (() => void) | undefined;
      const firstWrite = new Promise<void>((resolve) => {
        releaseFirstWrite = resolve;
      });
      memento.updateOverride = async (_key, _value, call) => {
        if (call === 1) {
          await firstWrite;
        }
      };
      const store = new TransferQueueStore(memento);
      try {
        const first = store.enqueue(fieldDraft("concurrent-1"));
        await nextTurn();
        const second = store.enqueue(fieldDraft("concurrent-2"));
        await nextTurn();
        strictEqual(memento.updateCalls, 1);

        releaseFirstWrite?.();
        const results = await Promise.all([first, second]);
        strictEqual(memento.updateCalls, 2);
        deepStrictEqual(results.map((result) => result.record.sequence), [1, 2]);
        deepStrictEqual(store.list().map((record) => record.duplicateKey), [
          "concurrent-1",
          "concurrent-2",
        ]);
      } finally {
        store.dispose();
      }
    },
  },
  {
    name: "TransferQueueStore remains usable after a persistence failure",
    async execute(): Promise<void> {
      const memento = new MemoryMemento();
      memento.updateOverride = async (_key, _value, call) => {
        if (call === 1) {
          throw new Error("storage unavailable");
        }
      };
      const store = new TransferQueueStore(memento);
      try {
        await rejects(store.enqueue(fieldDraft("failed-write")), /storage unavailable/u);
        strictEqual(store.list().length, 1);

        const second = await store.enqueue(fieldDraft("successful-write"));
        strictEqual(second.added, true);
        strictEqual(memento.updateCalls, 2);
        deepStrictEqual(store.list().map((record) => record.sequence), [1, 2]);
      } finally {
        store.dispose();
      }
    },
  },
  {
    name: "TransferQueueStore updates publishing progress and processor state",
    async execute(): Promise<void> {
      const memento = new MemoryMemento();
      const store = new TransferQueueStore(memento);
      try {
        const publishing = await store.enqueuePublishing(publishingDraft("publish-progress"));
        if (publishing.record.kind !== "publishing") {
          throw new Error("Expected the publishing operation.");
        }
        await store.updatePublishingProgress(
          publishing.record.publishRunId,
          "verifying",
          "3 of 5 targets",
        );
        await store.updatePublishingProgress("missing-run", "executing");
        await store.setProcessorState("running");

        const updated = store.get(publishing.record.id);
        strictEqual(updated?.kind, "publishing");
        strictEqual(updated?.status, "verifying");
        strictEqual(
          updated?.kind === "publishing" ? updated.progressSummary : undefined,
          "3 of 5 targets",
        );
        strictEqual(store.processorState, "running");
        strictEqual(memento.updateCalls, 3);
      } finally {
        store.dispose();
      }
    },
  },
  {
    name: "TransferQueueStore resolves connection references for every operation kind",
    async execute(): Promise<void> {
      const store = new TransferQueueStore(new MemoryMemento());
      try {
        await store.enqueue(fieldDraft("field", "field-source", "field-target"));
        await store.enqueue(subtreeDraft("subtree", "tree-source", "tree-target"));
        await store.enqueuePublishing({
          ...publishingDraft("publish"),
          connectionId: "publish-connection",
        });

        for (const connectionId of [
          "field-source",
          "field-target",
          "tree-source",
          "tree-target",
          "publish-connection",
        ]) {
          strictEqual(store.referencesConnection(connectionId), true, connectionId);
        }
        strictEqual(store.referencesConnection("unreferenced"), false);
      } finally {
        store.dispose();
      }
    },
  },
  {
    name: "TransferQueueStore completes, archives, removes, and limits history",
    async execute(): Promise<void> {
      const history = Array.from({ length: 30 }, (_unused, index) => ({
        ...fieldRecord(`history-${index}`, 100 + index, "completed"),
        completedAt: new Date(Date.UTC(2025, 0, index + 1)).toISOString(),
      }));
      const active = {
        ...fieldRecord("complete-me", 1, "executing"),
        error: "old error",
      };
      const archiveMe = subtreeRecord("archive-me", 2, "failed");
      const removeMe = fieldRecord("remove-me", 3, "queued");
      const store = new TransferQueueStore(new MemoryMemento({
        processorState: "paused",
        nextSequence: 200,
        records: [active, archiveMe, removeMe],
        history,
      }));
      try {
        const completed = await store.complete("complete-me");
        strictEqual(completed?.status, "completed");
        strictEqual(completed?.error, undefined);
        match(completed?.completedAt ?? "", /^\d{4}-\d{2}-\d{2}T/u);
        strictEqual(store.listRecent().length, 30);
        strictEqual(store.get("history-29"), undefined);
        strictEqual(store.get("complete-me")?.status, "completed");
        strictEqual(store.listRecent()[0]?.id, "complete-me");

        strictEqual(await store.remove("remove-me"), true);
        strictEqual(store.get("remove-me"), undefined);

        const archived = await store.archive("archive-me");
        strictEqual(archived?.status, "failed");
        strictEqual(store.list().length, 0);
        strictEqual(store.listRecent().length, 30);

        strictEqual(await store.remove("missing"), false);
        strictEqual(await store.complete("missing"), undefined);
        strictEqual(await store.archive("missing"), undefined);
      } finally {
        store.dispose();
      }
    },
  },
  {
    name: "TransferQueueStore retries records using checkpoint-specific recovery",
    async execute(): Promise<void> {
      const normal = {
        ...fieldRecord("normal", 1, "failed"),
        error: "failed",
        journalPath: "normal.log",
      };
      const pending = {
        ...subtreeRecord("pending-retry", 2, "failed"),
        error: "pending",
        journalPath: "pending.log",
        checkpoint: pendingCheckpoint(),
      };
      const deploymentChanged = {
        ...subtreeRecord("deployment-retry", 3, "failed"),
        startedAt: "2026-02-01T00:00:00.000Z",
        error: "deployment changed",
        journalPath: "deployment.log",
        checkpoint: pendingCheckpoint(),
        progress: { stage: "verifying" } as const,
        deploymentBaselines: {
          source: { environmentId: "source" },
          target: { environmentId: "target" },
        },
        failureKind: "deploymentChanged" as const,
      };
      const store = new TransferQueueStore(new MemoryMemento({
        processorState: "paused",
        nextSequence: 4,
        records: [normal, pending, deploymentChanged],
        history: [],
      }));
      try {
        await store.retry("normal");
        await store.retry("pending-retry");
        await store.retry("deployment-retry");

        const retriedNormal = store.get("normal");
        strictEqual(retriedNormal?.status, "queued");
        strictEqual(retriedNormal?.error, undefined);
        strictEqual(
          retriedNormal?.kind === "fieldValue" ? retriedNormal.journalPath : undefined,
          undefined,
        );

        const retriedPending = store.get("pending-retry");
        strictEqual(retriedPending?.status, "waitingForSitecore");
        strictEqual(retriedPending?.kind === "subtree" ? retriedPending.checkpoint?.state : undefined, "Pending");

        const retriedDeployment = store.get("deployment-retry");
        strictEqual(retriedDeployment?.status, "queued");
        if (retriedDeployment?.kind !== "subtree") {
          throw new Error("Expected the deployment-change subtree record.");
        }
        strictEqual(retriedDeployment.startedAt, undefined);
        strictEqual(retriedDeployment.checkpoint, undefined);
        strictEqual(retriedDeployment.progress, undefined);
        strictEqual(retriedDeployment.deploymentBaselines, undefined);
        strictEqual(retriedDeployment.failureKind, undefined);
      } finally {
        store.dispose();
      }
    },
  },
  {
    name: "TransferQueueStore moves only adjacent queued records",
    async execute(): Promise<void> {
      const first = fieldRecord("first", 10, "queued");
      const second = fieldRecord("second", 20, "queued");
      const failed = fieldRecord("failed", 30, "failed");
      const store = new TransferQueueStore(new MemoryMemento({
        processorState: "paused",
        nextSequence: 31,
        records: [failed, second, first],
        history: [],
      }));
      try {
        await store.move("first", 1);
        deepStrictEqual(store.list().map((record) => record.id), [
          "second",
          "first",
          "failed",
        ]);

        await store.move("first", 1);
        await store.move("second", -1);
        await store.move("missing", 1);
        deepStrictEqual(store.list().map((record) => record.id), [
          "second",
          "first",
          "failed",
        ]);
      } finally {
        store.dispose();
      }
    },
  },
];

export function fieldDraft(
  duplicateKey: string,
  sourceConnectionId = "source-connection",
  targetConnectionId = "target-connection",
): FieldValueTransferDraft {
  return {
    kind: "fieldValue",
    duplicateKey,
    direction: "leftToRight",
    source: fieldEndpoint(sourceConnectionId, "source"),
    target: fieldEndpoint(targetConnectionId, "target"),
  };
}

function fieldEndpoint(connectionId: string, side: string) {
  return {
    connectionId,
    connectionName: `${side} connection`,
    itemId: `${side}-item`,
    itemPath: `/sitecore/content/${side}`,
    language: "en",
    version: 1,
    fieldId: "field-id",
    fieldName: "Title",
    fieldLabel: "Title",
    fingerprint: `${side}-fingerprint`,
  };
}

export function subtreeDraft(
  duplicateKey: string,
  sourceConnectionId = "source-connection",
  targetConnectionId = "target-connection",
): SubtreeTransferDraft {
  return {
    kind: "subtree",
    duplicateKey,
    direction: "leftToRight",
    sourceConnectionId,
    sourceConnectionName: "Source",
    targetConnectionId,
    targetConnectionName: "Target",
    sourceItemId: "source-item",
    sourcePath: "/sitecore/content/source",
    sourceLanguage: "en",
    targetLanguage: "en",
    comparisonRowKey: "row-key",
    targetSide: "right",
    targetRefreshPlan: [],
  };
}

export function publishingDraft(duplicateKey: string): PublishingOperationDraft {
  return {
    kind: "publishing",
    duplicateKey,
    publishRunId: `${duplicateKey}-run`,
    publishKind: "standard",
    connectionId: "publish-connection",
    connectionName: "Publishing",
    itemId: "publish-item",
    itemPath: "/sitecore/content/publish",
    language: "en",
  };
}

function fieldRecord(
  id: string,
  sequence: number,
  status: TransferRecordStatus,
): FieldValueTransferRecord {
  return {
    ...fieldDraft(`${id}-key`),
    id,
    sequence,
    status,
    enqueuedAt: new Date(Date.UTC(2025, 0, sequence)).toISOString(),
  };
}

function subtreeRecord(
  id: string,
  sequence: number,
  status: TransferRecordStatus,
): SubtreeTransferRecord {
  return {
    ...subtreeDraft(`${id}-key`),
    id,
    sequence,
    status,
    enqueuedAt: new Date(Date.UTC(2025, 1, sequence)).toISOString(),
  };
}

function publishingRecord(
  id: string,
  sequence: number,
  status: TransferRecordStatus,
): PublishingOperationRecord {
  return {
    ...publishingDraft(`${id}-key`),
    id,
    sequence,
    status,
    enqueuedAt: new Date(Date.UTC(2025, 2, sequence)).toISOString(),
  };
}

export function pendingCheckpoint(): NonNullable<SubtreeTransferRecord["checkpoint"]> {
  return {
    state: "Pending",
    transferId: "transfer-id",
    sourceItemId: "source-item",
    sourceChildIds: [],
    chunkSets: [],
    itemTransferIds: [],
  };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
