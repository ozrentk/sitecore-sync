import {
  deepStrictEqual,
  match,
  rejects,
  strictEqual,
} from "node:assert/strict";
import { test } from "node:test";
import type { ConnectionStore } from "../../src/connections/connectionStore";
import type { XmCloudConnection } from "../../src/connections/connection";
import { OperationIntentService } from "../../src/operations/operationIntentService";
import type {
  FieldTransferIntent,
  PublishingIntent,
  SequenceOperationContext,
  SubtreeTransferIntent,
} from "../../src/operations/operationTypes";
import type { PublishingManager } from "../../src/publishing/publishingManager";
import type {
  AuthoringContentClient,
  AuthoringItemDetails,
  AuthoringItemField,
} from "../../src/sitecore/authoringClient";
import type { TransferQueueStore } from "../../src/transfers/transferQueueStore";
import type {
  FieldValueTransferDraft,
  OperationRecord,
  SubtreeTransferDraft,
  TransferDraft,
} from "../../src/transfers/transferTypes";

test("intentForRecord preserves saved intents and reconstructs legacy transfer intents", () => {
  const harness = createHarness();
  const saved = fieldIntent();
  const savedRecord = fieldRecord({ intent: saved });
  strictEqual(harness.service.intentForRecord(savedRecord), saved);

  const legacyField = fieldRecord({ intent: undefined });
  deepStrictEqual(harness.service.intentForRecord(legacyField), {
    kind: "fieldValue",
    source: {
      connectionId: "source",
      itemId: "source-item",
      itemPath: "/sitecore/content/Source",
      language: "en",
      fieldId: "{FIELD-ID}",
      fieldName: "Title",
      fieldLabel: "Headline",
    },
    destination: {
      connectionId: "destination",
      itemId: "destination-item",
      itemPath: "/sitecore/content/Destination",
      language: "en",
      fieldId: "{FIELD-ID}",
      fieldName: "Title",
      fieldLabel: "Headline",
    },
  });

  deepStrictEqual(harness.service.intentForRecord(subtreeRecord()), subtreeIntent());
});

test("intentForRecord delegates legacy publishing records and replay handles unavailable intent", async () => {
  const harness = createHarness();
  const intent = publishingIntent();
  harness.publishingIntent = intent;
  const publishing = publishingRecord();

  strictEqual(harness.service.intentForRecord(publishing), intent);
  deepStrictEqual(harness.intentLookups, ["publish-run"]);

  harness.publishingIntent = undefined;
  strictEqual(await harness.service.replay(publishing), undefined);
  strictEqual(harness.publishingEnqueues.length, 0);
});

test("validate reports missing connections and credentials in endpoint order", async () => {
  const harness = createHarness();
  harness.connections.delete("source");
  strictEqual(
    await harness.service.validate(fieldIntent()),
    "Connection source no longer exists.",
  );

  harness.connections.set("source", connection("source", "Source"));
  harness.secrets.delete("source");
  strictEqual(
    await harness.service.validate(fieldIntent()),
    "Credentials for Source are unavailable.",
  );

  harness.secrets.set("source", "source-secret");
  harness.secrets.delete("destination");
  strictEqual(
    await harness.service.validate(fieldIntent()),
    "Credentials for Destination are unavailable.",
  );
});

test("validate applies diagnostic publishing requirements but accepts standard publishing", async () => {
  const harness = createHarness();
  const standard: PublishingIntent = { ...publishingIntent(), publishKind: "standard" };
  harness.edgeTokens.delete("source");
  harness.savedProfiles.delete("source");
  strictEqual(await harness.service.validate(standard), undefined);

  const traced: PublishingIntent = { ...standard, publishKind: "traced" };
  strictEqual(
    await harness.service.validate(traced),
    "The Experience Edge token required by this publishing operation is unavailable.",
  );

  harness.edgeTokens.set("source", "edge-token");
  strictEqual(
    await harness.service.validate(traced),
    "The Experience Edge profile required by this publishing operation is unavailable.",
  );

  harness.savedProfiles.add("source");
  strictEqual(
    await harness.service.validate({ ...traced, siteName: undefined }),
    "The diagnostic publishing operation has no saved Sitecore site or route.",
  );
  strictEqual(await harness.service.validate(traced), undefined);
});

test("enqueue prepares a field transfer from current item state and sequence context", async () => {
  const harness = createHarness();
  harness.itemDetails.set("source-item", itemDetails({
    itemId: "{SOURCE-ITEM}",
    path: "/sitecore/content/Current Source",
    language: "EN",
    version: 3,
    fields: [field({ fieldId: "field-id", name: "CurrentTitle", label: "Current title" })],
  }));
  harness.itemDetails.set("destination-item", itemDetails({
    itemId: "{DESTINATION-ITEM}",
    path: "/sitecore/content/Current Destination",
    language: "en",
    version: 7,
    fields: [field({ fieldId: "FIELD-ID", name: "CurrentTitle", label: "Destination title" })],
  }));
  const context = sequenceContext();

  const record = await harness.service.enqueue(fieldIntent(), context);

  strictEqual(record, harness.enqueuedRecords[0]);
  strictEqual(harness.loadedItems.length, 2);
  strictEqual(harness.loadedItems[0]?.secret, "source-secret");
  strictEqual(harness.loadedItems[1]?.secret, "destination-secret");
  const draft = harness.transferDrafts[0] as FieldValueTransferDraft;
  strictEqual(draft.duplicateKey, "field-replay:sequence-run:2");
  strictEqual(draft.sequenceRunId, "sequence-run");
  strictEqual(draft.sequenceOperationIndex, 2);
  strictEqual(draft.source.itemId, "{SOURCE-ITEM}");
  strictEqual(draft.source.fieldName, "CurrentTitle");
  strictEqual(draft.source.fieldLabel, "Headline");
  strictEqual(draft.target.fieldLabel, "Headline");
  match(draft.source.fingerprint, /^[0-9a-f]{64}$/u);
});

test("enqueue field transfer rejects unavailable connections, credentials, and fields", async () => {
  const harness = createHarness();
  harness.connections.delete("destination");
  await rejects(
    harness.service.enqueue(fieldIntent()),
    /field-transfer connection or its credentials are unavailable/u,
  );

  harness.connections.set("destination", connection("destination", "Destination"));
  harness.itemDetails.set("source-item", itemDetails({ fields: [] }));
  harness.itemDetails.set("destination-item", itemDetails());
  await rejects(
    harness.service.enqueue(fieldIntent()),
    /saved field-transfer field no longer exists/u,
  );
  strictEqual(harness.transferDrafts.length, 0);
});

test("enqueue subtree chooses the best common language and captures the current root", async () => {
  const harness = createHarness();
  harness.languages.set("source", ["da", "EN-US", "fr"]);
  harness.languages.set("destination", ["fr", "en-us"]);
  harness.itemDetails.set("root-item", itemDetails({
    itemId: "current-root",
    path: "/sitecore/content/Current Home",
    language: "EN-US",
  }));

  await harness.service.enqueue(subtreeIntent(), sequenceContext());

  deepStrictEqual(harness.loadedLanguages, ["source", "destination"]);
  strictEqual(harness.loadedItems[0]?.language, "EN-US");
  const draft = harness.transferDrafts[0] as SubtreeTransferDraft;
  strictEqual(draft.duplicateKey, "subtree-replay:sequence-run:2");
  strictEqual(draft.sourceItemId, "current-root");
  strictEqual(draft.sourcePath, "/sitecore/content/Current Home");
  strictEqual(draft.sourceLanguage, "EN-US");
  strictEqual(draft.targetLanguage, "EN-US");
  strictEqual(draft.mode, "exactMirror");
  deepStrictEqual(draft.targetRefreshPlan, []);
});

test("enqueue subtree prefers exact English and rejects connections without a common language", async () => {
  const harness = createHarness();
  harness.languages.set("source", ["fr", "en-US", "en"]);
  harness.languages.set("destination", ["EN", "en-us"]);
  await harness.service.enqueue(subtreeIntent());
  strictEqual(harness.loadedItems[0]?.language, "en");

  const noCommon = createHarness();
  noCommon.languages.set("source", ["en"]);
  noCommon.languages.set("destination", ["da"]);
  await rejects(
    noCommon.service.enqueue(subtreeIntent()),
    /no common language for runtime inspection/u,
  );
  strictEqual(noCommon.transferDrafts.length, 0);
});

test("publishing enqueue, replay, and prepared-record discard delegate to their owners", async () => {
  const harness = createHarness();
  const intent = publishingIntent();
  const context = sequenceContext();
  const publishing = publishingRecord({ intent });
  harness.publishingRecord = publishing;

  strictEqual(await harness.service.enqueue(intent, context), publishing);
  deepStrictEqual(harness.publishingEnqueues, [{ intent, context }]);

  strictEqual(await harness.service.replay(publishing), publishing);
  strictEqual(harness.publishingEnqueues[1]?.context, undefined);

  await harness.service.discardPrepared(publishing);
  deepStrictEqual(harness.abandonedRuns, ["publish-run"]);
  deepStrictEqual(harness.archivedRecords, ["publishing-record"]);

  await harness.service.discardPrepared(fieldRecord());
  deepStrictEqual(harness.abandonedRuns, ["publish-run"]);
  deepStrictEqual(harness.archivedRecords, ["publishing-record", "field-record"]);
});

interface IntentHarness {
  readonly service: OperationIntentService;
  readonly connections: Map<string, XmCloudConnection>;
  readonly secrets: Map<string, string>;
  readonly edgeTokens: Map<string, string>;
  readonly savedProfiles: Set<string>;
  readonly languages: Map<string, readonly string[]>;
  readonly itemDetails: Map<string, AuthoringItemDetails>;
  readonly loadedLanguages: string[];
  readonly loadedItems: Array<{ readonly connectionId: string; readonly secret: string; readonly itemId: string; readonly language: string }>;
  readonly transferDrafts: TransferDraft[];
  readonly enqueuedRecords: OperationRecord[];
  readonly publishingEnqueues: Array<{ readonly intent: PublishingIntent; readonly context?: SequenceOperationContext }>;
  readonly intentLookups: string[];
  readonly abandonedRuns: string[];
  readonly archivedRecords: string[];
  publishingIntent: PublishingIntent | undefined;
  publishingRecord: OperationRecord;
}

function createHarness(): IntentHarness {
  const connections = new Map([
    ["source", connection("source", "Source")],
    ["destination", connection("destination", "Destination")],
  ]);
  const secrets = new Map([
    ["source", "source-secret"],
    ["destination", "destination-secret"],
  ]);
  const edgeTokens = new Map([["source", "edge-token"]]);
  const savedProfiles = new Set(["source"]);
  const languages = new Map<string, readonly string[]>([
    ["source", ["en"]],
    ["destination", ["en"]],
  ]);
  const detailsByItemId = new Map<string, AuthoringItemDetails>([
    ["source-item", itemDetails({ itemId: "source-item", path: "/sitecore/content/Source" })],
    ["destination-item", itemDetails({ itemId: "destination-item", path: "/sitecore/content/Destination" })],
    ["root-item", itemDetails({ itemId: "root-item", path: "/sitecore/content/Home" })],
  ]);
  const loadedLanguages: string[] = [];
  const loadedItems: Array<IntentHarness["loadedItems"][number]> = [];
  const transferDrafts: TransferDraft[] = [];
  const enqueuedRecords: OperationRecord[] = [];
  const publishingEnqueues: Array<IntentHarness["publishingEnqueues"][number]> = [];
  const intentLookups: string[] = [];
  const abandonedRuns: string[] = [];
  const archivedRecords: string[] = [];
  const harness = {} as IntentHarness;

  const connectionStore = {
    get: (id: string) => connections.get(id),
    getClientSecret: async (id: string) => secrets.get(id),
    getEdgeToken: async (id: string) => edgeTokens.get(id),
  };
  const authoring = {
    loadLanguages: async (target: XmCloudConnection) => {
      loadedLanguages.push(target.id);
      return (languages.get(target.id) ?? []).map((name) => ({
        name,
        displayName: name,
        englishName: name,
        nativeName: name,
      }));
    },
    loadItemDetails: async (
      target: XmCloudConnection,
      secret: string,
      itemId: string,
      language: string,
    ) => {
      loadedItems.push({ connectionId: target.id, secret, itemId, language });
      const details = detailsByItemId.get(itemId);
      if (!details) {
        throw new Error(`No item fixture for ${itemId}.`);
      }
      return { ...details, language };
    },
  };
  const operations = {
    enqueue: async (draft: TransferDraft) => {
      transferDrafts.push(draft);
      const record = draft.kind === "fieldValue"
        ? fieldRecord({ ...draft, id: `record-${transferDrafts.length}` })
        : subtreeRecord({ ...draft, id: `record-${transferDrafts.length}` });
      enqueuedRecords.push(record);
      return { record, added: true };
    },
    archive: async (recordId: string) => {
      archivedRecords.push(recordId);
      return undefined;
    },
  };
  const publishing = {
    intentForRun: (runId: string) => {
      intentLookups.push(runId);
      return harness.publishingIntent;
    },
    hasSavedProfile: (connectionId: string) => savedProfiles.has(connectionId),
    enqueueIntent: async (intent: PublishingIntent, context?: SequenceOperationContext) => {
      publishingEnqueues.push({ intent, context });
      return harness.publishingRecord;
    },
    abandonQueuedRun: async (runId: string) => {
      abandonedRuns.push(runId);
    },
  };

  Object.assign(harness, {
    service: new OperationIntentService(
      connectionStore as unknown as ConnectionStore,
      authoring as unknown as AuthoringContentClient,
      operations as unknown as TransferQueueStore,
      publishing as unknown as PublishingManager,
    ),
    connections,
    secrets,
    edgeTokens,
    savedProfiles,
    languages,
    itemDetails: detailsByItemId,
    loadedLanguages,
    loadedItems,
    transferDrafts,
    enqueuedRecords,
    publishingEnqueues,
    intentLookups,
    abandonedRuns,
    archivedRecords,
    publishingIntent: undefined,
    publishingRecord: publishingRecord(),
  });
  return harness;
}

function connection(id: string, name: string): XmCloudConnection {
  return {
    id,
    name,
    serverUrl: `https://${id}.example.com`,
    clientId: `${id}-client`,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function fieldIntent(): FieldTransferIntent {
  return {
    kind: "fieldValue",
    source: {
      connectionId: "source",
      itemId: "source-item",
      itemPath: "/sitecore/content/Source",
      language: "en",
      fieldId: "{FIELD-ID}",
      fieldName: "Title",
      fieldLabel: "Headline",
    },
    destination: {
      connectionId: "destination",
      itemId: "destination-item",
      itemPath: "/sitecore/content/Destination",
      language: "en",
      fieldId: "{FIELD-ID}",
      fieldName: "Title",
      fieldLabel: "Headline",
    },
  };
}

function subtreeIntent(): SubtreeTransferIntent {
  return {
    kind: "subtree",
    source: {
      connectionId: "source",
      rootItemId: "root-item",
      rootPath: "/sitecore/content/Home",
    },
    destination: { connectionId: "destination" },
    mode: "exactMirror",
  };
}

function publishingIntent(): PublishingIntent {
  return {
    kind: "publishing",
    publishKind: "power",
    connectionId: "source",
    rootItemId: "root-item",
    rootPath: "/sitecore/content/Home",
    language: "en",
    publishMode: "SMART",
    publishSubItems: true,
    publishRelatedItems: true,
    siteName: "website",
    route: "/",
  };
}

function sequenceContext(): SequenceOperationContext {
  return { sequenceRunId: "sequence-run", sequenceOperationIndex: 2 };
}

function itemDetails(overrides: Partial<AuthoringItemDetails> = {}): AuthoringItemDetails {
  return {
    itemId: "item-id",
    name: "Item",
    displayName: "Item",
    path: "/sitecore/content/Item",
    hasChildren: false,
    language: "en",
    version: 1,
    template: { templateId: "template-id", name: "Template" },
    availableVersions: [{ language: "en", version: 1 }],
    fields: [field()],
    ...overrides,
  };
}

function field(overrides: Partial<AuthoringItemField> = {}): AuthoringItemField {
  return {
    fieldId: "{FIELD-ID}",
    name: "Title",
    label: "Title",
    value: "Value",
    type: "Single-Line Text",
    typeKey: "single-line text",
    scope: "VERSIONED",
    sortOrder: 100,
    sectionName: "Content",
    sectionSortOrder: 100,
    isStandardTemplate: false,
    containsFallbackValue: false,
    containsInheritedValue: false,
    containsStandardValue: false,
    textual: true,
    ...overrides,
  };
}

function fieldRecord(overrides: Partial<OperationRecord> = {}): OperationRecord {
  return {
    kind: "fieldValue",
    id: "field-record",
    sequence: 1,
    duplicateKey: "field-duplicate",
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
      fieldId: "{FIELD-ID}",
      fieldName: "Title",
      fieldLabel: "Headline",
      fingerprint: "source-fingerprint",
    },
    target: {
      connectionId: "destination",
      connectionName: "Destination",
      itemId: "destination-item",
      itemPath: "/sitecore/content/Destination",
      language: "en",
      version: 1,
      fieldId: "{FIELD-ID}",
      fieldName: "Title",
      fieldLabel: "Headline",
      fingerprint: "destination-fingerprint",
    },
    ...overrides,
  } as OperationRecord;
}

function subtreeRecord(overrides: Partial<OperationRecord> = {}): OperationRecord {
  return {
    kind: "subtree",
    id: "subtree-record",
    sequence: 1,
    duplicateKey: "subtree-duplicate",
    status: "queued",
    enqueuedAt: "2026-01-01T00:00:00.000Z",
    direction: "leftToRight",
    mode: "exactMirror",
    sourceConnectionId: "source",
    sourceConnectionName: "Source",
    targetConnectionId: "destination",
    targetConnectionName: "Destination",
    sourceItemId: "root-item",
    sourcePath: "/sitecore/content/Home",
    sourceLanguage: "en",
    targetLanguage: "en",
    comparisonRowKey: "",
    targetSide: "right",
    targetRefreshPlan: [],
    ...overrides,
  } as OperationRecord;
}

function publishingRecord(overrides: Partial<OperationRecord> = {}): OperationRecord {
  return {
    kind: "publishing",
    id: "publishing-record",
    sequence: 1,
    duplicateKey: "publishing-duplicate",
    status: "queued",
    enqueuedAt: "2026-01-01T00:00:00.000Z",
    publishRunId: "publish-run",
    publishKind: "power",
    connectionId: "source",
    connectionName: "Source",
    itemId: "root-item",
    itemPath: "/sitecore/content/Home",
    language: "en",
    ...overrides,
  } as OperationRecord;
}
