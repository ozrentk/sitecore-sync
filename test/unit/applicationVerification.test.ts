import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { evaluateApplicationResponse } from "../../src/publishing/applicationVerification";
import type {
  PublishFieldSelection,
  PublishRun,
  PublishSnapshot,
} from "../../src/publishing/publishingTypes";

test("application verification matches healthy responses without textual candidates", () => {
  const context = verificationContext({
    snapshots: [publishSnapshot({ fields: { Short: "ab", Blank: "  " } })],
  });

  deepStrictEqual(
    evaluateApplicationResponse(
      context,
      "https://www.example.com/page",
      {
        status: 204,
        headers: { age: "10", "x-vercel-cache": "HIT" },
        body: "",
      },
    ),
    {
      status: "matched",
      summary: "The public application response was successful; no textual assertions were available.",
      evidence: [
        "URL: https://www.example.com/page",
        "HTTP 204",
        "age: 10",
        "x-vercel-cache: HIT",
      ],
    },
  );
});

test("application verification treats only HTTP 200 through 399 as healthy", () => {
  const context = verificationContext();
  const healthy = evaluateApplicationResponse(
    context,
    "https://www.example.com/",
    { status: 399, headers: {}, body: "Welcome" },
  );
  const unhealthy = evaluateApplicationResponse(
    context,
    "https://www.example.com/",
    { status: 400, headers: {}, body: "Welcome" },
  );

  strictEqual(healthy.status, "matched");
  strictEqual(unhealthy.status, "diverged");
  strictEqual(unhealthy.summary, "The application returned HTTP 400.");
});

test("implicit application verification requires any expected value", () => {
  const context = verificationContext({
    snapshots: [publishSnapshot({
      fields: { Title: "Welcome", Summary: "Expected summary" },
    })],
  });

  deepStrictEqual(
    evaluateApplicationResponse(
      context,
      "https://www.example.com/",
      { status: 200, headers: {}, body: "<h1>Welcome</h1>" },
    ),
    {
      status: "matched",
      summary: "The public application response contains 1 expected value(s).",
      evidence: [
        "URL: https://www.example.com/",
        "HTTP 200",
        "Matched /sitecore/content/Home: Title",
      ],
    },
  );
  deepStrictEqual(
    evaluateApplicationResponse(
      context,
      "https://www.example.com/",
      { status: 200, headers: {}, body: "No expected content" },
    ),
    {
      status: "inconclusive",
      summary: "The response was successful but did not expose the expected text in its server response. Browser-rendered DOM was not evaluated.",
      evidence: [
        "URL: https://www.example.com/",
        "HTTP 200",
      ],
    },
  );
});

test("explicit application verification requires every selected value", () => {
  const fieldSelections: readonly PublishFieldSelection[] = [
    { itemId: "abcdef", fieldName: "Title" },
    { itemId: "{ABC-DEF}", fieldName: "Summary" },
  ];
  const context = verificationContext({
    snapshots: [publishSnapshot({
      fields: { Title: "Welcome", Summary: "Expected summary" },
    })],
    fieldSelections,
  });

  deepStrictEqual(
    evaluateApplicationResponse(
      context,
      "https://www.example.com/",
      { status: 200, headers: {}, body: "Welcome — Expected summary" },
    ),
    {
      status: "matched",
      summary: "The public application response contains all 2 selected textual value(s).",
      evidence: [
        "URL: https://www.example.com/",
        "HTTP 200",
        "Matched /sitecore/content/Home: Title",
        "Matched /sitecore/content/Home: Summary",
      ],
    },
  );
  deepStrictEqual(
    evaluateApplicationResponse(
      context,
      "https://www.example.com/",
      { status: 200, headers: {}, body: "Welcome" },
    ),
    {
      status: "inconclusive",
      summary: "The response was successful but exposed only 1/2 selected textual value(s). Browser-rendered DOM was not evaluated.",
      evidence: [
        "URL: https://www.example.com/",
        "HTTP 200",
        "Matched /sitecore/content/Home: Title",
        "Missing /sitecore/content/Home › Summary: \"Expected summary\"",
      ],
    },
  );
});

test("application verification filters by trimmed length but matches exact stored values", () => {
  const context = verificationContext({
    snapshots: [publishSnapshot({ fields: { Short: "ab", Spaced: " abc " } })],
    fieldSelections: [
      { itemId: "abcdef", fieldName: "Short" },
      { itemId: "abcdef", fieldName: "Spaced" },
    ],
  });

  deepStrictEqual(
    evaluateApplicationResponse(
      context,
      "https://www.example.com/",
      { status: 200, headers: {}, body: "abc" },
    ),
    {
      status: "inconclusive",
      summary: "The response was successful but did not expose the expected text in its server response. Browser-rendered DOM was not evaluated.",
      evidence: [
        "URL: https://www.example.com/",
        "HTTP 200",
        "Missing /sitecore/content/Home › Spaced: \" abc \"",
      ],
    },
  );
});

test("application verification caps matched and missing value evidence independently", () => {
  const fields = Object.fromEntries(
    Array.from({ length: 25 }, (_value, index) => [
      `Field${index.toString().padStart(2, "0")}`,
      `Value${index.toString().padStart(2, "0")}`,
    ]),
  );
  const fieldSelections = Object.keys(fields).map((fieldName) => ({
    itemId: "abcdef",
    fieldName,
  }));
  const context = verificationContext({
    snapshots: [publishSnapshot({ fields })],
    fieldSelections,
  });
  const matched = evaluateApplicationResponse(
    context,
    "https://www.example.com/",
    { status: 200, headers: {}, body: Object.values(fields).join("|") },
  );
  const missing = evaluateApplicationResponse(
    context,
    "https://www.example.com/",
    { status: 200, headers: {}, body: "none" },
  );

  strictEqual(matched.evidence.length, 22);
  strictEqual(matched.evidence.at(-1), "Matched /sitecore/content/Home: Field19");
  strictEqual(missing.evidence.length, 22);
  strictEqual(
    missing.evidence.at(-1),
    "Missing /sitecore/content/Home › Field19: \"Value19\"",
  );
});

function verificationContext(
  overrides: Partial<Pick<PublishRun, "snapshots" | "fieldSelections">> = {},
): Pick<PublishRun, "snapshots" | "fieldSelections"> {
  return {
    snapshots: [publishSnapshot()],
    fieldSelections: undefined,
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
