import { createHash } from "node:crypto";
import type {
  AuthoringItemDetails,
  AuthoringItemField,
  ContentTransferResult,
} from "../sitecore/authoringClient";

export type TransferProcessorState = "paused" | "running" | "pausing";
export type TransferRecordStatus =
  | "queued"
  | "preflighting"
  | "executing"
  | "waitingForSitecore"
  | "verifying"
  | "failed";

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
}

export type TransferRecord = FieldValueTransferRecord | SubtreeTransferRecord;

export type FieldValueTransferDraft = Omit<
  FieldValueTransferRecord,
  keyof TransferRecordBase | "kind"
> & {
  readonly kind: "fieldValue";
  readonly duplicateKey: string;
};

export type SubtreeTransferDraft = Omit<
  SubtreeTransferRecord,
  keyof TransferRecordBase | "kind"
> & {
  readonly kind: "subtree";
  readonly duplicateKey: string;
};

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

function normalizeId(value: string): string {
  return value.replace(/[{}-]/gu, "").toLowerCase();
}

export function isTransferRecord(value: unknown): value is TransferRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<TransferRecord>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.sequence === "number" &&
    typeof candidate.duplicateKey === "string" &&
    typeof candidate.enqueuedAt === "string" &&
    (candidate.kind === "fieldValue" || candidate.kind === "subtree") &&
    [
      "queued",
      "preflighting",
      "executing",
      "waitingForSitecore",
      "verifying",
      "failed",
    ].includes(String(candidate.status))
  );
}
