export const operationDefinitionVersion = 1 as const;

export interface FieldTransferEndpointIntent {
  readonly connectionId: string;
  readonly itemId: string;
  readonly itemPath: string;
  readonly language: string;
  readonly fieldId: string;
  readonly fieldName: string;
  readonly fieldLabel: string;
}

export interface FieldTransferIntent {
  readonly kind: "fieldValue";
  readonly source: FieldTransferEndpointIntent;
  readonly destination: FieldTransferEndpointIntent;
}

export interface SubtreeTransferIntent {
  readonly kind: "subtree";
  readonly source: {
    readonly connectionId: string;
    readonly rootItemId: string;
    readonly rootPath: string;
  };
  readonly destination: {
    readonly connectionId: string;
  };
  readonly mode: "addMissing" | "synchronize" | "exactMirror";
}

export interface PublishingFieldAssertionIntent {
  readonly itemId: string;
  readonly fieldName: string;
  readonly browserSelector?: string;
}

export interface PublishingIntent {
  readonly kind: "publishing";
  readonly publishKind: "standard" | "traced" | "power";
  readonly connectionId: string;
  readonly rootItemId: string;
  readonly rootPath: string;
  readonly language: string;
  readonly publishMode: "SMART" | "FULL";
  readonly publishSubItems: boolean;
  readonly publishRelatedItems: boolean;
  readonly siteName?: string;
  readonly route?: string;
  readonly applicationUrl?: string;
  readonly fieldAssertions?: readonly PublishingFieldAssertionIntent[];
  readonly selectedCollapsedScopeIds?: readonly string[];
  readonly observedCollapsedScopeIds?: readonly string[];
}

export type OperationIntent =
  | FieldTransferIntent
  | SubtreeTransferIntent
  | PublishingIntent;

export interface SavedOperationSequence {
  readonly id: string;
  readonly definitionVersion: typeof operationDefinitionVersion;
  readonly name: string;
  readonly description?: string;
  readonly operations: readonly OperationIntent[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type OperationSequenceRunStatus =
  | "running"
  | "paused"
  | "pausedOnOperation"
  | "pausedByOperations"
  | "completed"
  | "stopped"
  | "failed";

export type SequenceOperationResultStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

export interface SequenceOperationResult {
  readonly index: number;
  readonly status: SequenceOperationResultStatus;
  readonly operationRecordId?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly error?: string;
}

export interface OperationSequenceRun {
  readonly id: string;
  readonly sequenceId: string;
  readonly definitionSnapshot: SavedOperationSequence;
  readonly status: OperationSequenceRunStatus;
  readonly currentOperationIndex: number;
  readonly operationResults: readonly SequenceOperationResult[];
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
  readonly pauseRequested?: boolean;
  readonly stopRequested?: boolean;
  readonly statusDetail?: string;
}

export interface SequenceOperationContext {
  readonly sequenceRunId: string;
  readonly sequenceOperationIndex: number;
}

export function operationIntentLabel(intent: OperationIntent): string {
  switch (intent.kind) {
    case "fieldValue":
      return `Field Transfer - ${intent.source.fieldLabel || intent.source.fieldName}`;
    case "subtree":
      return `Subtree Transfer - ${itemName(intent.source.rootPath)}`;
    case "publishing":
      return `${publishKindLabel(intent.publishKind)} - ${itemName(intent.rootPath)}`;
  }
}

export function defaultSequenceName(intent: OperationIntent): string {
  return operationIntentLabel(intent);
}

export function operationIntentConnectionIds(intent: OperationIntent): readonly string[] {
  switch (intent.kind) {
    case "fieldValue":
      return [intent.source.connectionId, intent.destination.connectionId];
    case "subtree":
      return [intent.source.connectionId, intent.destination.connectionId];
    case "publishing":
      return [intent.connectionId];
  }
}

export function isOperationIntent(value: unknown): value is OperationIntent {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<OperationIntent>;
  if (candidate.kind === "fieldValue") {
    return isFieldEndpoint(candidate.source) && isFieldEndpoint(candidate.destination);
  }
  if (candidate.kind === "subtree") {
    return isRecord(candidate.source) &&
      typeof candidate.source.connectionId === "string" &&
      typeof candidate.source.rootItemId === "string" &&
      typeof candidate.source.rootPath === "string" &&
      isRecord(candidate.destination) &&
      typeof candidate.destination.connectionId === "string" &&
      new Set(["addMissing", "synchronize", "exactMirror"]).has(String(candidate.mode));
  }
  if (candidate.kind === "publishing") {
    return typeof candidate.connectionId === "string" &&
      typeof candidate.rootItemId === "string" &&
      typeof candidate.rootPath === "string" &&
      typeof candidate.language === "string" &&
      new Set(["standard", "traced", "power"]).has(String(candidate.publishKind)) &&
      new Set(["SMART", "FULL"]).has(String(candidate.publishMode)) &&
      typeof candidate.publishSubItems === "boolean" &&
      typeof candidate.publishRelatedItems === "boolean" &&
      optionalString(candidate.siteName) &&
      optionalString(candidate.route) &&
      optionalString(candidate.applicationUrl) &&
      optionalStringArray(candidate.selectedCollapsedScopeIds) &&
      optionalStringArray(candidate.observedCollapsedScopeIds) &&
      (
        candidate.fieldAssertions === undefined ||
        Array.isArray(candidate.fieldAssertions) &&
        candidate.fieldAssertions.every(isPublishingFieldAssertion)
      );
  }
  return false;
}

export function isSavedOperationSequence(value: unknown): value is SavedOperationSequence {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<SavedOperationSequence>;
  return candidate.definitionVersion === operationDefinitionVersion &&
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    optionalString(candidate.description) &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.updatedAt === "string" &&
    Array.isArray(candidate.operations) &&
    candidate.operations.every(isOperationIntent);
}

export function isOperationSequenceRun(value: unknown): value is OperationSequenceRun {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<OperationSequenceRun>;
  if (
    !isSavedOperationSequence(candidate.definitionSnapshot) ||
    !Array.isArray(candidate.operationResults)
  ) {
    return false;
  }
  return typeof candidate.id === "string" &&
    typeof candidate.sequenceId === "string" &&
    typeof candidate.startedAt === "string" &&
    typeof candidate.updatedAt === "string" &&
    typeof candidate.currentOperationIndex === "number" &&
    Number.isInteger(candidate.currentOperationIndex) &&
    candidate.currentOperationIndex >= 0 &&
    candidate.currentOperationIndex <= candidate.definitionSnapshot.operations.length &&
    new Set([
      "running",
      "paused",
      "pausedOnOperation",
      "pausedByOperations",
      "completed",
      "stopped",
      "failed",
    ]).has(String(candidate.status)) &&
    candidate.operationResults.length === candidate.definitionSnapshot.operations.length &&
    candidate.operationResults.every(
      (result, index) => isSequenceOperationResult(result) && result.index === index,
    ) &&
    (candidate.completedAt === undefined || typeof candidate.completedAt === "string") &&
    (candidate.pauseRequested === undefined || typeof candidate.pauseRequested === "boolean") &&
    (candidate.stopRequested === undefined || typeof candidate.stopRequested === "boolean") &&
    (candidate.statusDetail === undefined || typeof candidate.statusDetail === "string");
}

function isSequenceOperationResult(value: unknown): value is SequenceOperationResult {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<SequenceOperationResult>;
  return typeof candidate.index === "number" &&
    Number.isInteger(candidate.index) &&
    candidate.index >= 0 &&
    new Set(["pending", "running", "completed", "failed", "skipped"]).has(
      String(candidate.status),
    ) &&
    (candidate.operationRecordId === undefined ||
      typeof candidate.operationRecordId === "string") &&
    (candidate.startedAt === undefined || typeof candidate.startedAt === "string") &&
    (candidate.completedAt === undefined || typeof candidate.completedAt === "string") &&
    (candidate.error === undefined || typeof candidate.error === "string");
}

function itemName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function isFieldEndpoint(value: unknown): value is FieldTransferEndpointIntent {
  return isRecord(value) &&
    typeof value.connectionId === "string" &&
    typeof value.itemId === "string" &&
    typeof value.itemPath === "string" &&
    typeof value.language === "string" &&
    typeof value.fieldId === "string" &&
    typeof value.fieldName === "string" &&
    typeof value.fieldLabel === "string";
}

function isPublishingFieldAssertion(value: unknown): value is PublishingFieldAssertionIntent {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.itemId === "string" &&
    typeof value.fieldName === "string" &&
    optionalString(value.browserSelector);
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalStringArray(value: unknown): boolean {
  return value === undefined ||
    Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function publishKindLabel(kind: PublishingIntent["publishKind"]): string {
  switch (kind) {
    case "standard": return "Standard publish";
    case "traced": return "Traced publish";
    case "power": return "Power publish";
  }
}
