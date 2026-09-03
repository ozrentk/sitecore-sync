import { notStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import type {
  AuthoringItemDetails,
  AuthoringItemField,
} from "../../src/sitecore/authoringClient";
import {
  fieldStateFingerprint,
  isOperationRecord,
  isTransferRecord,
  normalizeTransferId,
  subtreeTransferMode,
  subtreeTransferModeLabel,
} from "../../src/transfers/transferTypes";

test("fieldStateFingerprint normalizes IDs and language casing", () => {
  const first = fieldStateFingerprint(
    itemDetails("{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}", "EN", 3),
    itemField("{BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB}", "VERSIONED"),
  );
  const second = fieldStateFingerprint(
    itemDetails("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "en", 3),
    itemField("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "VERSIONED"),
  );

  strictEqual(first, second);
  strictEqual(first.length, 64);
});

test("fieldStateFingerprint includes context according to field scope", () => {
  const shared = itemField("field-id", "SHARED");
  strictEqual(
    fieldStateFingerprint(itemDetails("item-id", "en", 1), shared),
    fieldStateFingerprint(itemDetails("item-id", "de", 9), shared),
  );

  const unversioned = itemField("field-id", "UNVERSIONED");
  strictEqual(
    fieldStateFingerprint(itemDetails("item-id", "en", 1), unversioned),
    fieldStateFingerprint(itemDetails("item-id", "EN", 9), unversioned),
  );
  notStrictEqual(
    fieldStateFingerprint(itemDetails("item-id", "en", 1), unversioned),
    fieldStateFingerprint(itemDetails("item-id", "de", 1), unversioned),
  );

  const versioned = itemField("field-id", "VERSIONED");
  notStrictEqual(
    fieldStateFingerprint(itemDetails("item-id", "en", 1), versioned),
    fieldStateFingerprint(itemDetails("item-id", "en", 2), versioned),
  );
});

test("fieldStateFingerprint changes with field state", () => {
  const details = itemDetails("item-id", "en", 1);
  const baseline = itemField("field-id", "VERSIONED");
  const fingerprint = fieldStateFingerprint(details, baseline);

  for (const changed of [
    { ...baseline, value: "Changed" },
    { ...baseline, name: "Other" },
    { ...baseline, containsFallbackValue: true },
    { ...baseline, containsInheritedValue: true },
    { ...baseline, containsStandardValue: true },
    { ...baseline, scope: "SHARED" as const },
  ]) {
    notStrictEqual(fieldStateFingerprint(details, changed), fingerprint);
  }
});

test("transfer ID and subtree mode helpers preserve compatibility", () => {
  strictEqual(normalizeTransferId("{ABCDEFAB-CDEF-ABCD-EFAB-CDEFABCDEFAB}"), "abcdefabcdefabcdefabcdefabcdefab");
  strictEqual(subtreeTransferMode({}), "synchronize");
  strictEqual(subtreeTransferMode({ mode: "addMissing" }), "addMissing");
  strictEqual(subtreeTransferModeLabel("addMissing"), "Add missing");
  strictEqual(subtreeTransferModeLabel("synchronize"), "Synchronize");
  strictEqual(subtreeTransferModeLabel("exactMirror"), "Exact mirror");
});

test("isTransferRecord accepts complete field and subtree records", () => {
  strictEqual(isTransferRecord(fieldRecord()), true);
  strictEqual(isTransferRecord(subtreeRecord()), true);
  strictEqual(isTransferRecord({ ...subtreeRecord(), mode: undefined }), true);
  strictEqual(isTransferRecord({
    ...subtreeRecord(),
    progress: { stage: "sitecore", current: 1, total: 3 },
  }), true);
});

test("isTransferRecord rejects malformed base and sequence context data", () => {
  const valid = fieldRecord();
  for (const value of [
    null,
    [],
    { ...valid, id: 42 },
    { ...valid, sequence: Number.NaN },
    { ...valid, sequence: -1 },
    { ...valid, sequence: 1.5 },
    { ...valid, status: "unknown" },
    { ...valid, startedAt: 42 },
    { ...valid, intent: {} },
    {
      ...valid,
      intent: {
        kind: "subtree",
        source: { connectionId: "source", rootItemId: "item", rootPath: "/sitecore/item" },
        destination: { connectionId: "target" },
        mode: "synchronize",
      },
    },
    { ...valid, sequenceRunId: "run-id" },
    { ...valid, sequenceOperationIndex: 0 },
    { ...valid, sequenceRunId: "run-id", sequenceOperationIndex: -1 },
  ]) {
    strictEqual(isTransferRecord(value), false);
  }
});

test("isTransferRecord validates field endpoints", () => {
  const valid = fieldRecord();
  for (const value of [
    { ...valid, direction: "sideways" },
    { ...valid, source: null },
    { ...valid, source: { ...valid.source, connectionId: 42 } },
    { ...valid, source: { ...valid.source, version: -1 } },
    { ...valid, target: { ...valid.target, fingerprint: undefined } },
  ]) {
    strictEqual(isTransferRecord(value), false);
  }
});

test("isTransferRecord validates subtree recovery data", () => {
  const valid = subtreeRecord();
  for (const value of [
    { ...valid, mode: "merge" },
    { ...valid, targetSide: "center" },
    { ...valid, targetRefreshPlan: [{ itemId: "item", path: "/item", depth: -1, loadLevel: true }] },
    { ...valid, preflight: { sourceItems: 1, targetItems: 1, addItems: 0, updateItems: 0 } },
    { ...valid, progress: { stage: "copyingChunks", current: 4, total: 3 } },
    { ...valid, checkpoint: { ...valid.checkpoint, chunkSets: [{ chunkSetId: "set", chunkCount: -1, contentTransferFileName: "file" }] } },
    { ...valid, deploymentBaselines: { source: { environmentId: "source" } } },
    { ...valid, failureKind: "unknown" },
  ]) {
    strictEqual(isTransferRecord(value), false);
  }
});

test("isOperationRecord accepts transfer and publishing records", () => {
  strictEqual(isOperationRecord(fieldRecord()), true);
  strictEqual(isOperationRecord(subtreeRecord()), true);
  strictEqual(isOperationRecord(publishingRecord()), true);
});

test("isOperationRecord rejects malformed publishing records", () => {
  const valid = publishingRecord();
  for (const value of [
    { ...valid, publishKind: "diagnostic" },
    { ...valid, publishRunId: 42 },
    { ...valid, connectionName: undefined },
    { ...valid, itemId: undefined },
    { ...valid, language: false },
    { ...valid, progressSummary: 42 },
    { ...valid, sequenceRunId: "run-id" },
  ]) {
    strictEqual(isOperationRecord(value), false);
  }
});

function itemDetails(itemId: string, language: string, version: number): AuthoringItemDetails {
  return {
    itemId,
    name: "Home",
    displayName: "Home",
    path: "/sitecore/content/Home",
    hasChildren: false,
    language,
    version,
    template: { templateId: "template-id", name: "Page" },
    availableVersions: [],
    fields: [],
  };
}

function itemField(fieldId: string, scope: AuthoringItemField["scope"]): AuthoringItemField {
  return {
    fieldId,
    name: "Title",
    label: "Title",
    value: "Welcome",
    type: "Single-Line Text",
    typeKey: "text",
    scope,
    sortOrder: 0,
    sectionName: "Content",
    sectionSortOrder: 0,
    isStandardTemplate: false,
    containsFallbackValue: false,
    containsInheritedValue: false,
    containsStandardValue: false,
    textual: true,
  };
}

function recordBase() {
  return {
    id: "record-id",
    sequence: 1,
    duplicateKey: "duplicate-key",
    status: "queued",
    enqueuedAt: "2026-01-01T00:00:00.000Z",
  } as const;
}

function fieldEndpoint(side: string) {
  return {
    connectionId: `${side}-connection`,
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

function fieldRecord() {
  return {
    ...recordBase(),
    kind: "fieldValue",
    direction: "leftToRight",
    source: fieldEndpoint("source"),
    target: fieldEndpoint("target"),
  } as const;
}

function subtreeRecord() {
  return {
    ...recordBase(),
    kind: "subtree",
    mode: "exactMirror",
    direction: "leftToRight",
    sourceConnectionId: "source",
    sourceConnectionName: "Source",
    targetConnectionId: "target",
    targetConnectionName: "Target",
    sourceItemId: "source-item",
    sourcePath: "/sitecore/content/Source",
    sourceLanguage: "en",
    targetLanguage: "en",
    comparisonRowKey: "row-key",
    targetSide: "right",
    targetRefreshPlan: [{ itemId: "target-item", path: "/sitecore/content/Target", depth: 0, loadLevel: true }],
    preflight: { sourceItems: 1, targetItems: 1, addItems: 0, updateItems: 1, removeItems: 0 },
    checkpoint: {
      state: "Pending",
      transferId: "transfer-id",
      sourceItemId: "source-item",
      sourceChildIds: ["child-id"],
      chunkSets: [{ chunkSetId: "set-id", chunkCount: 1, contentTransferFileName: "transfer.raif" }],
      itemTransferIds: ["transfer.raif"],
    },
    progress: { stage: "sitecore", completed: 1, total: 1, startedAt: "2026-01-01T00:00:00.000Z" },
    deploymentBaselines: {
      source: { environmentId: "source-environment", deploymentId: "source-deployment" },
      target: { environmentId: "target-environment" },
    },
    failureKind: "deploymentChanged",
  } as const;
}

function publishingRecord() {
  return {
    ...recordBase(),
    kind: "publishing",
    publishRunId: "publish-run",
    publishKind: "power",
    connectionId: "connection-id",
    connectionName: "Primary CM",
    itemId: "item-id",
    itemPath: "/sitecore/content/Home",
    language: "en",
    progressSummary: "Publishing",
  } as const;
}
