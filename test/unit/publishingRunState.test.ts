import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import type { PublishingIntent } from "../../src/operations/operationTypes";
import {
  isPublishingProfile,
  isPublishRun,
  readPublishingProfiles,
  readPublishRuns,
} from "../../src/publishing/publishingRunState";
import type {
  PublishRun,
  PublishingSiteProfile,
  TraceStage,
} from "../../src/publishing/publishingTypes";

test("isPublishRun accepts a complete Power Publish run", () => {
  strictEqual(isPublishRun(publishRun()), true);
});

test("isPublishRun remains compatible with valid runs from before optional diagnostics", () => {
  const current = publishRun();
  const legacyCompatible = {
    ...current,
    fieldSelections: undefined,
    retryAttempts: undefined,
    powerEdgeVerification: undefined,
    intent: undefined,
    batches: current.batches.map(({ checkpointStatus: _status, checkpointSummary: _summary, checkpointEvidence: _evidence, ...batch }) => batch),
  };

  strictEqual(isPublishRun(legacyCompatible), true);
});

test("isPublishRun validates core metadata and all nested persisted collections", () => {
  const valid = publishRun();
  const invalidValues: readonly unknown[] = [
    undefined,
    [],
    { ...valid, kind: "diagnostic" },
    { ...valid, kind: ["power"] },
    { ...valid, connectionName: 42 },
    { ...valid, publishMode: "INCREMENTAL" },
    { ...valid, publishMode: ["FULL"] },
    { ...valid, publishSubItems: "true" },
    { ...valid, completedAt: false },
    { ...valid, snapshots: {} },
    { ...valid, snapshots: [{ ...valid.snapshots[0], version: -1 }] },
    { ...valid, snapshots: [{ ...valid.snapshots[0], fields: { Title: 42 } }] },
    { ...valid, snapshots: [{ ...valid.snapshots[0], references: ["item", 42] }] },
    { ...valid, fieldSelections: [{ itemId: "item", fieldName: 42 }] },
    { ...valid, fieldSelections: [{ itemId: "item", fieldName: "Title", browserSelector: 42 }] },
    { ...valid, referenceEdges: [{ sourceItemId: "source", targetItemId: "target" }] },
    { ...valid, batches: [{ ...valid.batches[0], itemIds: "item" }] },
    { ...valid, batches: [{ ...valid.batches[0], checkpointStatus: "failed" }] },
    { ...valid, batches: [{ ...valid.batches[0], checkpointStatus: ["matched"] }] },
    { ...valid, powerEdgeVerification: { status: "failed" } },
    { ...valid, powerEdgeVerification: { status: "matched", divergentItemIds: [42] } },
    { ...valid, stages: [{ ...valid.stages[0], id: "deployment" }] },
    { ...valid, stages: [{ ...valid.stages[0], status: "complete" }] },
    { ...valid, stages: [{ ...valid.stages[0], status: ["matched"] }] },
    { ...valid, retryAttempts: [{ ...valid.retryAttempts![0], action: "republish" }] },
    { ...valid, retryAttempts: [{ ...valid.retryAttempts![0], stages: [{}] }] },
  ];

  for (const value of invalidValues) {
    strictEqual(isPublishRun(value), false);
  }
});

test("isPublishRun validates saved replay intent ownership", () => {
  const valid = publishRun();
  strictEqual(isPublishRun({ ...valid, intent: undefined }), true);
  strictEqual(isPublishRun({
    ...valid,
    intent: { ...valid.intent!, publishKind: "traced" },
  }), false);
  strictEqual(isPublishRun({
    ...valid,
    intent: { ...valid.intent!, connectionId: "different-connection" },
  }), false);
  strictEqual(isPublishRun({
    ...valid,
    intent: { kind: "subtree" },
  }), false);
});

test("readPublishRuns filters malformed entries and orders newest first", () => {
  const older = publishRun({ id: "older", createdAt: "2026-01-01T00:00:00.000Z" });
  const newer = publishRun({ id: "newer", createdAt: "2026-02-01T00:00:00.000Z" });

  deepStrictEqual(readPublishRuns({}), []);
  deepStrictEqual(
    readPublishRuns([older, { ...newer, batches: null }, newer]).map((run) => run.id),
    ["newer", "older"],
  );
});

test("publishing profile readers validate optional metadata and preserve order", () => {
  const first: PublishingSiteProfile = {
    connectionId: "first",
    edgeEndpoint: "https://edge.example.com/graphql",
    siteName: "website",
    applicationBaseUrl: "https://www.example.com/",
  };
  const second: PublishingSiteProfile = {
    connectionId: "second",
    edgeEndpoint: "https://edge.example.com/graphql",
  };

  strictEqual(isPublishingProfile(first), true);
  strictEqual(isPublishingProfile({ ...first, siteName: 42 }), false);
  strictEqual(isPublishingProfile({ ...first, applicationBaseUrl: false }), false);
  strictEqual(isPublishingProfile([]), false);
  deepStrictEqual(readPublishingProfiles({}), []);
  deepStrictEqual(
    readPublishingProfiles([first, { connectionId: "broken" }, second]),
    [first, second],
  );
});

function publishRun(overrides: Partial<PublishRun> = {}): PublishRun {
  const intent: PublishingIntent = {
    kind: "publishing",
    publishKind: "power",
    connectionId: "connection-id",
    rootItemId: "root-item",
    rootPath: "/sitecore/content/Home",
    language: "en",
    publishMode: "FULL",
    publishSubItems: true,
    publishRelatedItems: false,
    siteName: "website",
    route: "/",
  };
  return {
    id: "run-id",
    kind: "power",
    connectionId: "connection-id",
    connectionName: "Production",
    targetHost: "production.example.com",
    rootItemId: "root-item",
    rootPath: "/sitecore/content/Home",
    language: "en",
    publishMode: "FULL",
    publishSubItems: true,
    publishRelatedItems: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
    snapshots: [{
      itemId: "root-item",
      path: "/sitecore/content/Home",
      displayName: "Home",
      language: "en",
      version: 1,
      fields: { Title: "Welcome" },
      references: ["dependency-item"],
    }],
    fieldSelections: [{
      itemId: "root-item",
      fieldName: "Title",
      browserSelector: "h1",
    }],
    retryAttempts: [{
      attemptedAt: "2026-01-01T00:00:30.000Z",
      action: "verificationRetry",
      conclusion: "Matched after retry.",
      stages: [stage("edgeItem", "matched")],
    }],
    referenceEdges: [{
      sourceItemId: "root-item",
      targetItemId: "dependency-item",
      fieldName: "Related Content",
    }],
    batches: [{
      itemIds: ["dependency-item", "root-item"],
      label: "Power Publish batch 1",
      operationId: "operation-id",
      checkpointStatus: "matched",
      checkpointSummary: "2 items processed.",
      checkpointEvidence: ["Operation completed."],
    }],
    powerEdgeVerification: {
      status: "diverged",
      summary: "One item differs.",
      evidence: ["dependency-item is missing."],
      divergentItemIds: ["dependency-item"],
    },
    stages: [
      stage("authoring", "matched"),
      stage("publishing", "matched"),
      stage("edgeItem", "diverged"),
      stage("edgeLayout", "inconclusive"),
      stage("application", "skipped"),
      stage("browserDom", "pending"),
    ],
    route: "/",
    routeItemId: "root-item",
    siteName: "website",
    applicationUrl: "https://www.example.com/",
    conclusion: "Raw Edge verification diverged.",
    journalPath: "C:/journals/run.json",
    intent,
    ...overrides,
  };
}

function stage(id: TraceStage["id"], status: TraceStage["status"]): TraceStage {
  return {
    id,
    label: id,
    status,
    summary: `${id} summary`,
    evidence: [`${id} evidence`],
    updatedAt: "2026-01-01T00:00:30.000Z",
  };
}
