import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import {
  diagnosticStageIds,
  finishRetryWithFailure,
  prepareDiagnosticRetry,
  prepareStatusRecheck,
} from "../../src/publishing/publishingRunTransitions";
import type {
  PublishRun,
  PublishTraceAttempt,
  TraceStage,
} from "../../src/publishing/publishingTypes";

const transitionTime = "2026-03-01T10:00:00.000Z";

test("diagnostic retry archives the completed trace and resets from the failed stage", () => {
  const original = publishRun({
    route: undefined,
    siteName: undefined,
    applicationUrl: undefined,
    fieldSelections: undefined,
  });

  const retried = prepareDiagnosticRetry(original, "edgeItem", transitionTime);

  strictEqual(retried.completedAt, undefined);
  strictEqual(retried.conclusion, undefined);
  strictEqual(retried.journalPath, undefined);
  deepStrictEqual(retried.batches, original.batches);
  strictEqual(retried.retryAttempts?.length, 1);
  deepStrictEqual(retried.retryAttempts?.[0], {
    attemptedAt: transitionTime,
    action: "verificationRetry",
    conclusion: original.conclusion,
    stages: original.stages,
  });
  deepStrictEqual(stageState(retried, "authoring"), stageState(original, "authoring"));
  deepStrictEqual(stageState(retried, "publishing"), stageState(original, "publishing"));
  deepStrictEqual(stageState(retried, "edgeItem"), {
    status: "pending",
    summary: "Queued for verification retry.",
    evidence: undefined,
    updatedAt: transitionTime,
  });
  deepStrictEqual(stageState(retried, "edgeLayout"), {
    status: "skipped",
    summary: "Route or Sitecore site name was not configured.",
    evidence: undefined,
    updatedAt: transitionTime,
  });
  deepStrictEqual(stageState(retried, "application"), {
    status: "skipped",
    summary: "Application response verification was not configured.",
    evidence: undefined,
    updatedAt: transitionTime,
  });
  deepStrictEqual(stageState(retried, "browserDom"), {
    status: "skipped",
    summary: "No Browser DOM selectors were configured.",
    evidence: undefined,
    updatedAt: transitionTime,
  });
  strictEqual(original.completedAt, "2026-02-01T00:01:00.000Z");
  strictEqual(original.retryAttempts, undefined);
});

test("diagnostic retry preserves earlier stages and resets configured later stages", () => {
  const original = publishRun();

  const retried = prepareDiagnosticRetry(original, "application", transitionTime);

  deepStrictEqual(stageState(retried, "edgeItem"), stageState(original, "edgeItem"));
  deepStrictEqual(stageState(retried, "edgeLayout"), stageState(original, "edgeLayout"));
  deepStrictEqual(stageState(retried, "application"), {
    status: "pending",
    summary: "Queued for verification retry.",
    evidence: undefined,
    updatedAt: transitionTime,
  });
  deepStrictEqual(stageState(retried, "browserDom"), {
    status: "pending",
    summary: "Queued for verification retry.",
    evidence: undefined,
    updatedAt: transitionTime,
  });
});

test("status recheck restarts publishing and skips diagnostics for Standard publish", () => {
  const original = publishRun({ kind: "standard", fieldSelections: undefined });

  const rechecked = prepareStatusRecheck(original, transitionTime);

  strictEqual(rechecked.completedAt, undefined);
  strictEqual(rechecked.conclusion, undefined);
  strictEqual(rechecked.journalPath, undefined);
  deepStrictEqual(stageState(rechecked, "authoring"), stageState(original, "authoring"));
  deepStrictEqual(stageState(rechecked, "publishing"), {
    status: "running",
    summary: "Checking saved XM Cloud publishing operation IDs.",
    evidence: undefined,
    updatedAt: transitionTime,
  });
  for (const stageId of diagnosticStageIds) {
    deepStrictEqual(stageState(rechecked, stageId), {
      status: "skipped",
      summary: "Not requested for Standard publish.",
      evidence: undefined,
      updatedAt: transitionTime,
    });
  }
  strictEqual(rechecked.retryAttempts?.at(-1)?.action, "statusRecheck");
});

test("status recheck queues configured diagnostics and keeps unavailable checks skipped", () => {
  const original = publishRun({
    applicationUrl: undefined,
    fieldSelections: [{ itemId: "root-item", fieldName: "Title" }],
  });

  const rechecked = prepareStatusRecheck(original, transitionTime);

  for (const stageId of ["edgeItem", "edgeLayout"] as const) {
    deepStrictEqual(stageState(rechecked, stageId), {
      status: "pending",
      summary: "Waiting for publishing status re-check.",
      evidence: undefined,
      updatedAt: transitionTime,
    });
  }
  deepStrictEqual(stageState(rechecked, "application"), {
    status: "skipped",
    summary: "Application response verification was not configured.",
    evidence: undefined,
    updatedAt: transitionTime,
  });
  deepStrictEqual(stageState(rechecked, "browserDom"), {
    status: "skipped",
    summary: "No Browser DOM selectors were configured.",
    evidence: undefined,
    updatedAt: transitionTime,
  });
});

test("retry history retains only the ten most recent attempts", () => {
  const attempts = Array.from({ length: 10 }, (_entry, index): PublishTraceAttempt => ({
    attemptedAt: `2026-02-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
    action: "verificationRetry",
    stages: [],
  }));
  const original = publishRun({ retryAttempts: attempts });

  const rechecked = prepareStatusRecheck(original, transitionTime);

  strictEqual(rechecked.retryAttempts?.length, 10);
  strictEqual(rechecked.retryAttempts?.[0]?.attemptedAt, attempts[1]?.attemptedAt);
  strictEqual(rechecked.retryAttempts?.at(-1)?.attemptedAt, transitionTime);
  strictEqual(original.retryAttempts?.length, 10);
});

test("retry failure completes the run and fails only running stages", () => {
  const original = publishRun({
    completedAt: undefined,
    conclusion: undefined,
    stages: [
      stage("authoring", "matched"),
      stage("publishing", "running"),
      stage("edgeItem", "running"),
      stage("application", "pending"),
    ],
  });

  const failed = finishRetryWithFailure(
    original,
    "Publish status check failed",
    "The status endpoint timed out.",
    transitionTime,
  );

  strictEqual(failed.completedAt, transitionTime);
  strictEqual(
    failed.conclusion,
    "Publish status check failed: The status endpoint timed out.",
  );
  deepStrictEqual(stageState(failed, "publishing"), {
    status: "failed",
    summary: "The status endpoint timed out.",
    evidence: ["publishing evidence"],
    updatedAt: transitionTime,
  });
  deepStrictEqual(stageState(failed, "edgeItem"), {
    status: "failed",
    summary: "The status endpoint timed out.",
    evidence: ["edgeItem evidence"],
    updatedAt: transitionTime,
  });
  deepStrictEqual(stageState(failed, "authoring"), stageState(original, "authoring"));
  deepStrictEqual(stageState(failed, "application"), stageState(original, "application"));
  strictEqual(original.completedAt, undefined);
  strictEqual(original.stages[1]?.status, "running");
});

function publishRun(overrides: Partial<PublishRun> = {}): PublishRun {
  return {
    id: "run-id",
    kind: "traced",
    connectionId: "connection-id",
    connectionName: "Production",
    targetHost: "production.example.com",
    rootItemId: "root-item",
    rootPath: "/sitecore/content/Home",
    language: "en",
    publishMode: "SMART",
    publishSubItems: true,
    publishRelatedItems: true,
    createdAt: "2026-02-01T00:00:00.000Z",
    completedAt: "2026-02-01T00:01:00.000Z",
    snapshots: [],
    fieldSelections: [{
      itemId: "root-item",
      fieldName: "Title",
      browserSelector: "h1",
    }],
    referenceEdges: [],
    batches: [{
      itemIds: ["root-item"],
      label: "Publish root",
      operationId: "operation-id",
      checkpointStatus: "matched",
    }],
    stages: [
      stage("authoring", "matched"),
      stage("publishing", "matched"),
      stage("edgeItem", "diverged"),
      stage("edgeLayout", "failed"),
      stage("application", "inconclusive"),
      stage("browserDom", "failed"),
    ],
    route: "/",
    siteName: "website",
    applicationUrl: "https://www.example.com/",
    conclusion: "Verification diverged.",
    journalPath: "C:/journals/run.json",
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
    updatedAt: "2026-02-01T00:01:00.000Z",
  };
}

function stageState(run: PublishRun, id: TraceStage["id"]): {
  readonly status: TraceStage["status"];
  readonly summary: string | undefined;
  readonly evidence: readonly string[] | undefined;
  readonly updatedAt: string | undefined;
} {
  const value = run.stages.find((candidate) => candidate.id === id);
  if (!value) {
    throw new Error(`Missing stage ${id}.`);
  }
  return {
    status: value.status,
    summary: value.summary,
    evidence: value.evidence,
    updatedAt: value.updatedAt,
  };
}
