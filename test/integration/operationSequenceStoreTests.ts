import {
  deepStrictEqual,
  match,
  rejects,
  strictEqual,
} from "node:assert/strict";
import {
  OperationSequenceStore,
  type OperationSequenceStoreRuntime,
} from "../../src/operations/operationSequenceStore";
import {
  operationDefinitionVersion,
  type OperationIntent,
  type OperationSequenceRun,
  type OperationSequenceRunStatus,
  type SavedOperationSequence,
  type SequenceOperationResult,
} from "../../src/operations/operationTypes";
import { type IntegrationTest, MemoryMemento } from "./testSupport";

const definitionsKey = "sitecoreXmCloudSync.operationSequences.v1";
const runsKey = "sitecoreXmCloudSync.operationSequenceRuns.v1";

class TestRuntime implements OperationSequenceStoreRuntime {
  nowValue = "2026-05-01T10:00:00.000Z";
  private nextId = 1;

  createId(): string {
    const id = `sequence-${this.nextId}`;
    this.nextId += 1;
    return id;
  }

  now(): string {
    return this.nowValue;
  }
}

export const operationSequenceStoreTests: readonly IntegrationTest[] = [
  {
    name: "OperationSequenceStore filters malformed state and recovers interrupted runs",
    async execute(): Promise<void> {
      const saved = definition("saved", "Saved", [
        fieldIntent(),
        fieldIntent(),
        fieldIntent(),
      ]);
      const interrupted = {
        ...sequenceRun(
          "interrupted",
          saved,
          "running",
          "2026-04-01T00:00:00.000Z",
          [
            operationResult(0, "completed"),
            operationResult(1, "running"),
            operationResult(2, "pending"),
          ],
        ),
        currentOperationIndex: 1,
      };
      const paused = sequenceRun(
        "paused",
        saved,
        "paused",
        "2026-04-02T00:00:00.000Z",
        [
          operationResult(0, "pending"),
          operationResult(1, "pending"),
          operationResult(2, "pending"),
        ],
      );
      const runtime = new TestRuntime();
      const store = new OperationSequenceStore(new MemoryMemento({
        [definitionsKey]: [
          saved,
          { ...saved, id: "old-version", definitionVersion: 0 },
          { ...saved, id: "invalid-intent", operations: [{ kind: "unknown" }] },
        ],
        [runsKey]: [
          interrupted,
          paused,
          { ...paused, id: "invalid-status", status: "waiting" },
          {
            ...paused,
            id: "invalid-result",
            operationResults: [{ index: 0, status: "unknown" }],
          },
          { id: "incomplete" },
        ],
      }), runtime);
      try {
        deepStrictEqual(store.listDefinitions().map((entry) => entry.id), ["saved"]);
        deepStrictEqual(store.listActiveRuns().map((entry) => entry.id), [
          "interrupted",
          "paused",
        ]);
        strictEqual(store.getRun("invalid-status"), undefined);
        strictEqual(store.getRun("invalid-result"), undefined);
        strictEqual(store.runningRun(), undefined);

        const recovered = store.getRun("interrupted");
        strictEqual(recovered?.status, "pausedOnOperation");
        strictEqual(recovered?.pauseRequested, undefined);
        strictEqual(recovered?.updatedAt, runtime.nowValue);
        match(recovered?.statusDetail ?? "", /execution was interrupted/u);
        deepStrictEqual(recovered?.operationResults.map((result) => ({
          status: result.status,
          error: result.error,
        })), [
          { status: "completed", error: undefined },
          { status: "failed", error: "Execution was interrupted." },
          { status: "pending", error: undefined },
        ]);
      } finally {
        store.dispose();
      }
    },
  },
  {
    name: "OperationSequenceStore creates trimmed definitions and sorts by name",
    async execute(): Promise<void> {
      const runtime = new TestRuntime();
      const memento = new MemoryMemento();
      const store = new OperationSequenceStore(memento, runtime);
      let changes = 0;
      const subscription = store.onDidChange(() => {
        changes += 1;
      });
      try {
        const beta = await store.create(
          "  beta  ",
          "  Beta description  ",
          [fieldIntent()],
        );
        runtime.nowValue = "2026-05-01T10:01:00.000Z";
        const alpha = await store.create("Alpha", "   ", [publishingIntent()]);

        strictEqual(beta.id, "sequence-1");
        strictEqual(beta.name, "beta");
        strictEqual(beta.description, "Beta description");
        strictEqual(beta.createdAt, "2026-05-01T10:00:00.000Z");
        strictEqual(alpha.id, "sequence-2");
        strictEqual(alpha.description, undefined);
        deepStrictEqual(store.listDefinitions().map((entry) => entry.name), [
          "Alpha",
          "beta",
        ]);
        strictEqual(store.getDefinition(beta.id), beta);
        strictEqual(changes, 2);
        strictEqual(memento.updateCalls, 4);
        strictEqual(Array.isArray(memento.get(definitionsKey)), true);
        strictEqual(Array.isArray(memento.get(runsKey)), true);
      } finally {
        subscription.dispose();
        store.dispose();
      }
    },
  },
  {
    name: "OperationSequenceStore edits details and operation order",
    async execute(): Promise<void> {
      const runtime = new TestRuntime();
      const store = new OperationSequenceStore(new MemoryMemento(), runtime);
      try {
        const saved = await store.create("Sequence", undefined, [fieldIntent()]);
        runtime.nowValue = "2026-05-02T00:00:00.000Z";
        await store.updateDetails(saved.id, "  Renamed  ", "  Updated  ");
        await store.addOperation(saved.id, subtreeIntent());
        await store.addOperation(saved.id, publishingIntent());
        await store.moveOperation(saved.id, 2, -1);

        let updated = store.getDefinition(saved.id);
        strictEqual(updated?.name, "Renamed");
        strictEqual(updated?.description, "Updated");
        strictEqual(updated?.updatedAt, runtime.nowValue);
        deepStrictEqual(updated?.operations.map((intent) => intent.kind), [
          "fieldValue",
          "publishing",
          "subtree",
        ]);

        await store.moveOperation(saved.id, 0, -1);
        await store.moveOperation(saved.id, 10, 1);
        await store.removeOperation(saved.id, 1);
        updated = store.getDefinition(saved.id);
        deepStrictEqual(updated?.operations.map((intent) => intent.kind), [
          "fieldValue",
          "subtree",
        ]);

        await store.delete(saved.id);
        strictEqual(store.getDefinition(saved.id), undefined);
        await rejects(
          store.updateDetails(saved.id, "Missing", undefined),
          /no longer exists/u,
        );
      } finally {
        store.dispose();
      }
    },
  },
  {
    name: "OperationSequenceStore locks definitions for every active run status",
    async execute(): Promise<void> {
      const activeStatuses: readonly OperationSequenceRunStatus[] = [
        "running",
        "paused",
        "pausedOnOperation",
        "pausedByOperations",
      ];
      for (const status of activeStatuses) {
        const saved = definition(`definition-${status}`, status, [fieldIntent()]);
        const store = new OperationSequenceStore(new MemoryMemento({
          [definitionsKey]: [saved],
          [runsKey]: [sequenceRun(`run-${status}`, saved, status)],
        }), new TestRuntime());
        try {
          strictEqual(store.isDefinitionLocked(saved.id), true, status);
          strictEqual(
            store.activeRunForDefinition(saved.id)?.status,
            status === "running" ? "pausedOnOperation" : status,
          );
          await rejects(
            store.updateDetails(saved.id, "Blocked", undefined),
            /keeps this definition immutable/u,
          );
          await rejects(
            store.addOperation(saved.id, publishingIntent()),
            /keeps this definition immutable/u,
          );
          await rejects(
            store.moveOperation(saved.id, 0, 1),
            /keeps this definition immutable/u,
          );
          await rejects(
            store.removeOperation(saved.id, 0),
            /keeps this definition immutable/u,
          );
          await rejects(
            store.delete(saved.id),
            /keeps this definition immutable/u,
          );
        } finally {
          store.dispose();
        }
      }

      const completedDefinition = definition("completed-definition", "Completed");
      const completedStore = new OperationSequenceStore(new MemoryMemento({
        [definitionsKey]: [completedDefinition],
        [runsKey]: [sequenceRun("completed-run", completedDefinition, "completed")],
      }), new TestRuntime());
      try {
        strictEqual(completedStore.isDefinitionLocked(completedDefinition.id), false);
        await completedStore.updateDetails(completedDefinition.id, "Editable", undefined);
        strictEqual(completedStore.getDefinition(completedDefinition.id)?.name, "Editable");
      } finally {
        completedStore.dispose();
      }
    },
  },
  {
    name: "OperationSequenceStore enforces one running sequence while allowing updates",
    async execute(): Promise<void> {
      const firstDefinition = definition("definition-1", "First");
      const secondDefinition = definition("definition-2", "Second");
      const store = new OperationSequenceStore(new MemoryMemento({
        [definitionsKey]: [firstDefinition, secondDefinition],
        [runsKey]: [],
      }), new TestRuntime());
      try {
        const firstRun = sequenceRun("run-1", firstDefinition, "running");
        await store.saveRun(firstRun);
        strictEqual(store.runningRun()?.id, firstRun.id);

        const updatedFirst = {
          ...firstRun,
          currentOperationIndex: 1,
          updatedAt: "2026-06-02T00:00:00.000Z",
        };
        await store.saveRun(updatedFirst);
        strictEqual(store.getRun(firstRun.id)?.currentOperationIndex, 1);

        await rejects(
          store.saveRun(sequenceRun("run-2", secondDefinition, "running")),
          /Another operation sequence is already running/u,
        );
        strictEqual(store.getRun("run-2"), undefined);

        const pausedSecond = sequenceRun("run-2", secondDefinition, "paused");
        await store.saveRun(pausedSecond);
        strictEqual(store.getRun("run-2")?.status, "paused");
      } finally {
        store.dispose();
      }
    },
  },
  {
    name: "OperationSequenceStore sorts active runs and retains ten recent terminal runs",
    async execute(): Promise<void> {
      const saved = definition("definition", "Sequence");
      const store = new OperationSequenceStore(new MemoryMemento({
        [definitionsKey]: [saved],
        [runsKey]: [],
      }), new TestRuntime());
      try {
        await store.saveRun(sequenceRun(
          "active-old",
          saved,
          "paused",
          "2026-06-01T00:00:00.000Z",
        ));
        await store.saveRun(sequenceRun(
          "active-new",
          saved,
          "pausedByOperations",
          "2026-06-02T00:00:00.000Z",
        ));
        for (let index = 0; index < 12; index += 1) {
          await store.saveRun(sequenceRun(
            `terminal-${index}`,
            saved,
            index % 3 === 0 ? "failed" : index % 3 === 1 ? "stopped" : "completed",
            new Date(Date.UTC(2026, 6, index + 1)).toISOString(),
          ));
        }

        deepStrictEqual(store.listActiveRuns().map((run) => run.id), [
          "active-new",
          "active-old",
        ]);
        deepStrictEqual(store.listRecentRuns().map((run) => run.id), [
          "terminal-11",
          "terminal-10",
          "terminal-9",
          "terminal-8",
          "terminal-7",
          "terminal-6",
          "terminal-5",
          "terminal-4",
          "terminal-3",
          "terminal-2",
        ]);
        strictEqual(store.getRun("terminal-1"), undefined);
        strictEqual(store.getRun("terminal-0"), undefined);
      } finally {
        store.dispose();
      }
    },
  },
  {
    name: "OperationSequenceStore detects connection references in every intent kind",
    async execute(): Promise<void> {
      const store = new OperationSequenceStore(new MemoryMemento(), new TestRuntime());
      try {
        await store.create("References", undefined, [
          fieldIntent("field-source", "field-destination"),
          subtreeIntent("tree-source", "tree-destination"),
          publishingIntent("publish-connection"),
        ]);
        for (const connectionId of [
          "field-source",
          "field-destination",
          "tree-source",
          "tree-destination",
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
    name: "OperationSequenceStore serializes concurrent two-key writes",
    async execute(): Promise<void> {
      const memento = new MemoryMemento();
      let releaseDefinitionsWrite: (() => void) | undefined;
      const definitionsWrite = new Promise<void>((resolve) => {
        releaseDefinitionsWrite = resolve;
      });
      memento.updateOverride = async (key, _value, call) => {
        if (key === definitionsKey && call <= 2) {
          await definitionsWrite;
        }
      };
      const store = new OperationSequenceStore(memento, new TestRuntime());
      try {
        const first = store.create("First", undefined, [fieldIntent()]);
        await nextTurn();
        const second = store.create("Second", undefined, [subtreeIntent()]);
        await nextTurn();
        strictEqual(memento.updateCalls, 2);

        releaseDefinitionsWrite?.();
        await Promise.all([first, second]);
        strictEqual(memento.updateCalls, 4);
        deepStrictEqual(store.listDefinitions().map((entry) => entry.name), [
          "First",
          "Second",
        ]);
      } finally {
        store.dispose();
      }
    },
  },
  {
    name: "OperationSequenceStore heals a partial persistence failure on the next write",
    async execute(): Promise<void> {
      const memento = new MemoryMemento();
      let failed = false;
      memento.updateOverride = async (key) => {
        if (key === runsKey && !failed) {
          failed = true;
          throw new Error("run storage unavailable");
        }
      };
      const store = new OperationSequenceStore(memento, new TestRuntime());
      let changes = 0;
      const subscription = store.onDidChange(() => {
        changes += 1;
      });
      try {
        await rejects(
          store.create("Partially saved", undefined, [fieldIntent()]),
          /run storage unavailable/u,
        );
        strictEqual(store.listDefinitions().length, 1);
        strictEqual(changes, 0);

        await store.create("Healed", undefined, [publishingIntent()]);
        strictEqual(store.listDefinitions().length, 2);
        strictEqual(changes, 1);
        strictEqual(
          memento.get<readonly SavedOperationSequence[]>(definitionsKey)?.length,
          2,
        );
        deepStrictEqual(memento.get(runsKey), []);
      } finally {
        subscription.dispose();
        store.dispose();
      }
    },
  },
];

function fieldIntent(
  sourceConnectionId = "source-connection",
  destinationConnectionId = "destination-connection",
): OperationIntent {
  return {
    kind: "fieldValue",
    source: {
      connectionId: sourceConnectionId,
      itemId: "source-item",
      itemPath: "/sitecore/content/source",
      language: "en",
      fieldId: "field-id",
      fieldName: "Title",
      fieldLabel: "Title",
    },
    destination: {
      connectionId: destinationConnectionId,
      itemId: "destination-item",
      itemPath: "/sitecore/content/destination",
      language: "en",
      fieldId: "field-id",
      fieldName: "Title",
      fieldLabel: "Title",
    },
  };
}

function subtreeIntent(
  sourceConnectionId = "source-connection",
  destinationConnectionId = "destination-connection",
): OperationIntent {
  return {
    kind: "subtree",
    source: {
      connectionId: sourceConnectionId,
      rootItemId: "source-root",
      rootPath: "/sitecore/content/source",
    },
    destination: { connectionId: destinationConnectionId },
    mode: "synchronize",
  };
}

function publishingIntent(connectionId = "publish-connection"): OperationIntent {
  return {
    kind: "publishing",
    publishKind: "standard",
    connectionId,
    rootItemId: "publish-root",
    rootPath: "/sitecore/content/publish",
    language: "en",
    publishMode: "SMART",
    publishSubItems: true,
    publishRelatedItems: false,
  };
}

function definition(
  id: string,
  name: string,
  operations: readonly OperationIntent[] = [publishingIntent()],
): SavedOperationSequence {
  return {
    id,
    definitionVersion: operationDefinitionVersion,
    name,
    operations,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function sequenceRun(
  id: string,
  saved: SavedOperationSequence,
  status: OperationSequenceRunStatus,
  updatedAt = "2026-06-01T00:00:00.000Z",
  operationResults: readonly SequenceOperationResult[] = [operationResult(0, "pending")],
): OperationSequenceRun {
  return {
    id,
    sequenceId: saved.id,
    definitionSnapshot: saved,
    status,
    currentOperationIndex: 0,
    operationResults,
    startedAt: "2026-06-01T00:00:00.000Z",
    updatedAt,
    pauseRequested: status === "running" ? true : undefined,
  };
}

function operationResult(
  index: number,
  status: SequenceOperationResult["status"],
): SequenceOperationResult {
  return { index, status };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
