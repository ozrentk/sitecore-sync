import { deepStrictEqual } from "node:assert/strict";
import { test } from "node:test";
import {
  deduplicateIds,
  deduplicateSnapshots,
  expectedFieldsForSnapshot,
  inspectPowerEdgeItem,
  inspectTracedEdgeItem,
  powerExpectedFieldsForSnapshot,
  summarizePowerEdgeObservations,
  versionlessSnapshotEvidence,
  type EdgeItemObservation,
  type RawEdgeItem,
} from "../../src/publishing/publishingVerification";
import type {
  PublishFieldSelection,
  PublishSnapshot,
  ReferenceEdge,
} from "../../src/publishing/publishingTypes";

test("publishing expectations include every populated snapshot field by default", () => {
  const snapshot = publishSnapshot({
    fields: {
      Title: "Welcome",
      Empty: "",
      Whitespace: " ",
    },
  });

  deepStrictEqual(expectedFieldsForSnapshot({}, snapshot), [
    ["Title", "Welcome"],
    ["Whitespace", " "],
  ]);
});

test("publishing expectations use normalized item ownership and preserve missing selections", () => {
  const fieldSelections: readonly PublishFieldSelection[] = [
    { itemId: "{ABC-DEF}", fieldName: "Title" },
    { itemId: "abcdef", fieldName: "Missing" },
    { itemId: "other", fieldName: "Ignored" },
  ];

  deepStrictEqual(
    expectedFieldsForSnapshot({ fieldSelections }, publishSnapshot()),
    [
      ["Title", "Welcome"],
      ["Missing", ""],
    ],
  );
});

test("Power expectations combine selected and reference fields without duplicates", () => {
  const fieldSelections: readonly PublishFieldSelection[] = [
    { itemId: "ABCDEF", fieldName: "Title" },
    { itemId: "other", fieldName: "Ignored" },
  ];
  const referenceEdges: readonly ReferenceEdge[] = [
    edge("{ABC-DEF}", "target-1", "Title"),
    edge("abcdef", "target-2", "Related"),
    edge("ABCDEF", "target-3", "MissingReference"),
    edge("other", "target-4", "IgnoredReference"),
  ];

  deepStrictEqual(
    powerExpectedFieldsForSnapshot(
      { fieldSelections, referenceEdges },
      publishSnapshot({ fields: { Title: "Welcome", Related: "{TARGET-2}" } }),
    ),
    [
      ["Title", "Welcome"],
      ["Related", "{TARGET-2}"],
      ["MissingReference", undefined],
    ],
  );
});

test("publishing verification deduplicates normalized IDs while preserving first values", () => {
  const first = publishSnapshot({ itemId: "{ABC-DEF}", path: "/first" });
  const duplicate = publishSnapshot({ itemId: "abcdef", path: "/duplicate" });
  const second = publishSnapshot({ itemId: "SECOND", path: "/second" });

  deepStrictEqual(deduplicateSnapshots([first, duplicate, second]), [first, second]);
  deepStrictEqual(
    deduplicateIds(["{ABC-DEF}", "abcdef", "SECOND", "{S-E-C-O-N-D}"]),
    ["{ABC-DEF}", "SECOND"],
  );
});

test("publishing verification records only non-observable version-zero snapshots", () => {
  const snapshots = [
    publishSnapshot({ path: "/zero", version: 0 }),
    publishSnapshot({ itemId: "negative", path: "/negative", version: -1 }),
    publishSnapshot({ itemId: "observable", path: "/observable", version: 1 }),
  ];

  deepStrictEqual(versionlessSnapshotEvidence(snapshots, "en"), [
    "/zero: skipped Raw Experience Edge identity verification because Authoring reported no en language version (version 0).",
    "/negative: skipped Raw Experience Edge identity verification because Authoring reported no en language version (version 0).",
  ]);
});

test("traced Edge inspection rejects missing and mismatched item identities", () => {
  const snapshot = publishSnapshot();
  const expected = [["Title", "Welcome"]] as const;
  const missing = {
    evidence: [],
    divergences: ["/sitecore/content/Home: item not found"],
    divergentItemId: "{ABC-DEF}",
  };

  deepStrictEqual(inspectTracedEdgeItem(snapshot, undefined, expected, true), missing);
  deepStrictEqual(
    inspectTracedEdgeItem(snapshot, edgeItem({ id: "other" }), expected, true),
    missing,
  );
});

test("traced Edge inspection reports selected matches and every field divergence", () => {
  const snapshot = publishSnapshot();
  const expected = [
    ["Title", "Welcome"],
    ["Summary", "Expected summary"],
    ["Missing", ""],
  ] as const;

  deepStrictEqual(
    inspectTracedEdgeItem(
      snapshot,
      edgeItem({ fields: { Title: "Welcome", Summary: "Different" } }),
      expected,
      true,
    ),
    {
      evidence: ["/sitecore/content/Home › Title: \"Welcome\" matched"],
      divergences: [
        "/sitecore/content/Home › Summary: expected \"Expected summary\", Edge returned \"Different\"",
        "/sitecore/content/Home › Missing: expected \"\", Edge returned missing",
      ],
      divergentItemId: "{ABC-DEF}",
    },
  );
  deepStrictEqual(
    inspectTracedEdgeItem(
      snapshot,
      edgeItem({ fields: { Title: "Welcome" } }),
      [["Title", "Welcome"]],
      false,
    ).evidence,
    [],
  );
});

test("Power Edge inspection validates identity and records identity-only matches", () => {
  const snapshot = publishSnapshot();
  deepStrictEqual(
    inspectPowerEdgeItem(snapshot, undefined, []),
    {
      evidence: [],
      divergences: ["/sitecore/content/Home: item not found"],
      divergentItemId: "{ABC-DEF}",
    },
  );
  deepStrictEqual(
    inspectPowerEdgeItem(snapshot, edgeItem(), []),
    {
      evidence: ["/sitecore/content/Home: item identity matched"],
      divergences: [],
      divergentItemId: undefined,
    },
  );
});

test("Power Edge inspection distinguishes missing Authoring values from Edge values", () => {
  deepStrictEqual(
    inspectPowerEdgeItem(
      publishSnapshot(),
      edgeItem({ fields: { Title: "Welcome", Related: "different" } }),
      [
        ["Title", "Welcome"],
        ["Related", "expected"],
        ["MissingAuthoring", undefined],
      ],
    ),
    {
      evidence: ["/sitecore/content/Home › Title: matched"],
      divergences: [
        "/sitecore/content/Home › Related: expected \"expected\", Edge returned \"different\"",
        "/sitecore/content/Home › MissingAuthoring: expected missing authoring value, Edge returned missing",
      ],
      divergentItemId: "{ABC-DEF}",
    },
  );
});

test("Power Edge aggregation preserves snapshot order and summarizes partial observations", () => {
  const alpha = publishSnapshot({ itemId: "alpha", path: "/alpha" });
  const beta = publishSnapshot({ itemId: "{B-E-T-A}", path: "/beta" });
  const gamma = publishSnapshot({ itemId: "gamma", path: "/gamma" });
  const matched: EdgeItemObservation = {
    evidence: ["alpha matched"],
    divergences: [],
  };
  const diverged: EdgeItemObservation = {
    evidence: ["beta field matched"],
    divergences: ["beta field diverged"],
    divergentItemId: "beta",
  };
  const observations = new Map<string, EdgeItemObservation>([
    ["beta", diverged],
    ["alpha", matched],
  ]);

  deepStrictEqual(
    summarizePowerEdgeObservations([alpha, beta, gamma], observations),
    {
      matchedCount: 1,
      divergentItemIds: ["{B-E-T-A}"],
      evidence: ["alpha matched", "beta field matched"],
      divergences: ["beta field diverged"],
    },
  );
});

function publishSnapshot(
  overrides: Partial<PublishSnapshot> = {},
): PublishSnapshot {
  return {
    itemId: "{ABC-DEF}",
    path: "/sitecore/content/Home",
    displayName: "Home",
    language: "en",
    version: 1,
    fields: { Title: "Welcome" },
    references: [],
    ...overrides,
  };
}

function edge(
  sourceItemId: string,
  targetItemId: string,
  fieldName: string,
): ReferenceEdge {
  return { sourceItemId, targetItemId, fieldName };
}

function edgeItem(overrides: Partial<RawEdgeItem> = {}): RawEdgeItem {
  return {
    id: "abcdef",
    fields: {},
    ...overrides,
  };
}
