import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import type {
  BrowserDomAssertionResult,
  BrowserDomVerificationResult,
} from "../../src/publishing/browserDomVerifier";
import { evaluateBrowserDomResult } from "../../src/publishing/browserDomVerification";

test("browser DOM evaluation matches when every assertion matches", () => {
  deepStrictEqual(
    evaluateBrowserDomResult(browserResult({
      browserChannel: "msedge",
      requestedUrl: "https://www.example.com/requested",
      finalUrl: "https://www.example.com/final",
      assertions: [assertionResult()],
    })),
    {
      status: "matched",
      summary: "1 selected field value(s) matched in the browser-rendered DOM.",
      evidence: [
        "Browser: msedge",
        "Requested URL: https://www.example.com/requested",
        "Final URL: https://www.example.com/final",
        "/sitecore/content/Home › Title: matched; selector \"main h1\"; matches=1; expected=\"Welcome\"; observed=\"Welcome\"",
      ],
    },
  );
});

test("different browser DOM text takes precedence over uncertain assertions", () => {
  const outcome = evaluateBrowserDomResult(browserResult({
    assertions: [
      assertionResult({
        status: "different",
        matchCount: 2,
        observedTexts: ["Old title", "Fallback title"],
      }),
      assertionResult({
        fieldName: "Summary",
        selector: ".summary",
        expected: "Expected summary",
        status: "missing",
        matchCount: 0,
        observedTexts: [],
      }),
      assertionResult({
        fieldName: "Callout",
        selector: "[",
        expected: "Expected callout",
        status: "invalid",
        matchCount: 0,
        observedTexts: [],
      }),
    ],
  }));

  strictEqual(outcome.status, "diverged");
  strictEqual(
    outcome.summary,
    "1 selector assertion(s) found elements with different rendered text.",
  );
  deepStrictEqual(outcome.evidence.slice(3), [
    "/sitecore/content/Home › Title: different; selector \"main h1\"; matches=2; expected=\"Welcome\"; observed=\"Old title\", \"Fallback title\"",
    "/sitecore/content/Home › Summary: missing; selector \".summary\"; matches=0; expected=\"Expected summary\"; observed=none",
    "/sitecore/content/Home › Callout: invalid; selector \"[\"; matches=0; expected=\"Expected callout\"; observed=none",
  ]);
});

test("missing and invalid browser DOM assertions are inconclusive", () => {
  const outcome = evaluateBrowserDomResult(browserResult({
    assertions: [
      assertionResult({
        status: "missing",
        matchCount: 0,
        observedTexts: [],
        detail: "Timeout waiting for selector",
      }),
      assertionResult({
        fieldName: "Summary",
        selector: "[",
        expected: "Expected summary",
        status: "invalid",
        matchCount: 0,
        observedTexts: [],
        detail: "Invalid selector",
      }),
    ],
  }));

  strictEqual(outcome.status, "inconclusive");
  strictEqual(
    outcome.summary,
    "2 selector assertion(s) could not identify a browser-rendered value conclusively.",
  );
  deepStrictEqual(outcome.evidence.slice(3), [
    "/sitecore/content/Home › Title: missing; selector \"main h1\"; matches=0; expected=\"Welcome\"; observed=none",
    "/sitecore/content/Home › Summary: invalid; selector \"[\"; matches=0; expected=\"Expected summary\"; observed=none",
  ]);
});

test("browser DOM evaluation preserves the existing empty-result behavior", () => {
  deepStrictEqual(
    evaluateBrowserDomResult(browserResult({ assertions: [] })),
    {
      status: "matched",
      summary: "0 selected field value(s) matched in the browser-rendered DOM.",
      evidence: [
        "Browser: chrome",
        "Requested URL: https://www.example.com/page",
        "Final URL: https://www.example.com/page",
      ],
    },
  );
});

function browserResult(
  overrides: Partial<BrowserDomVerificationResult> = {},
): BrowserDomVerificationResult {
  return {
    browserChannel: "chrome",
    requestedUrl: "https://www.example.com/page",
    finalUrl: "https://www.example.com/page",
    assertions: [assertionResult()],
    ...overrides,
  };
}

function assertionResult(
  overrides: Partial<BrowserDomAssertionResult> = {},
): BrowserDomAssertionResult {
  return {
    itemPath: "/sitecore/content/Home",
    fieldName: "Title",
    selector: "main h1",
    expected: "Welcome",
    status: "matched",
    matchCount: 1,
    observedTexts: ["Welcome"],
    ...overrides,
  };
}
