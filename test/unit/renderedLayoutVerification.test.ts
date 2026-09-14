import { deepStrictEqual } from "node:assert/strict";
import { test } from "node:test";
import {
  evaluateRenderedLayout,
  inspectRenderedReference,
  inspectRenderedSnapshot,
} from "../../src/publishing/renderedLayoutVerification";
import type {
  PublishRun,
  PublishSnapshot,
  ReferenceEdge,
} from "../../src/publishing/publishingTypes";

test("rendered snapshot inspection handles non-JSON data without hiding selected fields", () => {
  const snapshot = publishSnapshot();

  deepStrictEqual(
    inspectRenderedSnapshot("prefix ABCDEF suffix", snapshot, ["Title"]),
    {
      path: "/sitecore/content/Home",
      itemId: "{ABC-DEF}",
      found: true,
      fieldMismatches: [
        "/sitecore/content/Home › Title: rendered layout data could not be inspected",
      ],
      fieldMatches: [],
    },
  );
  deepStrictEqual(
    inspectRenderedSnapshot("unrelated response", snapshot),
    {
      path: "/sitecore/content/Home",
      itemId: "{ABC-DEF}",
      found: false,
      fieldMismatches: [],
      fieldMatches: [],
    },
  );
});

test("rendered snapshot inspection collects nested field shapes across matching objects", () => {
  const rendered = JSON.stringify({
    components: [
      {
        itemId: "abcdef",
        fields: {
          Title: { value: "Old title" },
          Summary: "Summary text",
        },
      },
      {
        id: "{ABC-DEF}",
        fields: { Title: { value: "Welcome" } },
        nested: { name: "Inline", value: "Inline text" },
      },
    ],
  });
  const snapshot = publishSnapshot({
    fields: {
      Title: "Welcome",
      Summary: "Summary text",
      Inline: "Inline text",
    },
  });

  deepStrictEqual(
    inspectRenderedSnapshot(
      rendered,
      snapshot,
      ["Title", "Summary", "Inline", "Missing"],
    ),
    {
      path: "/sitecore/content/Home",
      itemId: "{ABC-DEF}",
      found: true,
      fieldMismatches: [
        "/sitecore/content/Home › Missing: not observable in rendered layout; expected \"\"",
      ],
      fieldMatches: [
        "/sitecore/content/Home › Title: \"Welcome\" matched among 2 observed values across 2 matching object(s)",
        "/sitecore/content/Home › Summary: \"Summary text\" matched across 2 matching object(s)",
        "/sitecore/content/Home › Inline: \"Inline text\" matched across 2 matching object(s)",
      ],
    },
  );
});

test("rendered snapshot inspection reports observed values and ignores unobservable implicit fields", () => {
  const rendered = JSON.stringify({
    itemId: "abcdef",
    fields: { Title: "Rendered title" },
  });

  deepStrictEqual(
    inspectRenderedSnapshot(
      rendered,
      publishSnapshot({ fields: { Title: "Expected title", Unexposed: "value" } }),
    ),
    {
      path: "/sitecore/content/Home",
      itemId: "{ABC-DEF}",
      found: true,
      fieldMismatches: [
        "/sitecore/content/Home › Title: expected \"Expected title\", rendered layout exposed \"Rendered title\" across 1 matching object(s)",
      ],
      fieldMatches: [],
    },
  );
});

test("rendered reference inspection distinguishes absent sources and missing targets", () => {
  const edge = referenceEdge("{SOURCE-ID}", "{TARGET-ID}", "Related");
  const matching = JSON.stringify({
    component: {
      itemId: "source-id",
      fields: { Related: "target-id" },
    },
  });
  const missingTarget = JSON.stringify({
    component: {
      itemId: "SOURCEID",
      fields: { Related: "different" },
    },
  });

  deepStrictEqual(inspectRenderedReference(matching, edge), {
    sourceFound: true,
    targetFound: true,
  });
  deepStrictEqual(inspectRenderedReference(missingTarget, edge), {
    sourceFound: true,
    targetFound: false,
  });
  deepStrictEqual(inspectRenderedReference("{}", edge), {
    sourceFound: false,
    targetFound: false,
  });
  deepStrictEqual(inspectRenderedReference("not json", edge), {
    sourceFound: false,
    targetFound: false,
  });
});

test("rendered layout accepts route-root identity and records unselected missing items as evidence", () => {
  const root = publishSnapshot();
  const child = publishSnapshot({ itemId: "child", path: "/sitecore/content/Home/Child" });

  deepStrictEqual(
    evaluateRenderedLayout(
      verificationContext({ snapshots: [root, child] }),
      { itemId: "abcdef", rendered: "{}" },
      "{ABC-DEF}",
    ),
    {
      status: "matched",
      summary: "The rendered route identity and observable reference chains matched.",
      evidence: [
        "/sitecore/content/Home/Child: item child was not exposed in rendered data",
      ],
    },
  );
});

test("rendered layout requires every explicitly selected field and item", () => {
  const fieldSelections = [{ itemId: "abcdef", fieldName: "Title" }] as const;
  const context = verificationContext({ fieldSelections });
  const matched = JSON.stringify({
    component: {
      itemId: "{ABC-DEF}",
      fields: { Title: { value: "Welcome" } },
    },
  });

  deepStrictEqual(
    evaluateRenderedLayout(context, { itemId: "ABCDEF", rendered: matched }, "{ABC-DEF}"),
    {
      status: "matched",
      summary: "1 selected field value(s) matched in the rendered layout.",
      evidence: [
        "/sitecore/content/Home › Title: \"Welcome\" matched across 1 matching object(s)",
      ],
    },
  );
  deepStrictEqual(
    evaluateRenderedLayout(context, { itemId: "ABCDEF", rendered: "{}" }, "abcdef"),
    {
      status: "diverged",
      summary: "The rendered layout did not expose every selected field value.",
      evidence: [
        "/sitecore/content/Home: item {ABC-DEF} was not exposed in rendered data",
      ],
    },
  );
});

test("rendered layout reports route identity and observable reference divergences", () => {
  const context = verificationContext({
    referenceEdges: [referenceEdge("source-item", "target-item", "Related")],
  });
  const rendered = JSON.stringify({
    component: {
      itemId: "source-item",
      fields: { Related: "different" },
    },
  });

  deepStrictEqual(
    evaluateRenderedLayout(
      context,
      { itemId: "actual-route", rendered },
      "expected-route",
    ),
    {
      status: "diverged",
      summary: "The rendered layout did not match every observed item and scoped field value.",
      evidence: [
        "Route resolved to actual-route, expected pre-publish route item expected-route",
        "source-i did not reference target-i through Related",
        "/sitecore/content/Home: item {ABC-DEF} was not exposed in rendered data",
      ],
    },
  );
  deepStrictEqual(
    evaluateRenderedLayout(context, { rendered: "{}" }),
    {
      status: "diverged",
      summary: "The rendered layout did not match every observed item and scoped field value.",
      evidence: [
        "Rendered layout did not identify its route item.",
        "/sitecore/content/Home: item {ABC-DEF} was not exposed in rendered data",
      ],
    },
  );
});

function verificationContext(
  overrides: Partial<Pick<
    PublishRun,
    "rootItemId" | "snapshots" | "fieldSelections" | "referenceEdges"
  >> = {},
): Pick<PublishRun, "rootItemId" | "snapshots" | "fieldSelections" | "referenceEdges"> {
  return {
    rootItemId: "{ABC-DEF}",
    snapshots: [publishSnapshot()],
    fieldSelections: undefined,
    referenceEdges: [],
    ...overrides,
  };
}

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

function referenceEdge(
  sourceItemId: string,
  targetItemId: string,
  fieldName: string,
): ReferenceEdge {
  return { sourceItemId, targetItemId, fieldName };
}
