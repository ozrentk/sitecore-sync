import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import {
  defaultSequenceName,
  isOperationIntent,
  isOperationSequenceRun,
  isSavedOperationSequence,
  operationDefinitionVersion,
  operationIntentConnectionIds,
  operationIntentLabel,
  type FieldTransferIntent,
  type OperationIntent,
  type OperationSequenceRun,
  type PublishingIntent,
  type SavedOperationSequence,
  type SubtreeTransferIntent,
} from "../../src/operations/operationTypes";

test("operation intent labels and connection IDs describe every operation kind", () => {
  const field = fieldIntent();
  const subtree = subtreeIntent();
  const publishing = publishingIntent();

  strictEqual(operationIntentLabel(field), "Field Transfer - Headline");
  strictEqual(operationIntentLabel({
    ...field,
    source: { ...field.source, fieldLabel: "" },
  }), "Field Transfer - Title");
  strictEqual(operationIntentLabel(subtree), "Subtree Transfer - Home");
  strictEqual(operationIntentLabel(publishing), "Power publish - Home");
  strictEqual(defaultSequenceName(publishing), "Power publish - Home");
  deepStrictEqual(operationIntentConnectionIds(field), ["source", "destination"]);
  deepStrictEqual(operationIntentConnectionIds(subtree), ["source", "destination"]);
  deepStrictEqual(operationIntentConnectionIds(publishing), ["source"]);
});

test("isOperationIntent accepts all supported operation shapes", () => {
  for (const intent of [fieldIntent(), subtreeIntent(), publishingIntent()]) {
    strictEqual(isOperationIntent(intent), true);
  }
});

test("isOperationIntent rejects malformed required operation data", () => {
  for (const value of [
    undefined,
    [],
    {},
    { ...fieldIntent(), source: { ...fieldIntent().source, fieldId: 42 } },
    { ...fieldIntent(), destination: null },
    { ...subtreeIntent(), mode: "merge" },
    { ...subtreeIntent(), source: { connectionId: "source" } },
    { ...publishingIntent(), publishKind: "diagnostic" },
    { ...publishingIntent(), publishMode: "INCREMENTAL" },
    { ...publishingIntent(), publishSubItems: "true" },
  ]) {
    strictEqual(isOperationIntent(value), false);
  }
});

test("isOperationIntent validates optional publishing diagnostics", () => {
  const valid = publishingIntent();
  strictEqual(isOperationIntent(valid), true);

  for (const value of [
    { ...valid, siteName: 42 },
    { ...valid, route: false },
    { ...valid, applicationUrl: {} },
    { ...valid, selectedCollapsedScopeIds: ["scope", 42] },
    { ...valid, observedCollapsedScopeIds: "scope" },
    { ...valid, fieldAssertions: {} },
    { ...valid, fieldAssertions: [{ itemId: "item", fieldName: 42 }] },
    { ...valid, fieldAssertions: [{ itemId: "item", fieldName: "Title", browserSelector: 42 }] },
  ]) {
    strictEqual(isOperationIntent(value), false);
  }
});

test("isSavedOperationSequence validates version, metadata, and nested operations", () => {
  const sequence = savedSequence();
  strictEqual(isSavedOperationSequence(sequence), true);

  for (const value of [
    null,
    { ...sequence, definitionVersion: 2 },
    { ...sequence, name: 42 },
    { ...sequence, description: 42 },
    { ...sequence, operations: "invalid" },
    { ...sequence, operations: [{ ...publishingIntent(), language: 42 }] },
  ]) {
    strictEqual(isSavedOperationSequence(value), false);
  }
});

test("isOperationSequenceRun validates state and operation-result consistency", () => {
  const run = sequenceRun();
  strictEqual(isOperationSequenceRun(run), true);
  strictEqual(isOperationSequenceRun({
    ...run,
    status: "completed",
    currentOperationIndex: 1,
    completedAt: "2026-01-01T00:01:00.000Z",
  }), true);

  for (const value of [
    { ...run, status: "waiting" },
    { ...run, currentOperationIndex: -1 },
    { ...run, currentOperationIndex: 0.5 },
    { ...run, currentOperationIndex: 2 },
    { ...run, operationResults: [] },
    { ...run, operationResults: [{ index: 1, status: "pending" }] },
    { ...run, operationResults: [{ index: 0, status: "unknown" }] },
    { ...run, operationResults: [{ index: 0, status: "failed", error: 42 }] },
    { ...run, pauseRequested: "yes" },
    { ...run, definitionSnapshot: { ...run.definitionSnapshot, operations: [{}] } },
  ]) {
    strictEqual(isOperationSequenceRun(value), false);
  }
});

function fieldIntent(): FieldTransferIntent {
  return {
    kind: "fieldValue",
    source: {
      connectionId: "source",
      itemId: "source-item",
      itemPath: "/sitecore/content/Source",
      language: "en",
      fieldId: "field-id",
      fieldName: "Title",
      fieldLabel: "Headline",
    },
    destination: {
      connectionId: "destination",
      itemId: "destination-item",
      itemPath: "/sitecore/content/Destination",
      language: "en",
      fieldId: "field-id",
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
      rootPath: "/sitecore/content/Home/",
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
    publishMode: "FULL",
    publishSubItems: true,
    publishRelatedItems: false,
    siteName: "website",
    route: "/",
    applicationUrl: "https://www.example.com/",
    fieldAssertions: [
      { itemId: "root-item", fieldName: "Title", browserSelector: "h1" },
    ],
    selectedCollapsedScopeIds: ["root-item"],
    observedCollapsedScopeIds: ["root-item", "dependency-item"],
  };
}

function savedSequence(operations: readonly OperationIntent[] = [publishingIntent()]): SavedOperationSequence {
  return {
    id: "sequence-id",
    definitionVersion: operationDefinitionVersion,
    name: "Release content",
    description: "Publish the selected content.",
    operations,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function sequenceRun(): OperationSequenceRun {
  return {
    id: "run-id",
    sequenceId: "sequence-id",
    definitionSnapshot: savedSequence(),
    status: "running",
    currentOperationIndex: 0,
    operationResults: [{ index: 0, status: "pending" }],
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
