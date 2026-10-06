import { deepStrictEqual, strictEqual, rejects } from "node:assert/strict";
import { test } from "node:test";
import { collectFallbackConfiguration } from "../../src/sitecore/fallbackConfiguration";
import type { ProbeEvidence } from "../../src/sitecore/fallbackDiagnostics";

const id = (n: number): string => n.toString(16).padStart(32, "0");
const setting = (name: string, value: string) => ({ name, value, fieldId: id(90), containsStandardValue: true });
function evidence(itemId: string, nodes: unknown[], language = "en", templateId?: string): ProbeEvidence {
  return { label: "fixture", language, status: "complete", pages: [{ observedAt: "2026-01-01T00:00:00Z", data: {
    item: { itemId, name: "Fixture", path: "/fixture", version: 1, template: { templateId }, fields: { nodes } },
  } }] };
}
interface Configuration {
  links: { targetId?: string; interpretation: string }[];
  fieldDefinitions: { definitionId: string; evidence: { language: string; settings: unknown[] } }[];
  templateItems: unknown[];
  coverage: { configurationItemReads: number; fieldSelectionTruncated: boolean; languageTraversalTruncated: boolean };
  environmentSettings: { status: string };
}

test("configuration follows observed language references, deduplicates cycles and preserves per-locale field rules", async () => {
  const calls: string[] = [];
  const observations = [evidence(id(1), [{ name: "Title", containsFallbackValue: true, templateField: { templateFieldId: id(4) } }], "en-NZ", id(5))];
  const result = await collectFallbackConfiguration(observations, ["en-NZ", "en"], async (_label, locator, language) => {
    const key = "path" in locator ? locator.path : locator.itemId;
    calls.push(`${key}:${language}`);
    if (key.endsWith("en-NZ")) { return evidence(id(2), [setting("Fallback Language", id(3))]); }
    if (key.endsWith("/en") || key === id(3)) { return evidence(id(3), [setting("Fallback Language", id(2))]); }
    if (key === id(5)) { return evidence(id(5), [setting("__Base template", id(6)), setting("__Standard values", id(7))]); }
    if (key === id(6) || key === id(7)) { return evidence(key, [setting("__Enable item fallback", "1"), setting("__Base template", id(5))]); }
    return evidence(id(4), [setting("Enable Shared Language Fallback", "1"), setting("Enable Language Fallback", language === "en-NZ" ? "0" : "1"), setting("Unrelated", "omit")], language);
  }, new AbortController().signal) as Configuration;
  deepStrictEqual(result.links.map(link => link.targetId), [id(3), id(2)]);
  strictEqual(result.fieldDefinitions.length, 2);
  strictEqual(result.templateItems.length, 3);
  strictEqual(result.fieldDefinitions[0].evidence.settings.length, 2);
  strictEqual(calls.filter(call => call === `${id(3)}:en`).length, 0);
  strictEqual(result.environmentSettings.status, "unknown");
});

test("configuration prioritizes fallback fields and declares omitted definitions", async () => {
  const fields = Array.from({ length: 18 }, (_, n) => ({ name: `Field${n}`, containsFallbackValue: n === 17, templateField: { templateFieldId: id(n + 10) } }));
  const result = await collectFallbackConfiguration([evidence(id(1), fields)], ["en"], async (_label, locator, language) =>
    evidence("itemId" in locator ? locator.itemId : id(2), [], language), new AbortController().signal) as Configuration;
  strictEqual(result.fieldDefinitions.length, 16);
  strictEqual(result.fieldDefinitions[0].definitionId, id(27));
  strictEqual(result.coverage.fieldSelectionTruncated, true);
});

test("configuration does not follow malformed references and respects traversal limits", async () => {
  let number = 3;
  const result = await collectFallbackConfiguration([], ["en"], async () => evidence(id(number++), [setting("Fallback Language", id(number))]), new AbortController().signal) as Configuration;
  strictEqual(result.coverage.configurationItemReads, 16);
  strictEqual(result.coverage.languageTraversalTruncated, true);
  const malformed = await collectFallbackConfiguration([], ["en"], async () => evidence(id(1), [setting("Fallback Language", "../outside")]), new AbortController().signal) as Configuration;
  strictEqual(malformed.coverage.configurationItemReads, 1);
  strictEqual(malformed.links[0].interpretation, "unrecognized-reference");
});

test("configuration preserves unavailable reads and stops on cancellation", async () => {
  const result = await collectFallbackConfiguration([], ["en"], async () => ({ label: "unavailable", language: "en", status: "unavailable", pages: [] }), new AbortController().signal);
  strictEqual(JSON.stringify(result).includes('"status":"unavailable"'), true);
  await rejects(collectFallbackConfiguration([], ["en"], async () => { throw new Error("must not read"); }, AbortSignal.abort()), { name: "AbortError" });
});

test("configuration follows locale-name references and terminates case-insensitive cycles", async () => {
  const paths: string[] = [];
  const result = await collectFallbackConfiguration([], ["en-NZ"], async (_label, locator) => {
    const path = "path" in locator ? locator.path : locator.itemId;
    paths.push(path);
    const next = path.endsWith("en-NZ") ? "en-AU" : path.endsWith("en-AU") ? "en" : "EN-nz";
    return evidence(id(paths.length), [setting("Fallback Language", next)]);
  }, new AbortController().signal) as Configuration;
  deepStrictEqual(paths, ["/sitecore/system/Languages/en-NZ", "/sitecore/system/Languages/en-AU", "/sitecore/system/Languages/en"]);
  strictEqual(result.links.every(link => link.interpretation === "reference-observed"), true);
  strictEqual(result.coverage.languageTraversalTruncated, false);
});

test("configuration excludes invalid and discarded pages from discovery but retains separate diagnostic evidence", async () => {
  const stale = evidence(id(1), [{ name: "Stale", templateField: { templateFieldId: id(9) } }], "en", id(8));
  const valid = evidence(id(1), [{ name: "Current", templateField: { templateFieldId: id(4) } }]);
  const invalid: ProbeEvidence = { ...stale, status: "invalid-response", issue: "outer-language-mismatch" };
  const restarted: ProbeEvidence = { ...valid, discardedAttempts: [{ reason: "item-changed", pages: stale.pages }],
    restarts: [{ reason: "item-version-drift", afterRequestId: 3 }], requestIds: [2, 3, 4] };
  const requested: string[] = [];
  const result = await collectFallbackConfiguration([invalid, restarted], ["en"], async (_label, locator) => {
    requested.push("itemId" in locator ? locator.itemId : locator.path);
    return { ...evidence(id(2), [setting("Fallback Language", id(7))]), status: "invalid-response", issue: "outer-item-mismatch" };
  }, new AbortController().signal) as Configuration & { itemSettings: { discardedAttempts?: unknown[]; requestIds?: number[] }[] };
  deepStrictEqual(requested, ["/sitecore/system/Languages/en", id(4)]);
  strictEqual(result.links.length, 0);
  strictEqual(result.itemSettings[1]!.discardedAttempts?.length, 1);
  deepStrictEqual(result.itemSettings[1]!.requestIds, [2, 3, 4]);
});
