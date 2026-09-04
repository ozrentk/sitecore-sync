import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import {
  deepStrictEqual,
  match,
  rejects,
  strictEqual,
} from "node:assert/strict";
import * as vscode from "vscode";
import type { ConnectionStore } from "../../src/connections/connectionStore";
import type { OperationDetailsPanel } from "../../src/operations/operationDetailsPanel";
import { PublishingManager } from "../../src/publishing/publishingManager";
import { readPublishRuns } from "../../src/publishing/publishingRunState";
import type {
  PublishBatch,
  PublishRun,
  TraceStage,
} from "../../src/publishing/publishingTypes";
import type { AuthoringContentClient } from "../../src/sitecore/authoringClient";
import type { ExperienceEdgeClient } from "../../src/sitecore/experienceEdgeClient";
import type {
  PublishingClient,
  PublishingStatus,
  StartPublishInput,
} from "../../src/sitecore/publishingClient";
import { TransferQueueStore } from "../../src/transfers/transferQueueStore";
import { type IntegrationTest, MemoryMemento } from "./testSupport";

const runsKey = "sitecoreXmCloudSync.publishRuns.v1";
const profilesKey = "sitecoreXmCloudSync.publishingProfiles.v1";

class TestConnections {
  readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;
  readonly connection = {
    id: "connection-id",
    name: "Production",
    serverUrl: "https://production.example.com",
    clientId: "client-id",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  clientSecret: string | undefined = "client-secret";
  edgeToken: string | undefined = "edge-token";

  get(connectionId: string) {
    return connectionId === this.connection.id ? this.connection : undefined;
  }

  async getClientSecret(connectionId: string): Promise<string | undefined> {
    return connectionId === this.connection.id ? this.clientSecret : undefined;
  }

  async getEdgeToken(connectionId: string): Promise<string | undefined> {
    return connectionId === this.connection.id ? this.edgeToken : undefined;
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}

class TestPublishingClient {
  readonly starts: StartPublishInput[] = [];
  readonly statusCalls: string[] = [];
  readonly statusResults = new Map<string, PublishingStatus[]>();

  async start(
    _connection: unknown,
    _clientSecret: string,
    input: StartPublishInput,
  ): Promise<string> {
    this.starts.push(input);
    return `operation-${this.starts.length}`;
  }

  async status(
    _connection: unknown,
    _clientSecret: string,
    operationId: string,
  ): Promise<PublishingStatus> {
    this.statusCalls.push(operationId);
    return this.statusResults.get(operationId)?.shift() ?? completedStatus();
  }
}

class TestOperationDetails {
  readonly shown: string[] = [];
  readonly rendered: string[] = [];

  show(operationId: string): void {
    this.shown.push(operationId);
  }

  renderIfDisplayed(operationId: string): void {
    this.rendered.push(operationId);
  }
}

class TestEdgeClient {
  readonly itemCalls: string[] = [];

  async item(
    _endpoint: string,
    _token: string,
    itemId: string,
  ) {
    this.itemCalls.push(itemId);
    return {
      id: itemId,
      name: "Home",
      path: "/sitecore/content/Home",
      fields: { Title: "Welcome" },
    };
  }
}

interface ManagerHarness {
  readonly manager: PublishingManager;
  readonly workspaceState: MemoryMemento;
  readonly operations: TransferQueueStore;
  readonly connections: TestConnections;
  readonly publishing: TestPublishingClient;
  readonly edge: TestEdgeClient;
  readonly operationDetails: TestOperationDetails;
  readonly outputLines: string[];
  readonly storageUri: vscode.Uri;
}

export const publishingManagerTests: readonly IntegrationTest[] = [
  {
    name: "PublishingManager executes fresh Standard batches in order",
    async execute(): Promise<void> {
      const harness = createHarness(publishRun());
      try {
        await enqueueRun(harness.operations, "run-id");

        await harness.manager.executeQueued("run-id");

        deepStrictEqual(
          harness.publishing.starts.map((input) => input.itemIds),
          [["dependency-item"], ["root-item"]],
        );
        deepStrictEqual(harness.publishing.starts.map((input) => input.displayName), [
          "XM Cloud Sync: Dependencies",
          "XM Cloud Sync: Root",
        ]);
        deepStrictEqual(harness.publishing.statusCalls, ["operation-1", "operation-2"]);
        const completed = savedRun(harness.workspaceState, "run-id");
        strictEqual(completed.stages.find((stage) => stage.id === "publishing")?.status, "matched");
        deepStrictEqual(
          completed.batches.map((batch) => ({
            operationId: batch.operationId,
            status: batch.checkpointStatus,
          })),
          [
            { operationId: "operation-1", status: "matched" },
            { operationId: "operation-2", status: "matched" },
          ],
        );
        match(completed.conclusion ?? "", /completed the publishing operation/u);
        strictEqual(typeof completed.completedAt, "string");
        strictEqual(typeof completed.journalPath, "string");
        strictEqual(harness.operationDetails.shown.length, 0);
      } finally {
        await disposeHarness(harness);
      }
    },
  },
  {
    name: "PublishingManager resumes submitted batches without publishing them twice",
    async execute(): Promise<void> {
      const batches: readonly PublishBatch[] = [
        {
          itemIds: ["dependency-item"],
          label: "Dependencies",
          operationId: "persisted-operation",
          checkpointStatus: "running",
          checkpointSummary: "Submitted before restart.",
        },
        { itemIds: ["root-item"], label: "Root" },
      ];
      const harness = createHarness(publishRun({ batches }));
      try {
        await harness.manager.executeQueued("run-id");

        deepStrictEqual(
          harness.publishing.starts.map((input) => input.itemIds),
          [["root-item"]],
        );
        deepStrictEqual(
          harness.publishing.statusCalls,
          ["persisted-operation", "operation-1"],
        );
        const completed = savedRun(harness.workspaceState, "run-id");
        deepStrictEqual(
          completed.batches.map((batch) => batch.operationId),
          ["persisted-operation", "operation-1"],
        );
        strictEqual(completed.completedAt !== undefined, true);
      } finally {
        await disposeHarness(harness);
      }
    },
  },
  {
    name: "PublishingManager persists a failed active stage and rethrows the Sitecore failure",
    async execute(): Promise<void> {
      const harness = createHarness(publishRun({
        batches: [{ itemIds: ["root-item"], label: "Root" }],
      }));
      harness.publishing.statusResults.set("operation-1", [{
        state: "Failed",
        isDone: true,
        isFailed: true,
        processed: 0,
        languages: ["en"],
      }]);
      try {
        await rejects(
          harness.manager.executeQueued("run-id"),
          /Publishing operation operation-1 failed \(Failed\)/u,
        );

        const failed = savedRun(harness.workspaceState, "run-id");
        strictEqual(failed.stages.find((stage) => stage.id === "publishing")?.status, "failed");
        match(failed.conclusion ?? "", /Publishing failed:.*operation-1 failed/u);
        strictEqual(typeof failed.completedAt, "string");
        deepStrictEqual(harness.operationDetails.shown, ["run-id"]);
      } finally {
        await disposeHarness(harness);
      }
    },
  },
  {
    name: "PublishingManager hands a Traced publish through diagnostic verification",
    async execute(): Promise<void> {
      const harness = createHarness(publishRun({
        kind: "traced",
        stages: [
          stage("authoring", "matched"),
          stage("publishing", "pending"),
          stage("edgeItem", "pending"),
          stage("edgeLayout", "pending"),
          stage("application", "pending"),
          stage("browserDom", "pending"),
        ],
      }));
      try {
        await harness.manager.executeQueued("run-id");

        deepStrictEqual(harness.edge.itemCalls, ["root-item"]);
        const completed = savedRun(harness.workspaceState, "run-id");
        deepStrictEqual(
          completed.stages.map((stage) => [stage.id, stage.status]),
          [
            ["authoring", "matched"],
            ["publishing", "matched"],
            ["edgeItem", "matched"],
            ["edgeLayout", "skipped"],
            ["application", "skipped"],
            ["browserDom", "skipped"],
          ],
        );
        match(completed.conclusion ?? "", /every configured diagnostic stage matched/iu);
        deepStrictEqual(harness.operationDetails.shown, ["run-id"]);
      } finally {
        await disposeHarness(harness);
      }
    },
  },
  {
    name: "PublishingManager recovers only unqueued incomplete runs",
    async execute(): Promise<void> {
      const pending = publishRun({ id: "pending-run" });
      const alreadyQueued = publishRun({ id: "queued-run" });
      const completed = publishRun({
        id: "completed-run",
        completedAt: "2026-01-01T00:05:00.000Z",
        conclusion: "Already completed.",
      });
      const harness = createHarness([pending, alreadyQueued, completed]);
      try {
        await enqueueRun(harness.operations, "queued-run");

        await harness.manager.enqueuePendingRuns();

        const publishingRecords = harness.operations.list().filter((record) =>
          record.kind === "publishing"
        );
        deepStrictEqual(
          publishingRecords.map((record) => record.publishRunId).sort(),
          ["pending-run", "queued-run"],
        );
      } finally {
        await disposeHarness(harness);
      }
    },
  },
  {
    name: "PublishingManager skips completed runs before resolving credentials",
    async execute(): Promise<void> {
      const harness = createHarness(publishRun({
        completedAt: "2026-01-01T00:05:00.000Z",
        conclusion: "Already completed.",
      }));
      harness.connections.clientSecret = undefined;
      try {
        await harness.manager.executeQueued("run-id");

        strictEqual(harness.publishing.starts.length, 0);
        strictEqual(harness.publishing.statusCalls.length, 0);
        strictEqual(savedRun(harness.workspaceState, "run-id").conclusion, "Already completed.");
      } finally {
        await disposeHarness(harness);
      }
    },
  },
];

function createHarness(initialRuns: PublishRun | readonly PublishRun[]): ManagerHarness {
  const runs = Array.isArray(initialRuns) ? initialRuns : [initialRuns];
  const workspaceState = new MemoryMemento({ [runsKey]: runs });
  const globalState = new MemoryMemento({
    [profilesKey]: [{
      connectionId: "connection-id",
      edgeEndpoint: "https://edge.example.com/api/graphql/v1",
    }],
  });
  const operations = new TransferQueueStore(new MemoryMemento());
  const connections = new TestConnections();
  const publishing = new TestPublishingClient();
  const edge = new TestEdgeClient();
  const operationDetails = new TestOperationDetails();
  const outputLines: string[] = [];
  const storageUri = vscode.Uri.joinPath(
    vscode.Uri.file(tmpdir()),
    `xm-cloud-sync-publishing-manager-${randomUUID()}`,
  );
  const manager = new PublishingManager(
    vscode.Uri.file("C:\\xm-cloud-sync-tests"),
    workspaceState,
    globalState,
    storageUri,
    connections as unknown as ConnectionStore,
    {} as AuthoringContentClient,
    publishing as unknown as PublishingClient,
    edge as unknown as ExperienceEdgeClient,
    {
      appendLine: (line: string): void => {
        outputLines.push(line);
      },
    } as unknown as vscode.OutputChannel,
    operations,
    operationDetails as unknown as OperationDetailsPanel,
  );
  return {
    manager,
    workspaceState,
    operations,
    connections,
    publishing,
    edge,
    operationDetails,
    outputLines,
    storageUri,
  };
}

async function disposeHarness(harness: ManagerHarness): Promise<void> {
  harness.manager.dispose();
  harness.operations.dispose();
  harness.connections.dispose();
  await vscode.workspace.fs.delete(harness.storageUri, {
    recursive: true,
    useTrash: false,
  }).then(undefined, () => undefined);
}

async function enqueueRun(store: TransferQueueStore, publishRunId: string): Promise<void> {
  await store.enqueuePublishing({
    kind: "publishing",
    duplicateKey: `publishing:${publishRunId}`,
    publishRunId,
    publishKind: "standard",
    connectionId: "connection-id",
    connectionName: "Production",
    itemId: "root-item",
    itemPath: "/sitecore/content/Home",
    language: "en",
  });
}

function savedRun(workspaceState: MemoryMemento, runId: string): PublishRun {
  const run = readPublishRuns(workspaceState.get<unknown>(runsKey, []))
    .find((candidate) => candidate.id === runId);
  if (!run) {
    throw new Error(`Expected saved publishing run ${runId}.`);
  }
  return run;
}

function publishRun(overrides: Partial<PublishRun> = {}): PublishRun {
  return {
    id: "run-id",
    kind: "standard",
    connectionId: "connection-id",
    connectionName: "Production",
    targetHost: "production.example.com",
    rootItemId: "root-item",
    rootPath: "/sitecore/content/Home",
    language: "en",
    publishMode: "SMART",
    publishSubItems: false,
    publishRelatedItems: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    snapshots: [{
      itemId: "root-item",
      path: "/sitecore/content/Home",
      displayName: "Home",
      language: "en",
      version: 1,
      fields: { Title: "Welcome" },
      references: [],
    }],
    referenceEdges: [],
    batches: [
      { itemIds: ["dependency-item"], label: "Dependencies" },
      { itemIds: ["root-item"], label: "Root" },
    ],
    stages: [
      stage("authoring", "matched"),
      stage("publishing", "pending"),
      stage("edgeItem", "skipped"),
      stage("edgeLayout", "skipped"),
      stage("application", "skipped"),
      stage("browserDom", "skipped"),
    ],
    ...overrides,
  };
}

function stage(id: TraceStage["id"], status: TraceStage["status"]): TraceStage {
  return { id, label: id, status };
}

function completedStatus(): PublishingStatus {
  return {
    state: "Completed",
    isDone: true,
    isFailed: false,
    processed: 1,
    languages: ["en"],
    targetDatabase: "experienceedge",
  };
}
