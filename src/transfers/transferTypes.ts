import { createHash } from "node:crypto";
import type {
  AuthoringItemDetails,
  AuthoringItemField,
  ContentTransferResult,
} from "../sitecore/authoringClient";
import type { DeploymentBaseline } from "../sitecore/deploymentClient";
import {
  isOperationIntent,
  type OperationIntent,
  type SequenceOperationContext,
} from "../operations/operationTypes";

export type TransferProcessorState = "paused" | "running" | "pausing";
export type SubtreeTransferMode = "addMissing" | "synchronize" | "exactMirror";

export interface SubtreeTransferPreflight {
  readonly sourceItems: number;
  readonly targetItems: number;
  readonly addItems: number;
  readonly updateItems: number;
  readonly removeItems: number;
}

export type TransferRecordStatus =
  | "queued"
  | "preflighting"
  | "executing"
  | "waitingForSitecore"
  | "verifying"
  | "failed"
  | "completed";

export interface TransferRefreshPlanEntry {
  readonly itemId: string;
  readonly path: string;
  readonly depth: number;
  readonly loadLevel: boolean;
}

export type SubtreeProgress =
  | { readonly stage: "exportingContent" }
  | { readonly stage: "copyingChunks"; readonly current: number; readonly total: number }
  | {
      readonly stage: "sitecore";
      readonly completed: number;
      readonly total: number;
      readonly startedAt: string;
    }
  | { readonly stage: "verifying" };

interface TransferRecordBase {
  readonly id: string;
  readonly sequence: number;
  readonly duplicateKey: string;
  readonly status: TransferRecordStatus;
  readonly enqueuedAt: string;
  readonly startedAt?: string;
  readonly error?: string;
  readonly journalPath?: string;
  readonly completedAt?: string;
  readonly intent?: OperationIntent;
  readonly sequenceRunId?: string;
  readonly sequenceOperationIndex?: number;
}

export interface FieldTransferEndpoint {
  readonly connectionId: string;
  readonly connectionName: string;
  readonly itemId: string;
  readonly itemPath: string;
  readonly language: string;
  readonly version: number;
  readonly fieldId: string;
  readonly fieldName: string;
  readonly fieldLabel: string;
  readonly fingerprint: string;
}

export interface FieldValueTransferRecord extends TransferRecordBase {
  readonly kind: "fieldValue";
  readonly direction: "leftToRight" | "rightToLeft";
  readonly source: FieldTransferEndpoint;
  readonly target: FieldTransferEndpoint;
}

export interface SubtreeTransferRecord extends TransferRecordBase {
  readonly kind: "subtree";
  readonly mode?: SubtreeTransferMode;
  readonly preflight?: SubtreeTransferPreflight;
  readonly direction: "leftToRight" | "rightToLeft";
  readonly sourceConnectionId: string;
  readonly sourceConnectionName: string;
  readonly targetConnectionId: string;
  readonly targetConnectionName: string;
  readonly sourceItemId: string;
  readonly sourcePath: string;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly comparisonRowKey: string;
  readonly targetSide: "left" | "right";
  readonly targetRefreshPlan: readonly TransferRefreshPlanEntry[];
  readonly checkpoint?: ContentTransferResult;
  readonly progress?: SubtreeProgress;
  readonly deploymentBaselines?: {
    readonly source: DeploymentBaseline;
    readonly target: DeploymentBaseline;
  };
  readonly failureKind?: "deploymentChanged";
}

export type TransferRecord = FieldValueTransferRecord | SubtreeTransferRecord;

export interface PublishingOperationRecord {
  readonly kind: "publishing";
  readonly id: string;
  readonly sequence: number;
  readonly duplicateKey: string;
  readonly status: TransferRecordStatus;
  readonly enqueuedAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly error?: string;
  readonly publishRunId: string;
  readonly publishKind: "standard" | "traced" | "power";
  readonly connectionId: string;
  readonly connectionName: string;
  readonly itemId: string;
  readonly itemPath: string;
  readonly language: string;
  readonly progressSummary?: string;
  readonly intent?: OperationIntent;
  readonly sequenceRunId?: string;
  readonly sequenceOperationIndex?: number;
}

export type OperationRecord = TransferRecord | PublishingOperationRecord;

export interface PublishingOperationDraft {
  readonly kind: "publishing";
  readonly duplicateKey: string;
  readonly publishRunId: string;
  readonly publishKind: PublishingOperationRecord["publishKind"];
  readonly connectionId: string;
  readonly connectionName: string;
  readonly itemId: string;
  readonly itemPath: string;
  readonly language: string;
  readonly intent?: OperationIntent;
  readonly sequenceRunId?: string;
  readonly sequenceOperationIndex?: number;
}

export type FieldValueTransferDraft = Omit<
  FieldValueTransferRecord,
  keyof TransferRecordBase | "kind"
> & {
  readonly kind: "fieldValue";
  readonly duplicateKey: string;
} & Partial<SequenceOperationContext> & { readonly intent?: OperationIntent };

export type SubtreeTransferDraft = Omit<
  SubtreeTransferRecord,
  keyof TransferRecordBase | "kind"
> & {
  readonly kind: "subtree";
  readonly duplicateKey: string;
} & Partial<SequenceOperationContext> & { readonly intent?: OperationIntent };

export type TransferDraft = FieldValueTransferDraft | SubtreeTransferDraft;

export function fieldStateFingerprint(
  details: AuthoringItemDetails,
  field: AuthoringItemField,
): string {
  const context = field.scope === "SHARED"
    ? {}
    : field.scope === "UNVERSIONED"
      ? { language: details.language.toLowerCase() }
      : { language: details.language.toLowerCase(), version: details.version };
  return createHash("sha256").update(JSON.stringify({
    itemId: normalizeId(details.itemId),
    fieldId: normalizeId(field.fieldId),
    fieldName: field.name,
    scope: field.scope,
    value: field.value,
    containsFallbackValue: field.containsFallbackValue,
    containsInheritedValue: field.containsInheritedValue,
    containsStandardValue: field.containsStandardValue,
    ...context,
  })).digest("hex");
}

export function normalizeTransferId(value: string): string {
  return normalizeId(value);
}

export function subtreeTransferMode(
  record: Pick<SubtreeTransferRecord, "mode">,
): SubtreeTransferMode {
  return record.mode ?? "synchronize";
}

export function subtreeTransferModeLabel(mode: SubtreeTransferMode): string {
  switch (mode) {
    case "addMissing": return "Add missing";
    case "synchronize": return "Synchronize";
    case "exactMirror": return "Exact mirror";
  }
}

function normalizeId(value: string): string {
  return value.replace(/[{}-]/gu, "").toLowerCase();
}

export function isTransferRecord(value: unknown): value is TransferRecord {
  if (!isRecord(value) || !isRecordBase(value)) {
    return false;
  }
  if (value.kind === "fieldValue") {
    return (value.direction === "leftToRight" || value.direction === "rightToLeft") &&
      isFieldTransferEndpoint(value.source) &&
      isFieldTransferEndpoint(value.target);
  }
  if (value.kind === "subtree") {
    return (value.mode === undefined || isSubtreeTransferMode(value.mode)) &&
      (value.direction === "leftToRight" || value.direction === "rightToLeft") &&
      typeof value.sourceConnectionId === "string" &&
      typeof value.sourceConnectionName === "string" &&
      typeof value.targetConnectionId === "string" &&
      typeof value.targetConnectionName === "string" &&
      typeof value.sourceItemId === "string" &&
      typeof value.sourcePath === "string" &&
      typeof value.sourceLanguage === "string" &&
      typeof value.targetLanguage === "string" &&
      typeof value.comparisonRowKey === "string" &&
      (value.targetSide === "left" || value.targetSide === "right") &&
      Array.isArray(value.targetRefreshPlan) &&
      value.targetRefreshPlan.every(isTransferRefreshPlanEntry) &&
      (value.preflight === undefined || isSubtreeTransferPreflight(value.preflight)) &&
      (value.checkpoint === undefined || isContentTransferResult(value.checkpoint)) &&
      (value.progress === undefined || isSubtreeProgress(value.progress)) &&
      (value.deploymentBaselines === undefined ||
        isDeploymentBaselines(value.deploymentBaselines)) &&
      (value.failureKind === undefined || value.failureKind === "deploymentChanged");
  }
  return false;
}

export function isOperationRecord(value: unknown): value is OperationRecord {
  if (!isRecord(value)) {
    return false;
  }
  if (value.kind !== "publishing") {
    return isTransferRecord(value);
  }
  return isRecordBase(value) &&
    typeof value.publishRunId === "string" &&
    typeof value.connectionId === "string" &&
    typeof value.connectionName === "string" &&
    typeof value.itemId === "string" &&
    typeof value.itemPath === "string" &&
    typeof value.language === "string" &&
    (value.publishKind === "standard" ||
      value.publishKind === "traced" ||
      value.publishKind === "power") &&
    (value.progressSummary === undefined || typeof value.progressSummary === "string");
}

function isRecordBase(value: Readonly<Record<string, unknown>>): boolean {
  const hasSequenceRunId = value.sequenceRunId !== undefined;
  const hasSequenceOperationIndex = value.sequenceOperationIndex !== undefined;
  return typeof value.id === "string" &&
    isNonNegativeInteger(value.sequence) &&
    typeof value.duplicateKey === "string" &&
    typeof value.enqueuedAt === "string" &&
    isTransferRecordStatus(value.status) &&
    optionalString(value.startedAt) &&
    optionalString(value.completedAt) &&
    optionalString(value.error) &&
    optionalString(value.journalPath) &&
    (
      value.intent === undefined ||
      isOperationIntent(value.intent) && value.intent.kind === value.kind
    ) &&
    hasSequenceRunId === hasSequenceOperationIndex &&
    (!hasSequenceRunId ||
      typeof value.sequenceRunId === "string" &&
      isNonNegativeInteger(value.sequenceOperationIndex));
}

function isFieldTransferEndpoint(value: unknown): value is FieldTransferEndpoint {
  return isRecord(value) &&
    typeof value.connectionId === "string" &&
    typeof value.connectionName === "string" &&
    typeof value.itemId === "string" &&
    typeof value.itemPath === "string" &&
    typeof value.language === "string" &&
    isNonNegativeInteger(value.version) &&
    typeof value.fieldId === "string" &&
    typeof value.fieldName === "string" &&
    typeof value.fieldLabel === "string" &&
    typeof value.fingerprint === "string";
}

function isTransferRefreshPlanEntry(value: unknown): value is TransferRefreshPlanEntry {
  return isRecord(value) &&
    typeof value.itemId === "string" &&
    typeof value.path === "string" &&
    isNonNegativeInteger(value.depth) &&
    typeof value.loadLevel === "boolean";
}

function isSubtreeTransferPreflight(value: unknown): value is SubtreeTransferPreflight {
  return isRecord(value) && [
    value.sourceItems,
    value.targetItems,
    value.addItems,
    value.updateItems,
    value.removeItems,
  ].every(isNonNegativeInteger);
}

function isContentTransferResult(value: unknown): value is ContentTransferResult {
  return isRecord(value) &&
    (value.state === "Finished" || value.state === "Pending") &&
    typeof value.transferId === "string" &&
    typeof value.sourceItemId === "string" &&
    isStringArray(value.sourceChildIds) &&
    Array.isArray(value.chunkSets) &&
    value.chunkSets.every((chunkSet) => isRecord(chunkSet) &&
      typeof chunkSet.chunkSetId === "string" &&
      isNonNegativeInteger(chunkSet.chunkCount) &&
      typeof chunkSet.contentTransferFileName === "string") &&
    isStringArray(value.itemTransferIds) &&
    optionalString(value.destinationItemId) &&
    (value.destinationChildIds === undefined || isStringArray(value.destinationChildIds)) &&
    (value.destinationVersions === undefined ||
      Array.isArray(value.destinationVersions) &&
      value.destinationVersions.every((version) => isRecord(version) &&
        typeof version.language === "string" &&
        isNonNegativeInteger(version.version)));
}

function isSubtreeProgress(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (value.stage === "exportingContent" || value.stage === "verifying") {
    return true;
  }
  if (value.stage === "copyingChunks") {
    return isBoundedProgress(value.current, value.total);
  }
  if (value.stage === "sitecore") {
    const completed = value.completed ?? value.current;
    return isBoundedProgress(completed, value.total) && optionalString(value.startedAt);
  }
  return false;
}

function isBoundedProgress(current: unknown, total: unknown): boolean {
  return isNonNegativeInteger(current) &&
    isNonNegativeInteger(total) &&
    current <= total;
}

function isDeploymentBaselines(value: unknown): boolean {
  return isRecord(value) &&
    isDeploymentBaseline(value.source) &&
    isDeploymentBaseline(value.target);
}

function isDeploymentBaseline(value: unknown): value is DeploymentBaseline {
  return isRecord(value) &&
    typeof value.environmentId === "string" &&
    optionalString(value.deploymentId) &&
    optionalString(value.createdAt) &&
    optionalString(value.startedAt) &&
    optionalString(value.deploymentStartedAt);
}

function isTransferRecordStatus(value: unknown): value is TransferRecordStatus {
  return value === "queued" ||
    value === "preflighting" ||
    value === "executing" ||
    value === "waitingForSitecore" ||
    value === "verifying" ||
    value === "failed" ||
    value === "completed";
}

function isSubtreeTransferMode(value: unknown): value is SubtreeTransferMode {
  return value === "addMissing" || value === "synchronize" || value === "exactMirror";
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
