import { deepStrictEqual, throws } from "node:assert/strict";
import { test } from "node:test";
import {
  powerPublishBatches,
  powerRepairBatches,
  validatePowerPublishBatches,
} from "../../src/publishing/powerPublishPlanning";
import type { PublishBatch, ReferenceEdge } from "../../src/publishing/publishingTypes";

test("Power Publish chunks independent dependencies and isolates the root last", () => {
  const batches = powerPublishBatches(
    ["root", "alpha", "beta", "gamma", "delta"],
    "root",
    [],
    2,
  );

  deepStrictEqual(batches, [
    {
      itemIds: ["alpha", "beta"],
      label: "Dependency layer 1 · batch 1/2",
    },
    {
      itemIds: ["gamma", "delta"],
      label: "Dependency layer 1 · batch 2/2",
    },
    { itemIds: ["root"], label: "Root batch" },
  ]);
});

test("Power Publish orders a dependency chain before its dependents", () => {
  const edges = [
    edge("root", "alpha"),
    edge("alpha", "beta"),
    edge("beta", "gamma"),
  ];

  const batches = powerPublishBatches(
    ["root", "alpha", "beta", "gamma"],
    "root",
    edges,
    20,
  );

  deepStrictEqual(batches.map((batch) => batch.itemIds), [
    ["gamma"],
    ["beta"],
    ["alpha"],
    ["root"],
  ]);
  deepStrictEqual(batches.map((batch) => batch.label), [
    "Dependency layer 1 · batch 1/3",
    "Dependency layer 2 · batch 2/3",
    "Dependency layer 3 · batch 3/3",
    "Root batch",
  ]);
});

test("Power Publish keeps reference cycles atomic even above the batch limit", () => {
  const edges = [
    edge("alpha", "beta"),
    edge("beta", "alpha"),
    edge("gamma", "alpha"),
    edge("root", "gamma"),
  ];

  const batches = powerPublishBatches(
    ["root", "alpha", "beta", "gamma"],
    "root",
    edges,
    1,
  );

  deepStrictEqual(new Set(batches[0]?.itemIds), new Set(["alpha", "beta"]));
  deepStrictEqual(batches[1]?.itemIds, ["gamma"]);
  deepStrictEqual(batches[2]?.itemIds, ["root"]);
});

test("Power Publish normalizes and deduplicates selected item IDs", () => {
  const batches = powerPublishBatches(
    ["{ROOT-ID}", "{ABC-DEF}", "abcdef", "ABCDEF"],
    "root-id",
    [edge("root-id", "{ABC-DEF}")],
    20,
  );

  deepStrictEqual(batches, [
    { itemIds: ["ABCDEF"], label: "Dependency layer 1 · batch 1/1" },
    { itemIds: ["root-id"], label: "Root batch" },
  ]);
});

test("Power Publish validation rejects unsafe or inconsistent plans", async (context) => {
  const selected = ["root", "alpha", "beta"];
  const edges = [edge("alpha", "beta")];

  await context.test("duplicate items", () => {
    throws(
      () => validatePowerPublishBatches([
        batch(["beta"]),
        batch(["alpha", "BETA"]),
        batch(["root"]),
      ], selected, "root", edges),
      /planned item BETA more than once/u,
    );
  });

  await context.test("omitted selections", () => {
    throws(
      () => validatePowerPublishBatches([
        batch(["alpha"]),
        batch(["root"]),
      ], selected, "root", edges),
      /omitted selected item beta/u,
    );
  });

  await context.test("unselected items", () => {
    throws(
      () => validatePowerPublishBatches([
        batch(["beta", "unexpected"]),
        batch(["alpha"]),
        batch(["root"]),
      ], selected, "root", edges),
      /planned unselected item unexpected/u,
    );
  });

  await context.test("root mixed into a dependency batch", () => {
    throws(
      () => validatePowerPublishBatches([
        batch(["beta"]),
        batch(["alpha", "root"]),
      ], selected, "root", edges),
      /did not isolate the selected root/u,
    );
  });

  await context.test("dependency after its source", () => {
    throws(
      () => validatePowerPublishBatches([
        batch(["alpha"]),
        batch(["beta"]),
        batch(["root"]),
      ], selected, "root", edges),
      /ordered dependency beta after alpha/u,
    );
  });
});

test("Power Publish permits references outside the selected plan and references to the final root", () => {
  const batches = [
    batch(["beta"]),
    batch(["alpha"]),
    batch(["root"]),
  ];

  validatePowerPublishBatches(
    batches,
    ["root", "alpha", "beta"],
    "root",
    [
      edge("alpha", "beta"),
      edge("alpha", "outside"),
      edge("outside", "beta"),
      edge("alpha", "root"),
    ],
  );
});

test("Power Publish repair preserves original ordering and batches new observations", () => {
  const original: readonly PublishBatch[] = [
    { itemIds: ["alpha", "beta"], label: "Dependency layer 1", operationId: "old-1" },
    { itemIds: ["gamma"], label: "Dependency layer 2", checkpointStatus: "matched" },
    { itemIds: ["root"], label: "Root batch" },
  ];

  const repaired = powerRepairBatches(
    original,
    ["BETA", "gamma", "new-1", "new-2", "new-3", "{B-E-T-A}"],
    2,
  );

  deepStrictEqual(repaired, [
    { itemIds: ["{B-E-T-A}"], label: "Repair · Dependency layer 1" },
    { itemIds: ["gamma"], label: "Repair · Dependency layer 2" },
    { itemIds: ["new-1", "new-2"], label: "Repair observed items · batch 1" },
    { itemIds: ["new-3"], label: "Repair observed items · batch 2" },
  ]);
});

test("Power Publish planning requires a positive integer batch size", () => {
  for (const value of [0, -1, 1.5, Number.NaN]) {
    throws(
      () => powerPublishBatches(["root"], "root", [], value),
      /maximum batch size must be a positive integer/u,
    );
    throws(
      () => powerRepairBatches([], ["item"], value),
      /maximum batch size must be a positive integer/u,
    );
  }
});

function edge(sourceItemId: string, targetItemId: string): ReferenceEdge {
  return { sourceItemId, targetItemId, fieldName: "Reference" };
}

function batch(itemIds: readonly string[]): PublishBatch {
  return { itemIds, label: "Batch" };
}
