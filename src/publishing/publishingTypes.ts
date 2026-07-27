export type PublishKind = "standard" | "traced" | "power";
export type PublishMode = "SMART" | "FULL";
export type TraceStageStatus =
  | "pending"
  | "running"
  | "matched"
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

export interface ReferenceEdge {
  readonly sourceItemId: string;
  readonly targetItemId: string;
  readonly fieldName: string;
}

export interface TraceStage {
  readonly id: "authoring" | "publishing" | "edgeItem" | "edgeLayout" | "application";
  readonly label: string;
  readonly status: TraceStageStatus;
  readonly summary?: string;
  readonly evidence?: readonly string[];
  readonly updatedAt?: string;
}

export interface PublishBatch {
  readonly itemIds: readonly string[];
  readonly label: string;
  readonly operationId?: string;
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
  readonly referenceEdges: readonly ReferenceEdge[];
  readonly batches: readonly PublishBatch[];
  readonly stages: readonly TraceStage[];
  readonly route?: string;
  readonly routeItemId?: string;
  readonly siteName?: string;
  readonly applicationUrl?: string;
  readonly conclusion?: string;
  readonly journalPath?: string;
}

export interface PublishingSiteProfile {
  readonly connectionId: string;
  readonly edgeEndpoint: string;
  readonly siteName?: string;
  readonly applicationBaseUrl?: string;
}
