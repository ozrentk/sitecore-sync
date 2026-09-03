import type {
  PublishRun,
  PublishSnapshot,
  ReferenceEdge,
  TraceStageStatus,
} from "./publishingTypes";
import {
  expectedFieldsForSnapshot,
  formatFieldValue,
} from "./publishingVerification";

type RenderedLayoutContext = Pick<
  PublishRun,
  "rootItemId" | "snapshots" | "fieldSelections" | "referenceEdges"
>;

export interface RenderedLayoutData {
  readonly itemId?: string;
  readonly rendered: string;
}

export interface RenderedSnapshotInspection {
  readonly path: string;
  readonly itemId: string;
  readonly found: boolean;
  readonly fieldMismatches: readonly string[];
  readonly fieldMatches: readonly string[];
}

export interface RenderedReferenceInspection {
  readonly sourceFound: boolean;
  readonly targetFound: boolean;
}

export interface RenderedLayoutVerificationOutcome {
  readonly status: Extract<TraceStageStatus, "matched" | "diverged">;
  readonly summary: string;
  readonly evidence: readonly string[];
}

export function evaluateRenderedLayout(
  context: RenderedLayoutContext,
  layout: RenderedLayoutData,
  expectedRouteItemId?: string,
): RenderedLayoutVerificationOutcome {
  const selectedFieldCount = context.fieldSelections?.length ?? 0;
  const snapshotsToInspect = selectedFieldCount
    ? context.snapshots.filter((snapshot) =>
        expectedFieldsForSnapshot(context, snapshot).length > 0
      )
    : context.snapshots;
  const layoutEvidence = snapshotsToInspect.map((snapshot) => {
    const selectedFieldNames = selectedFieldCount
      ? expectedFieldsForSnapshot(context, snapshot).map(([name]) => name)
      : undefined;
    if (
      !selectedFieldNames &&
      sameId(snapshot.itemId, context.rootItemId) &&
      layout.itemId &&
      sameId(layout.itemId, snapshot.itemId)
    ) {
      return matchedRootInspection(snapshot);
    }
    return inspectRenderedSnapshot(layout.rendered, snapshot, selectedFieldNames);
  });
  const missingIds = layoutEvidence
    .filter((evidence) => !evidence.found)
    .map((evidence) =>
      `${evidence.path}: item ${evidence.itemId} was not exposed in rendered data`
    );
  const fieldMismatches = layoutEvidence.flatMap((evidence) => evidence.fieldMismatches);
  const fieldMatches = layoutEvidence.flatMap((evidence) => evidence.fieldMatches);
  const rootMismatch = !layout.itemId
    ? ["Rendered layout did not identify its route item."]
    : expectedRouteItemId && !sameId(layout.itemId, expectedRouteItemId)
      ? [`Route resolved to ${layout.itemId}, expected pre-publish route item ${expectedRouteItemId}`]
      : [];
  const referenceMismatches = context.referenceEdges.flatMap((edge) => {
    const inspection = inspectRenderedReference(layout.rendered, edge);
    return inspection.sourceFound && !inspection.targetFound
      ? [`${shortId(edge.sourceItemId)} did not reference ${shortId(edge.targetItemId)} through ${edge.fieldName}`]
      : [];
  });
  const divergences = [
    ...rootMismatch,
    ...fieldMismatches,
    ...referenceMismatches,
    ...(selectedFieldCount ? missingIds : []),
  ];
  return {
    status: divergences.length ? "diverged" : "matched",
    summary: divergences.length
      ? selectedFieldCount
        ? "The rendered layout did not expose every selected field value."
        : "The rendered layout did not match every observed item and scoped field value."
      : selectedFieldCount
        ? `${selectedFieldCount} selected field value(s) matched in the rendered layout.`
        : "The rendered route identity and observable reference chains matched.",
    evidence: [
      ...divergences,
      ...fieldMatches,
      ...(selectedFieldCount ? [] : missingIds),
    ],
  };
}

export function inspectRenderedSnapshot(
  rendered: string,
  snapshot: PublishSnapshot,
  selectedFieldNames?: readonly string[],
): RenderedSnapshotInspection {
  let root: unknown;
  try {
    root = JSON.parse(rendered) as unknown;
  } catch {
    const found = normalizeId(rendered).includes(normalizeId(snapshot.itemId));
    return {
      path: snapshot.path,
      itemId: snapshot.itemId,
      found,
      fieldMismatches: selectedFieldNames?.map((name) =>
        `${snapshot.path} › ${name}: rendered layout data could not be inspected`
      ) ?? [],
      fieldMatches: [],
    };
  }
  const candidates: unknown[] = [];
  walkObjects(root, (value) => {
    if (Object.values(value).some((candidate) =>
      typeof candidate === "string" && sameId(candidate, snapshot.itemId)
    )) {
      candidates.push(value);
    }
  });
  if (!candidates.length) {
    return {
      path: snapshot.path,
      itemId: snapshot.itemId,
      found: false,
      fieldMismatches: [],
      fieldMatches: [],
    };
  }
  const actualFields = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    collectNamedFieldValues(candidate, actualFields);
  }
  const expectedFields = selectedFieldNames
    ? selectedFieldNames.map((name) => [name, snapshot.fields[name]] as const)
    : Object.entries(snapshot.fields).filter(([name]) => actualFields.has(name));
  const fieldMismatches: string[] = [];
  const fieldMatches: string[] = [];
  for (const [name, expected] of expectedFields) {
    const expectedValue = expected ?? "";
    const observedValues = actualFields.get(name);
    if (!observedValues?.size) {
      fieldMismatches.push(
        `${snapshot.path} › ${name}: not observable in rendered layout; expected ${formatFieldValue(expectedValue)}`,
      );
    } else if (!observedValues.has(expectedValue)) {
      const renderedValues = [...observedValues].map(formatFieldValue).join(", ");
      fieldMismatches.push(
        `${snapshot.path} › ${name}: expected ${formatFieldValue(expectedValue)}, ` +
        `rendered layout exposed ${renderedValues} across ${candidates.length} matching object(s)`,
      );
    } else if (selectedFieldNames) {
      const observation = observedValues.size > 1
        ? ` matched among ${observedValues.size} observed values`
        : " matched";
      fieldMatches.push(
        `${snapshot.path} › ${name}: ${formatFieldValue(expectedValue)}${observation} ` +
        `across ${candidates.length} matching object(s)`,
      );
    }
  }
  return {
    path: snapshot.path,
    itemId: snapshot.itemId,
    found: true,
    fieldMismatches,
    fieldMatches,
  };
}

export function inspectRenderedReference(
  rendered: string,
  edge: ReferenceEdge,
): RenderedReferenceInspection {
  let root: unknown;
  try {
    root = JSON.parse(rendered) as unknown;
  } catch {
    return { sourceFound: false, targetFound: false };
  }
  const sourceCandidates: Readonly<Record<string, unknown>>[] = [];
  walkObjects(root, (value) => {
    if (Object.values(value).some((candidate) =>
      typeof candidate === "string" && sameId(candidate, edge.sourceItemId)
    )) {
      sourceCandidates.push(value);
    }
  });
  return {
    sourceFound: sourceCandidates.length > 0,
    targetFound: sourceCandidates.some((candidate) =>
      normalizeId(JSON.stringify(candidate)).includes(normalizeId(edge.targetItemId))
    ),
  };
}

function matchedRootInspection(snapshot: PublishSnapshot): RenderedSnapshotInspection {
  return {
    path: snapshot.path,
    itemId: snapshot.itemId,
    found: true,
    fieldMismatches: [],
    fieldMatches: [],
  };
}

function walkObjects(
  value: unknown,
  visitor: (value: Readonly<Record<string, unknown>>) => void,
): void {
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      walkObjects(entry, visitor);
    }
    return;
  }
  const record = value as Readonly<Record<string, unknown>>;
  visitor(record);
  for (const entry of Object.values(record)) {
    walkObjects(entry, visitor);
  }
}

function collectNamedFieldValues(
  value: unknown,
  target: Map<string, Set<string>>,
): void {
  const add = (name: string, fieldValue: string): void => {
    const values = target.get(name) ?? new Set<string>();
    values.add(fieldValue);
    target.set(name, values);
  };
  walkObjects(value, (record) => {
    if (typeof record.name === "string" && typeof record.value === "string") {
      add(record.name, record.value);
    }
    const fields = record.fields;
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
      return;
    }
    for (const [name, field] of Object.entries(fields)) {
      if (typeof field === "string") {
        add(name, field);
      } else if (
        field &&
        typeof field === "object" &&
        !Array.isArray(field) &&
        typeof (field as Readonly<Record<string, unknown>>).value === "string"
      ) {
        add(name, (field as Readonly<Record<string, string>>).value);
      }
    }
  });
}

function sameId(left: string, right: string): boolean {
  return normalizeId(left) === normalizeId(right);
}

function normalizeId(value: string): string {
  return value.replace(/[{}-]/gu, "").toLowerCase();
}

function shortId(value: string): string {
  return value.replace(/[{}]/gu, "").slice(0, 8);
}
