import type {
  PublishFieldSelection,
  PublishRun,
  PublishSnapshot,
} from "./publishingTypes";

type FieldSelectionContext = Pick<PublishRun, "fieldSelections">;
type PowerFieldSelectionContext = FieldSelectionContext & Pick<PublishRun, "referenceEdges">;

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
