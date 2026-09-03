import { deepStrictEqual } from "node:assert/strict";
import { test } from "node:test";
import {
  deduplicateIds,
  deduplicateSnapshots,
  expectedFieldsForSnapshot,
  powerExpectedFieldsForSnapshot,
  versionlessSnapshotEvidence,
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
