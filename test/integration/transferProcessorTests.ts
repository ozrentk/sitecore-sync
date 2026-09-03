import {
  deepStrictEqual,
  match,
  strictEqual,
} from "node:assert/strict";
import * as vscode from "vscode";
import type { XmCloudConnection } from "../../src/connections/connection";
import type {
  AuthoringItemDetails,
  ContentTransferProgress,
  ContentTransferResult,
} from "../../src/sitecore/authoringClient";
import type { DeploymentBaseline } from "../../src/sitecore/deploymentClient";
import {
  TransferProcessor,
  type TransferProcessorAuthoringClient,
  type TransferProcessorConnectionStore,
  type TransferProcessorDeploymentClient,
  type TransferProcessorLogger,
  type TransferProcessorRuntime,
} from "../../src/transfers/transferProcessor";
import { TransferQueueStore } from "../../src/transfers/transferQueueStore";
import {
  fieldStateFingerprint,
  type OperationRecord,
} from "../../src/transfers/transferTypes";
import {
  fieldDraft,
  MemoryMemento,
  pendingCheckpoint,
  publishingDraft,
  subtreeDraft,
} from "./transferQueueStoreTests";

interface IntegrationTest {
  readonly name: string;
  readonly execute: () => Promise<void>;
}

class TestConnectionStore implements TransferProcessorConnectionStore {
  readonly connections = new Map<string, XmCloudConnection>();
  readonly secrets = new Map<string, string>();
  readonly deploymentSecrets = new Map<string, string>();

  constructor() {
    this.add("source-connection", "Source");
    this.add("target-connection", "Target");
    this.add("publish-connection", "Publishing");
  }

  add(id: string, name: string, deploymentEnvironmentId?: string): void {
    this.connections.set(id, {
      id,
      name,
      serverUrl: `https://${id}.example.com`,
      clientId: `${id}-client`,
      deploymentClientId: deploymentEnvironmentId ? `${id}-deployment-client` : undefined,
      deploymentEnvironmentId,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    this.secrets.set(id, `${id}-secret`);
    if (deploymentEnvironmentId) {
      this.deploymentSecrets.set(id, `${id}-deployment-secret`);
    }
  }

  get(id: string): XmCloudConnection | undefined {
    return this.connections.get(id);
  }

  async getClientSecret(id: string): Promise<string | undefined> {
    return this.secrets.get(id);
  }

  async getDeploymentClientSecret(id: string): Promise<string | undefined> {
    return this.deploymentSecrets.get(id);
  }
}

class TestAuthoringClient implements TransferProcessorAuthoringClient {
  readonly loadedItemIds: string[] = [];
  readonly fieldUpdates: {
    readonly itemId: string;
    readonly fieldName: string;
    readonly value: string;
  }[] = [];
  readonly subtreeMergeStrategies: string[] = [];
  itemDetails: AuthoringItemDetails[] = [];
  transferResult: ContentTransferResult = finishedCheckpoint();
  resumeResults: ContentTransferResult[] = [finishedCheckpoint()];
  transferProgress: readonly ContentTransferProgress[] = [];
  transferCheckpoint: ContentTransferResult | undefined;
  transferGate: Promise<void> | undefined;
  transferStarted: (() => void) | undefined;

  loadItemDetails: TransferProcessorAuthoringClient["loadItemDetails"] = async (
    _connection,
    _clientSecret,
    itemId,
  ) => {
    this.loadedItemIds.push(itemId);
    const details = this.itemDetails.shift();
    if (!details) {
      throw new Error(`No item-details fixture for ${itemId}.`);
    }
    return details;
  };

  updateFieldValue: TransferProcessorAuthoringClient["updateFieldValue"] = async (
    _connection,
    _clientSecret,
    itemId,
    _language,
    _version,
    fieldName,
    value,
  ) => {
    this.fieldUpdates.push({ itemId, fieldName, value });
  };

  transferSubtree: TransferProcessorAuthoringClient["transferSubtree"] = async (
    _source,
    _sourceSecret,
    _destination,
    _destinationSecret,
    _itemPath,
    _expectedSourceItemId,
    _sourceLanguage,
    _destinationLanguage,
    mergeStrategy,
    _signal,
    onCheckpoint,
    onProgress,
    onPoll,
  ) => {
    this.subtreeMergeStrategies.push(mergeStrategy);
    this.transferStarted?.();
    await this.transferGate;
    for (const progress of this.transferProgress) {
      await onProgress?.(progress);
    }
    if (this.transferCheckpoint) {
      await onCheckpoint?.(this.transferCheckpoint);
    }
    await onPoll?.();
    return this.transferResult;
  };

  resumeSubtreeTransfer: TransferProcessorAuthoringClient["resumeSubtreeTransfer"] = async (
    _destination,
    _destinationSecret,
    _destinationLanguage,
    _checkpoint,
    _signal,
    _sitecorePhaseStartedAt,
    onCheckpoint,
    onProgress,
    onPoll,
  ) => {
    const result = this.resumeResults.shift();
    if (!result) {
      throw new Error("No subtree-resume fixture remains.");
    }
    await onProgress?.({ stage: "sitecore", completed: 1, total: 1 });
    await onCheckpoint?.(result);
    await onPoll?.();
    return result;
  };
}

class TestDeploymentClient implements TransferProcessorDeploymentClient {
  readonly latestCalls: string[] = [];
  resolveError: Error | undefined = new Error("deployment monitoring unavailable");
  readonly baselinesByEnvironment = new Map<string, DeploymentBaseline[]>();

  resolveEnvironment: TransferProcessorDeploymentClient["resolveEnvironment"] = async (
    connection,
  ) => {
    if (this.resolveError) {
      throw this.resolveError;
    }
    return this.nextBaseline(connection.id);
  };

  getLatestDeployment: TransferProcessorDeploymentClient["getLatestDeployment"] = async (
    environmentId,
  ) => this.nextBaseline(environmentId);

  private nextBaseline(environmentId: string): DeploymentBaseline {
    this.latestCalls.push(environmentId);
    const configured = this.baselinesByEnvironment.get(environmentId);
    const next = configured?.shift();
    return next ?? { environmentId, deploymentId: `${environmentId}-deployment` };
  }
}

class TestRuntime implements TransferProcessorRuntime {
  readonly contexts = new Map<string, unknown>();
  readonly messages: string[] = [];
  readonly directories: vscode.Uri[] = [];
  readonly files: { readonly uri: vscode.Uri; readonly content: Uint8Array }[] = [];
  nowValue = new Date("2026-04-05T06:07:08.000Z");

  now(): Date {
    return new Date(this.nowValue);
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    this.directories.push(uri);
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    this.files.push({ uri, content });
  }

  async showErrorMessage(message: string): Promise<void> {
    this.messages.push(message);
  }

  async setContext(key: string, value: unknown): Promise<void> {
    this.contexts.set(key, value);
  }
}

class TestLogger implements TransferProcessorLogger {
  readonly infos: string[] = [];
  readonly warnings: string[] = [];
  readonly errors: { readonly message: string; readonly error: unknown }[] = [];

  info(message: string): void {
    this.infos.push(message);
  }

  warn(message: string): void {
    this.warnings.push(message);
  }

  error(message: string, error?: unknown): void {
    this.errors.push({ message, error });
  }
}

interface ProcessorHarness {
  readonly store: TransferQueueStore;
  readonly processor: TransferProcessor;
  readonly connections: TestConnectionStore;
  readonly authoring: TestAuthoringClient;
  readonly deployments: TestDeploymentClient;
  readonly runtime: TestRuntime;
  readonly logger: TestLogger;
}

export const transferProcessorTests: readonly IntegrationTest[] = [
  {
    name: "TransferProcessor remains ready on an empty queue and pauses while idle",
    async execute(): Promise<void> {
      const harness = createHarness();
      try {
        await harness.processor.start();
        await waitFor(() => harness.logger.infos.some((entry) => entry.includes("queue is empty")));
        strictEqual(harness.store.processorState, "running");
        strictEqual(
          harness.runtime.contexts.get("xmCloudSync.hasQueuedTransfers"),
          false,
        );

        await harness.processor.pause();
        strictEqual(harness.store.processorState, "paused");
      } finally {
        disposeHarness(harness);
      }
    },
  },
  {
    name: "TransferProcessor completes publishing and emits lifecycle events",
    async execute(): Promise<void> {
      const publishedRuns: string[] = [];
      const harness = createHarness(async (publishRunId) => {
        publishedRuns.push(publishRunId);
      });
      try {
        const queued = await harness.store.enqueuePublishing(publishingDraft("publish-success"));
        const started = nextEvent(harness.processor.onDidStartRecord);
        const completed = nextEvent(harness.processor.onDidCompleteRecord);

        await harness.processor.start();
        const [startedRecord, completedRecord] = await Promise.all([started, completed]);

        strictEqual(startedRecord.id, queued.record.id);
        strictEqual(startedRecord.status, "preflighting");
        strictEqual(completedRecord.id, queued.record.id);
        strictEqual(completedRecord.status, "completed");
        deepStrictEqual(publishedRuns, [publishingRunId(queued.record)]);
        strictEqual(harness.store.list().length, 0);
        strictEqual(harness.store.listRecent()[0]?.id, queued.record.id);
        strictEqual(harness.runtime.files.length, 0);
      } finally {
        disposeHarness(harness);
      }
    },
  },
  {
    name: "TransferProcessor resumes a persisted running queue after restart",
    async execute(): Promise<void> {
      const store = new TransferQueueStore(new MemoryMemento());
      const queued = await store.enqueuePublishing(publishingDraft("publish-restart"));
      await store.setProcessorState("running");
      const publishedRuns: string[] = [];
      const harness = createHarness(async (publishRunId) => {
        publishedRuns.push(publishRunId);
      }, store);
      try {
        const completed = nextEvent(harness.processor.onDidCompleteRecord);
        await harness.processor.resumeIfRunning();
        await completed;

        deepStrictEqual(publishedRuns, [publishingRunId(queued.record)]);
        strictEqual(harness.store.get(queued.record.id)?.status, "completed");
        strictEqual(harness.store.processorState, "running");
      } finally {
        disposeHarness(harness);
      }
    },
  },
  {
    name: "TransferProcessor processes one record at a time and pauses at a boundary",
    async execute(): Promise<void> {
      let releaseFirst: (() => void) | undefined;
      let markFirstStarted: (() => void) | undefined;
      const firstStarted = new Promise<void>((resolve) => {
        markFirstStarted = resolve;
      });
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const calls: string[] = [];
      const harness = createHarness(async (publishRunId) => {
        calls.push(publishRunId);
        if (calls.length === 1) {
          markFirstStarted?.();
          await firstGate;
        }
      });
      try {
        const first = await harness.store.enqueuePublishing(publishingDraft("publish-first"));
        const second = await harness.store.enqueuePublishing(publishingDraft("publish-second"));
        await harness.processor.start();
        await firstStarted;
        deepStrictEqual(calls, [publishingRunId(first.record)]);

        await harness.processor.pause();
        strictEqual(harness.store.processorState, "pausing");
        releaseFirst?.();
        await waitFor(() => harness.store.processorState === "paused");
        strictEqual(harness.store.get(first.record.id)?.status, "completed");
        strictEqual(harness.store.get(second.record.id)?.status, "queued");
        deepStrictEqual(calls, [publishingRunId(first.record)]);

        const secondCompleted = nextEvent(harness.processor.onDidCompleteRecord);
        await harness.processor.start();
        await secondCompleted;
        deepStrictEqual(calls, [
          publishingRunId(first.record),
          publishingRunId(second.record),
        ]);
      } finally {
        disposeHarness(harness);
      }
    },
  },
  {
    name: "TransferProcessor fails unavailable publishing and leaves the failed head paused",
    async execute(): Promise<void> {
      const harness = createHarness();
      try {
        const queued = await harness.store.enqueuePublishing(publishingDraft("publish-failure"));
        const failed = nextEvent(harness.processor.onDidFailRecord);
        await harness.processor.start();
        const failedRecord = await failed;

        strictEqual(failedRecord.id, queued.record.id);
        strictEqual(failedRecord.status, "failed");
        strictEqual(harness.store.processorState, "paused");
        strictEqual(harness.runtime.messages.length, 1);
        match(harness.runtime.messages[0] ?? "", /Publishing execution is not available/u);

        await harness.processor.start();
        await waitFor(() => harness.store.processorState === "paused");
        strictEqual(harness.store.head()?.id, queued.record.id);
      } finally {
        disposeHarness(harness);
      }
    },
  },
  {
    name: "TransferProcessor skips an already-equal field mutation and writes a journal",
    async execute(): Promise<void> {
      const harness = createHarness();
      const source = itemDetails("source-item", "same value");
      const target = itemDetails("target-item", "same value");
      harness.authoring.itemDetails = [source, target];
      try {
        const queued = await enqueueField(harness.store, source, target, "field-equal");
        const completed = nextEvent(harness.processor.onDidCompleteRecord);
        await harness.processor.start();
        await completed;

        deepStrictEqual(harness.authoring.fieldUpdates, []);
        deepStrictEqual(harness.authoring.loadedItemIds, ["source-item", "target-item"]);
        strictEqual(harness.runtime.files.length, 1);
        const journal = decodeJournal(harness.runtime.files[0]?.content);
        strictEqual(journal.outcome, "succeeded");
        strictEqual(journal.record.id, queued.record.id);
        strictEqual(journal.extensionVersion, "0.10.0-test");
      } finally {
        disposeHarness(harness);
      }
    },
  },
  {
    name: "TransferProcessor mutates and verifies a changed field value",
    async execute(): Promise<void> {
      const harness = createHarness();
      const source = itemDetails("source-item", "new value");
      const target = itemDetails("target-item", "old value");
      const verified = itemDetails("target-item", "new value");
      harness.authoring.itemDetails = [source, target, verified];
      try {
        await enqueueField(harness.store, source, target, "field-update");
        const completed = nextEvent(harness.processor.onDidCompleteRecord);
        await harness.processor.start();
        await completed;

        deepStrictEqual(harness.authoring.fieldUpdates, [{
          itemId: "target-item",
          fieldName: "Title",
          value: "new value",
        }]);
        deepStrictEqual(harness.authoring.loadedItemIds, [
          "source-item",
          "target-item",
          "target-item",
        ]);
        strictEqual(harness.store.list().length, 0);
      } finally {
        disposeHarness(harness);
      }
    },
  },
  {
    name: "TransferProcessor rejects a stale field snapshot and journals the failure",
    async execute(): Promise<void> {
      const harness = createHarness();
      const queuedSource = itemDetails("source-item", "queued value");
      const currentSource = itemDetails("source-item", "changed later");
      const target = itemDetails("target-item", "target value");
      harness.authoring.itemDetails = [currentSource, target];
      try {
        const queued = await enqueueField(
          harness.store,
          queuedSource,
          target,
          "field-stale",
        );
        const failed = nextEvent(harness.processor.onDidFailRecord);
        await harness.processor.start();
        await failed;

        strictEqual(harness.authoring.fieldUpdates.length, 0);
        strictEqual(harness.store.get(queued.record.id)?.status, "failed");
        match(harness.store.get(queued.record.id)?.error ?? "", /source field changed/u);
        strictEqual(harness.runtime.files.length, 1);
        const journal = decodeJournal(harness.runtime.files[0]?.content);
        strictEqual(journal.outcome, "failed");
        match(String(journal.error), /source field changed/u);
      } finally {
        disposeHarness(harness);
      }
    },
  },
  {
    name: "TransferProcessor fails when post-mutation field verification disagrees",
    async execute(): Promise<void> {
      const harness = createHarness();
      const source = itemDetails("source-item", "new value");
      const target = itemDetails("target-item", "old value");
      const unverified = itemDetails("target-item", "old value");
      harness.authoring.itemDetails = [source, target, unverified];
      try {
        const queued = await enqueueField(
          harness.store,
          source,
          target,
          "field-verification-failure",
        );
        const failed = nextEvent(harness.processor.onDidFailRecord);
        await harness.processor.start();
        await failed;

        strictEqual(harness.authoring.fieldUpdates.length, 1);
        strictEqual(harness.store.get(queued.record.id)?.status, "failed");
        match(
          harness.store.get(queued.record.id)?.error ?? "",
          /verification did not find the transferred field value/u,
        );
        strictEqual(harness.store.processorState, "paused");
        strictEqual(decodeJournal(harness.runtime.files[0]?.content).outcome, "failed");
      } finally {
        disposeHarness(harness);
      }
    },
  },
  {
    name: "TransferProcessor persists subtree progress and completes a fresh transfer",
    async execute(): Promise<void> {
      const harness = createHarness();
      harness.authoring.transferProgress = [
        { stage: "copyingChunks", current: 1, total: 2 },
        { stage: "sitecore", completed: 0, total: 1 },
      ];
      harness.authoring.transferCheckpoint = pendingCheckpoint();
      harness.authoring.transferResult = finishedCheckpoint();
      try {
        const queued = await harness.store.enqueue({
          ...subtreeDraft("subtree-fresh"),
          mode: "exactMirror",
        });
        const completed = nextEvent(harness.processor.onDidCompleteRecord);
        await harness.processor.start();
        await completed;

        deepStrictEqual(harness.authoring.subtreeMergeStrategies, ["OverrideExistingTree"]);
        strictEqual(harness.store.get(queued.record.id)?.status, "completed");
        strictEqual(harness.runtime.files.length, 1);
        strictEqual(harness.logger.warnings.length, 1);
        match(harness.logger.warnings[0] ?? "", /monitoring is unavailable/u);
      } finally {
        disposeHarness(harness);
      }
    },
  },
  {
    name: "TransferProcessor pauses a pending subtree and resumes its checkpoint",
    async execute(): Promise<void> {
      let releaseTransfer: (() => void) | undefined;
      let markTransferStarted: (() => void) | undefined;
      const transferStarted = new Promise<void>((resolve) => {
        markTransferStarted = resolve;
      });
      const transferGate = new Promise<void>((resolve) => {
        releaseTransfer = resolve;
      });
      const harness = createHarness();
      harness.authoring.transferStarted = markTransferStarted;
      harness.authoring.transferGate = transferGate;
      harness.authoring.transferResult = pendingCheckpoint();
      harness.authoring.resumeResults = [finishedCheckpoint()];
      try {
        const queued = await harness.store.enqueue(subtreeDraft("subtree-pending"));
        await harness.processor.start();
        await transferStarted;
        await harness.processor.pause();
        releaseTransfer?.();
        await waitFor(() => harness.store.processorState === "paused");

        const paused = harness.store.get(queued.record.id);
        strictEqual(paused?.status, "waitingForSitecore");
        strictEqual(paused?.kind === "subtree" ? paused.checkpoint?.state : undefined, "Pending");

        const completed = nextEvent(harness.processor.onDidCompleteRecord);
        await harness.processor.start();
        await completed;
        strictEqual(harness.store.get(queued.record.id)?.status, "completed");
      } finally {
        disposeHarness(harness);
      }
    },
  },
  {
    name: "TransferProcessor marks a confirmed deployment change and pauses",
    async execute(): Promise<void> {
      const harness = createHarness();
      harness.connections.add("source-connection", "Source", "source-environment");
      harness.connections.add("target-connection", "Target", "target-environment");
      harness.deployments.resolveError = undefined;
      harness.deployments.baselinesByEnvironment.set("source-environment", [
        { environmentId: "source-environment", deploymentId: "source-1" },
        { environmentId: "source-environment", deploymentId: "source-2" },
      ]);
      harness.deployments.baselinesByEnvironment.set("target-environment", [
        { environmentId: "target-environment", deploymentId: "target-1" },
        { environmentId: "target-environment", deploymentId: "target-1" },
      ]);
      harness.authoring.transferResult = finishedCheckpoint();
      try {
        const queued = await harness.store.enqueue(subtreeDraft("deployment-change"));
        const failed = nextEvent(harness.processor.onDidFailRecord);
        await harness.processor.start();
        await failed;

        const record = harness.store.get(queued.record.id);
        strictEqual(record?.status, "failed");
        strictEqual(record?.kind === "subtree" ? record.failureKind : undefined, "deploymentChanged");
        strictEqual(harness.store.processorState, "paused");
        match(record?.error ?? "", /latest source deployment.*changed/u);
      } finally {
        disposeHarness(harness);
      }
    },
  },
];

function createHarness(
  executePublishing?: (publishRunId: string) => Promise<void>,
  store = new TransferQueueStore(new MemoryMemento()),
): ProcessorHarness {
  const connections = new TestConnectionStore();
  const authoring = new TestAuthoringClient();
  const deployments = new TestDeploymentClient();
  const runtime = new TestRuntime();
  const logger = new TestLogger();
  const processor = new TransferProcessor(
    store,
    connections,
    authoring,
    deployments,
    vscode.Uri.file("C:\\xm-cloud-sync-tests"),
    "0.10.0-test",
    logger,
    executePublishing,
    runtime,
  );
  return { store, processor, connections, authoring, deployments, runtime, logger };
}

function disposeHarness(harness: ProcessorHarness): void {
  harness.processor.dispose();
  harness.store.dispose();
}

async function enqueueField(
  store: TransferQueueStore,
  source: AuthoringItemDetails,
  target: AuthoringItemDetails,
  duplicateKey: string,
) {
  const draft = fieldDraft(duplicateKey);
  const sourceField = source.fields[0];
  const targetField = target.fields[0];
  if (!sourceField || !targetField) {
    throw new Error("Field fixtures must contain a field.");
  }
  return store.enqueue({
    ...draft,
    source: {
      ...draft.source,
      itemId: source.itemId,
      fieldId: sourceField.fieldId,
      fingerprint: fieldStateFingerprint(source, sourceField),
    },
    target: {
      ...draft.target,
      itemId: target.itemId,
      fieldId: targetField.fieldId,
      fingerprint: fieldStateFingerprint(target, targetField),
    },
  });
}

function itemDetails(itemId: string, value: string): AuthoringItemDetails {
  return {
    itemId,
    name: itemId,
    displayName: itemId,
    path: `/sitecore/content/${itemId}`,
    hasChildren: false,
    language: "en",
    version: 1,
    template: { templateId: "template-id", name: "Page" },
    availableVersions: [{ language: "en", version: 1 }],
    fields: [{
      fieldId: "field-id",
      name: "Title",
      label: "Title",
      value,
      type: "Single-Line Text",
      typeKey: "single-line text",
      scope: "VERSIONED",
      sortOrder: 1,
      sectionName: "Content",
      sectionSortOrder: 1,
      isStandardTemplate: false,
      containsFallbackValue: false,
      containsInheritedValue: false,
      containsStandardValue: false,
      textual: true,
    }],
  };
}

function finishedCheckpoint(): ContentTransferResult {
  return {
    ...pendingCheckpoint(),
    state: "Finished",
    destinationItemId: "destination-item",
  };
}

function publishingRunId(record: OperationRecord): string {
  if (record.kind !== "publishing") {
    throw new Error("Expected a publishing operation.");
  }
  return record.publishRunId;
}

function nextEvent<T>(event: vscode.Event<T>): Promise<T> {
  return new Promise((resolve) => {
    const subscription = event((value) => {
      subscription.dispose();
      resolve(value);
    });
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for processor state.");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface JournalContent {
  readonly extensionVersion: unknown;
  readonly outcome: unknown;
  readonly error?: unknown;
  readonly record: { readonly id?: unknown };
}

function decodeJournal(content: Uint8Array | undefined): JournalContent {
  if (!content) {
    throw new Error("Expected a journal file.");
  }
  return JSON.parse(new TextDecoder().decode(content)) as JournalContent;
}
