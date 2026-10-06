import { deepStrictEqual, strictEqual, rejects } from "node:assert/strict";
import { test } from "node:test";
import { observeItemFallback } from "../../src/comparison/itemFallback";
import type { AuthoringItemDetails, AuthoringItemField, AuthoringItemLocator } from "../../src/sitecore/authoringClient";

const base: AuthoringItemDetails = { itemId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", language: "en-NZ", version: 0,
  name: "Page", displayName: "Page", path: "/sitecore/content/Page", hasChildren: false,
  template: { templateId: "page", name: "Page" }, availableVersions: [], fields: [] };
function field(fieldId: string, value: string): AuthoringItemField {
  return { fieldId, value, name: "setting", label: "setting", scope: "SHARED", type: "Text", typeKey: "text",
    textual: true, isStandardTemplate: true, containsFallbackValue: false, containsInheritedValue: false,
    containsStandardValue: true, sortOrder: 0, sectionName: "Advanced", sectionSortOrder: 0 };
}
const flag = (value: string) => field("fd4e2050186c43758b99e8a85dd7436e", value);
function definition(language: string, target: string): AuthoringItemDetails {
  return { ...base, itemId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", language: "en", name: language, version: 1,
    path: `/sitecore/system/Languages/${language}`, template: { templateId: "f68f13a63395426ab9a1fa2dc60d94eb", name: "Language" },
    fields: [field("892975ac496f4ac98826087095c68e1d", target)] };
}
const signal = () => new AbortController().signal;
const read = async (locator: AuthoringItemLocator, language: string): Promise<AuthoringItemDetails> =>
  "path" in locator ? definition(locator.path.split("/").at(-1)!, locator.path.endsWith("en-NZ") ? "en-AU" : "en")
    : { ...base, language, version: language === "en" ? 1 : 0, fields: language === "en" ? [flag("1")] : [] };

test("absent translation follows the stored chain to an enabled candidate without substituting values", async () => {
  deepStrictEqual(await observeItemFallback(base, read, signal()), {
    status: "candidate", chain: ["en-NZ", "en-AU", "en"], candidate: { language: "en", version: 1 },
  });
  strictEqual(await observeItemFallback({ ...base, version: 1 }, async () => { throw Error("No read expected"); }, signal()), undefined);
  deepStrictEqual(base.fields, []);
});

test("item-disabled and unknown flags never identify an enabled item-fallback candidate", async () => {
  for (const [value, status] of [["", "disabled"], ["0", "disabled"], ["invalid", "unavailable"]]) {
    const result = await observeItemFallback(base, async (locator, language) => {
      const item = await read(locator, language);
      return "itemId" in locator && item.version > 0 ? { ...item, fields: [flag(value!)] } : item;
    }, signal());
    strictEqual(result?.status, status);
    strictEqual(result?.candidate, undefined);
  }
});

test("missing links, cycles, unavailable metadata and mismatched reads remain unknown", async () => {
  for (const metadata of [definition("en-NZ", "en-NZ"), definition("en-NZ", "../en"),
    { ...definition("en-NZ", "en"), fields: [] }, { ...definition("en-NZ", "en"), language: "fr" },
    { ...definition("en-NZ", "en"), path: "/other" }]) {
    strictEqual((await observeItemFallback(base, async () => metadata, signal()))?.status, "unavailable");
  }
  strictEqual((await observeItemFallback(base, async () => { throw Error("Transport error"); }, signal()))?.status, "unavailable");
  strictEqual((await observeItemFallback(base, async () => definition("en-NZ", ""), signal()))?.status, "no-source");
});

test("GUID language references are verified and reads honour cancellation", async () => {
  const targetId = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const result = await observeItemFallback(base, async (locator, language) => {
    if ("path" in locator) return definition("en-NZ", targetId);
    if (locator.itemId === targetId) return definition("en", "");
    return read(locator, language);
  }, signal());
  deepStrictEqual(result?.chain, ["en-NZ", "en"]);
  strictEqual(result?.candidate?.language, "en");
  const controller = new AbortController();
  await rejects(observeItemFallback(base, async () => { controller.abort(); return definition("en-NZ", "en"); }, controller.signal), /abort/iu);
});

test("chain traversal is bounded and a contradictory local version is not resolved", async () => {
  let reads = 0;
  const bounded = await observeItemFallback({ ...base, language: "en-x0" }, async (locator, language) => {
    reads++;
    if ("itemId" in locator) return { ...base, language };
    const name = locator.path.split("/").at(-1)!;
    return definition(name, `en-x${Number(name.slice(4)) + 1}`);
  }, signal());
  strictEqual(bounded?.status, "unavailable");
  strictEqual(reads, 32);
  strictEqual((await observeItemFallback({ ...base, availableVersions: [{ language: "en-NZ", version: 1 }] },
    async () => { throw Error("No read expected"); }, signal()))?.status, "unavailable");
});

test("candidate identity, locale, version and shared flag are validated", async () => {
  for (const change of [{ itemId: "other" }, { language: "fr" }, { version: -1 }, { version: 1.5 },
    { fields: [] }, { fields: [flag("1"), flag("1")] }, { fields: [{ ...flag("1"), scope: "VERSIONED" as const }] }]) {
    const result = await observeItemFallback(base, async (locator, language) => {
      const item = await read(locator, language);
      return "itemId" in locator && item.version > 0 ? { ...item, ...change } : item;
    }, signal());
    strictEqual(result?.status, "unavailable");
    strictEqual(result?.candidate, undefined);
  }
});
