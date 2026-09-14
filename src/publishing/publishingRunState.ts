import { isOperationIntent } from "../operations/operationTypes";
import type {
  PowerPublishEdgeVerification,
  PublishBatch,
  PublishFieldSelection,
  PublishRun,
  PublishSnapshot,
  PublishTraceAttempt,
  PublishingSiteProfile,
  ReferenceEdge,
  TraceStage,
} from "./publishingTypes";

const publishKinds = new Set(["standard", "traced", "power"]);
const publishModes = new Set(["SMART", "FULL"]);
const stageIds = new Set([
  "authoring",
  "publishing",
  "edgeItem",
  "edgeLayout",
  "application",
  "browserDom",
]);
const stageStatuses = new Set([
  "pending",
  "running",
  "matched",
  "inconclusive",
  "diverged",
  "failed",
  "skipped",
]);
const batchStatuses = new Set(["pending", "running", "matched", "diverged"]);
const traceActions = new Set(["verificationRetry", "statusRecheck"]);

export function readPublishRuns(value: unknown): readonly PublishRun[] {
  return Array.isArray(value)
    ? value.filter(isPublishRun).sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt)
      )
    : [];
}

export function readPublishingProfiles(value: unknown): readonly PublishingSiteProfile[] {
  return Array.isArray(value) ? value.filter(isPublishingProfile) : [];
}

export function isPublishRun(value: unknown): value is PublishRun {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.id === "string" &&
    isEnumString(value.kind, publishKinds) &&
    typeof value.connectionId === "string" &&
    typeof value.connectionName === "string" &&
    typeof value.targetHost === "string" &&
    typeof value.rootItemId === "string" &&
    typeof value.rootPath === "string" &&
    typeof value.language === "string" &&
    isEnumString(value.publishMode, publishModes) &&
    typeof value.publishSubItems === "boolean" &&
    typeof value.publishRelatedItems === "boolean" &&
    typeof value.createdAt === "string" &&
    optionalString(value.completedAt) &&
    Array.isArray(value.snapshots) &&
    value.snapshots.every(isPublishSnapshot) &&
    optionalArray(value.fieldSelections, isPublishFieldSelection) &&
    optionalArray(value.retryAttempts, isPublishTraceAttempt) &&
    Array.isArray(value.referenceEdges) &&
    value.referenceEdges.every(isReferenceEdge) &&
    Array.isArray(value.batches) &&
    value.batches.every(isPublishBatch) &&
    optionalValue(value.powerEdgeVerification, isPowerPublishEdgeVerification) &&
    Array.isArray(value.stages) &&
    value.stages.every(isTraceStage) &&
    optionalString(value.route) &&
    optionalString(value.routeItemId) &&
    optionalString(value.siteName) &&
    optionalString(value.applicationUrl) &&
    optionalString(value.conclusion) &&
    optionalString(value.journalPath) &&
    (
      value.intent === undefined ||
      isOperationIntent(value.intent) &&
      value.intent.kind === "publishing" &&
      value.intent.publishKind === value.kind &&
      value.intent.connectionId === value.connectionId
    );
}

export function isPublishingProfile(value: unknown): value is PublishingSiteProfile {
  return isRecord(value) &&
    typeof value.connectionId === "string" &&
    typeof value.edgeEndpoint === "string" &&
    optionalString(value.siteName) &&
    optionalString(value.applicationBaseUrl);
}

function isPublishSnapshot(value: unknown): value is PublishSnapshot {
  return isRecord(value) &&
    typeof value.itemId === "string" &&
    typeof value.path === "string" &&
    typeof value.displayName === "string" &&
    typeof value.language === "string" &&
    isNonNegativeInteger(value.version) &&
    isStringRecord(value.fields) &&
    isStringArray(value.references);
}

function isPublishFieldSelection(value: unknown): value is PublishFieldSelection {
  return isRecord(value) &&
    typeof value.itemId === "string" &&
    typeof value.fieldName === "string" &&
    optionalString(value.browserSelector);
}

function isReferenceEdge(value: unknown): value is ReferenceEdge {
  return isRecord(value) &&
    typeof value.sourceItemId === "string" &&
    typeof value.targetItemId === "string" &&
    typeof value.fieldName === "string";
}

function isTraceStage(value: unknown): value is TraceStage {
  return isRecord(value) &&
    isEnumString(value.id, stageIds) &&
    typeof value.label === "string" &&
    isEnumString(value.status, stageStatuses) &&
    optionalString(value.summary) &&
    optionalStringArray(value.evidence) &&
    optionalString(value.updatedAt);
}

function isPublishTraceAttempt(value: unknown): value is PublishTraceAttempt {
  return isRecord(value) &&
    typeof value.attemptedAt === "string" &&
    isEnumString(value.action, traceActions) &&
    optionalString(value.conclusion) &&
    Array.isArray(value.stages) &&
    value.stages.every(isTraceStage);
}

function isPublishBatch(value: unknown): value is PublishBatch {
  return isRecord(value) &&
    isStringArray(value.itemIds) &&
    typeof value.label === "string" &&
    optionalString(value.operationId) &&
    (value.checkpointStatus === undefined || isEnumString(value.checkpointStatus, batchStatuses)) &&
    optionalString(value.checkpointSummary) &&
    optionalStringArray(value.checkpointEvidence);
}

function isPowerPublishEdgeVerification(
  value: unknown,
): value is PowerPublishEdgeVerification {
  return isRecord(value) &&
    isEnumString(value.status, batchStatuses) &&
    optionalString(value.summary) &&
    optionalStringArray(value.evidence) &&
    optionalStringArray(value.divergentItemIds);
}

function optionalValue<T>(
  value: unknown,
  predicate: (candidate: unknown) => candidate is T,
): value is T | undefined {
  return value === undefined || predicate(value);
}

function optionalArray<T>(
  value: unknown,
  predicate: (candidate: unknown) => candidate is T,
): value is readonly T[] | undefined {
  return value === undefined || Array.isArray(value) && value.every(predicate);
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function optionalStringArray(value: unknown): value is readonly string[] | undefined {
  return value === undefined || isStringArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isEnumString(value: unknown, allowed: ReadonlySet<string>): value is string {
  return typeof value === "string" && allowed.has(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
