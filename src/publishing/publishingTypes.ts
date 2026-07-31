export type PublishKind = "standard" | "traced" | "power";
export type PublishMode = "SMART" | "FULL";
export type TraceStageStatus =
  | "pending"
  | "running"
  | "matched"
  | "inconclusive"
  | "diverged"
  | "failed"
  | "skipped";

export interface PublishTarget {
  readonly connectionId: string;
  readonly side: "left" | "right";
  readonly itemId: string;
  readonly path: string;
  readonly language: string;
}

export interface PublishSnapshot {
  readonly itemId: string;
  readonly path: string;
  readonly displayName: string;
  readonly language: string;
  readonly version: number;
  readonly fields: Readonly<Record<string, string>>;
  readonly references: readonly string[];
}

export interface PublishFieldSelection {
  readonly itemId: string;
  readonly fieldName: string;
  readonly browserSelector?: string;
}

export interface ReferenceEdge {
  readonly sourceItemId: string;
  readonly targetItemId: string;
  readonly fieldName: string;
}

export interface TraceStage {
  readonly id:
    | "authoring"
    | "publishing"
    | "edgeItem"
    | "edgeLayout"
    | "application"
    | "browserDom";
  readonly label: string;
  readonly status: TraceStageStatus;
  readonly summary?: string;
  readonly evidence?: readonly string[];
  readonly updatedAt?: string;
}

export interface PublishTraceAttempt {
  readonly attemptedAt: string;
  readonly action: "verificationRetry" | "statusRecheck";
  readonly conclusion?: string;
  readonly stages: readonly TraceStage[];
}

export interface PublishBatch {
  readonly itemIds: readonly string[];
  readonly label: string;
  readonly operationId?: string;
  readonly checkpointStatus?: "pending" | "running" | "matched" | "diverged";
  readonly checkpointSummary?: string;
  readonly checkpointEvidence?: readonly string[];
}

export interface PowerPublishEdgeVerification {
  readonly status: "pending" | "running" | "matched" | "diverged";
  readonly summary?: string;
  readonly evidence?: readonly string[];
  /** Item IDs that remained missing or had at least one mismatched checked field. */
  readonly divergentItemIds?: readonly string[];
}

export interface PublishRun {
  readonly id: string;
  readonly kind: PublishKind;
  readonly connectionId: string;
  readonly connectionName: string;
  readonly targetHost: string;
  readonly rootItemId: string;
  readonly rootPath: string;
  readonly language: string;
  readonly publishMode: PublishMode;
  readonly publishSubItems: boolean;
  readonly publishRelatedItems: boolean;
  readonly createdAt: string;
  readonly completedAt?: string;
  readonly snapshots: readonly PublishSnapshot[];
  readonly fieldSelections?: readonly PublishFieldSelection[];
  readonly retryAttempts?: readonly PublishTraceAttempt[];
  readonly referenceEdges: readonly ReferenceEdge[];
  readonly batches: readonly PublishBatch[];
  readonly powerEdgeVerification?: PowerPublishEdgeVerification;
  readonly stages: readonly TraceStage[];
  readonly route?: string;
  readonly routeItemId?: string;
  readonly siteName?: string;
  readonly applicationUrl?: string;
  readonly conclusion?: string;
  readonly journalPath?: string;
  readonly intent?: PublishingIntent;
}

export interface PublishingSiteProfile {
  readonly connectionId: string;
  readonly edgeEndpoint: string;
  readonly siteName?: string;
  readonly applicationBaseUrl?: string;
}
import type { PublishingIntent } from "../operations/operationTypes";
