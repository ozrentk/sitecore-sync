import { strictEqual, throws } from "node:assert/strict";
import { test } from "node:test";
import { comparisonFieldEvidence } from "../../src/comparison/fieldFallback";
import type { AuthoringItemDetails } from "../../src/sitecore/authoringClient";

const exact: AuthoringItemDetails = { itemId: "{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}", language: "en-NZ", version: 0,
  name: "test", displayName: "test", path: "/sitecore/test", hasChildren: false,
  template: { templateId: "template", name: "Test" }, availableVersions: [], fields: [] };

test("comparison evidence preserves version-zero exact and effective observations without inventing a source", () => {
  const effective = { ...exact, itemId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", language: "EN-nz" };
  const result = comparisonFieldEvidence(exact, effective, "exact-time", "effective-time");
  strictEqual(result.comparisonEvidence?.exact, exact);
  strictEqual(result.comparisonEvidence?.sourceLanguage, "unknown");
  strictEqual(result.comparisonEvidence?.effectiveObservedAt, "effective-time");
  strictEqual(result.version, 0);
});

test("comparison evidence rejects mixed identities, locales and numbered versions", () => {
  for (const change of [{ itemId: "other" }, { language: "en" }, { version: 1 }]) {
    throws(() => comparisonFieldEvidence(exact, { ...exact, ...change }, "a", "b"), /changed between exact and fallback/u);
  }
});
