import type {
  PublishFieldSelection,
  PublishRun,
  PublishSnapshot,
} from "./publishingTypes";

type FieldSelectionContext = Pick<PublishRun, "fieldSelections">;
type PowerFieldSelectionContext = FieldSelectionContext & Pick<PublishRun, "referenceEdges">;

export interface EdgeItemObservation {
  readonly evidence: readonly string[];
  readonly divergences: readonly string[];
  readonly divergentItemId?: string;
}

export interface RawEdgeItem {
  readonly id: string;
  readonly fields: Readonly<Record<string, string>>;
}

export interface PowerEdgeObservationSummary {
  readonly matchedCount: number;
  readonly divergentItemIds: readonly string[];
  readonly evidence: readonly string[];
  readonly divergences: readonly string[];
}

export function expectedFieldsForSnapshot(
  context: FieldSelectionContext,
  snapshot: PublishSnapshot,
): readonly (readonly [string, string])[] {
  if (!context.fieldSelections?.length) {
    return Object.entries(snapshot.fields).filter(([, expected]) => expected.length > 0);
  }
  return selectionsForSnapshot(context.fieldSelections, snapshot)
    .map((field) => [field.fieldName, snapshot.fields[field.fieldName] ?? ""] as const);
}

export function powerExpectedFieldsForSnapshot(
  context: PowerFieldSelectionContext,
  snapshot: PublishSnapshot,
): readonly (readonly [string, string | undefined])[] {
  const fieldNames = new Set([
    ...selectionsForSnapshot(context.fieldSelections ?? [], snapshot)
      .map((selection) => selection.fieldName),
    ...context.referenceEdges
      .filter((edge) => sameId(edge.sourceItemId, snapshot.itemId))
      .map((edge) => edge.fieldName),
  ]);
  return [...fieldNames].map((fieldName) => [fieldName, snapshot.fields[fieldName]] as const);
}

export function inspectTracedEdgeItem(
  snapshot: PublishSnapshot,
  item: RawEdgeItem | undefined,
  expectedFields: readonly (readonly [string, string])[],
  includeMatchEvidence: boolean,
): EdgeItemObservation {
  if (!item || !sameId(item.id, snapshot.itemId)) {
    return missingItemObservation(snapshot);
  }
  const evidence: string[] = [];
  const divergences: string[] = [];
  for (const [fieldName, expected] of expectedFields) {
    const actual = item.fields[fieldName];
    if (actual !== expected) {
      divergences.push(
        `${snapshot.path} › ${fieldName}: expected ${formatFieldValue(expected)}, Edge returned ${
          actual === undefined ? "missing" : formatFieldValue(actual)
        }`,
      );
    } else if (includeMatchEvidence) {
      evidence.push(
        `${snapshot.path} › ${fieldName}: ${formatFieldValue(expected)} matched`,
      );
    }
  }
  return {
    evidence,
    divergences,
    divergentItemId: divergences.length ? snapshot.itemId : undefined,
  };
}

export function inspectPowerEdgeItem(
  snapshot: PublishSnapshot,
  item: RawEdgeItem | undefined,
  expectedFields: readonly (readonly [string, string | undefined])[],
): EdgeItemObservation {
  if (!item || !sameId(item.id, snapshot.itemId)) {
    return missingItemObservation(snapshot);
  }
  const evidence: string[] = [];
  const divergences: string[] = [];
  for (const [fieldName, expected] of expectedFields) {
    const actual = item.fields[fieldName];
    if (expected === undefined || actual !== expected) {
      divergences.push(
        `${snapshot.path} › ${fieldName}: expected ${
          expected === undefined ? "missing authoring value" : formatFieldValue(expected)
        }, Edge returned ${
          actual === undefined ? "missing" : formatFieldValue(actual)
        }`,
      );
    } else {
      evidence.push(`${snapshot.path} › ${fieldName}: matched`);
    }
  }
  if (!expectedFields.length) {
    evidence.push(`${snapshot.path}: item identity matched`);
  }
  return {
    evidence,
    divergences,
    divergentItemId: divergences.length ? snapshot.itemId : undefined,
  };
}

export function summarizePowerEdgeObservations(
  snapshots: readonly PublishSnapshot[],
  observations: ReadonlyMap<string, EdgeItemObservation>,
): PowerEdgeObservationSummary {
  const orderedObservations = snapshots.flatMap((snapshot) => {
    const observation = observations.get(normalizeId(snapshot.itemId));
    return observation ? [observation] : [];
  });
  return {
    matchedCount: orderedObservations.filter((observation) =>
      !observation.divergentItemId
    ).length,
    divergentItemIds: snapshots.flatMap((snapshot) =>
      observations.get(normalizeId(snapshot.itemId))?.divergentItemId
        ? [snapshot.itemId]
        : []
    ),
    evidence: orderedObservations.flatMap((observation) => observation.evidence),
    divergences: orderedObservations.flatMap((observation) => observation.divergences),
  };
}

export function deduplicateSnapshots(
  snapshots: readonly PublishSnapshot[],
): readonly PublishSnapshot[] {
  return deduplicateById(snapshots, (snapshot) => snapshot.itemId);
}

export function deduplicateIds(ids: readonly string[]): readonly string[] {
  return deduplicateById(ids, (id) => id);
}

export function versionlessSnapshotEvidence(
  snapshots: readonly PublishSnapshot[],
  language: string,
): readonly string[] {
  return snapshots
    .filter((snapshot) => snapshot.version <= 0)
    .map((snapshot) =>
      `${snapshot.path}: skipped Raw Experience Edge identity verification because Authoring reported no ${language} language version (version 0).`
    );
}

export function formatFieldValue(value: string): string {
  return JSON.stringify(
    value.length > 160 ? `${value.slice(0, 157)}…` : value,
  );
}

function missingItemObservation(snapshot: PublishSnapshot): EdgeItemObservation {
  return {
    evidence: [],
    divergences: [`${snapshot.path}: item not found`],
    divergentItemId: snapshot.itemId,
  };
}

function selectionsForSnapshot(
  selections: readonly PublishFieldSelection[],
  snapshot: PublishSnapshot,
): readonly PublishFieldSelection[] {
  return selections.filter((selection) => sameId(selection.itemId, snapshot.itemId));
}

function deduplicateById<T>(
  values: readonly T[],
  id: (value: T) => string,
): readonly T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = normalizeId(id(value));
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function sameId(left: string, right: string): boolean {
  return normalizeId(left) === normalizeId(right);
}

function normalizeId(value: string): string {
  return value.replace(/[{}-]/gu, "").toLowerCase();
}
