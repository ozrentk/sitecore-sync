import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { navigationEndpoint, prepareCompare, readModePreferences, type ModeSwitchChoices } from "../../src/comparison/modeSwitching";

const source = { connectionId: "a", language: "en", rootPath: "/sitecore/home", selectedItemId: "page" };
const partner = { connectionId: "b", language: "fr", languagesLocked: false };
function choices(overrides: Partial<ModeSwitchChoices> = {}): ModeSwitchChoices {
  return { current: () => true, partner: async () => "b", languages: async () => ["en", "fr"],
    language: async () => undefined, unlock: async () => false, ...overrides };
}

test("mode preferences survive serialization and discard unknown or malformed data", () => {
  const saved = readModePreferences(JSON.parse(JSON.stringify({ partners: { a: { ...partner, secret: "not persisted" }, b: null }, retainedSide: "right", token: "not persisted" })));
  deepStrictEqual(saved, { partners: { a: partner } });
  deepStrictEqual(readModePreferences(null), { partners: {} });
  deepStrictEqual(readModePreferences({ partners: [], retainedSide: "other" }), { partners: {} });
});

test("remembered comparison preserves source navigation and independent partner language", async () => {
  const next = await prepareCompare(source, partner, ["a", "b"], choices({ partner: async () => { throw Error("Unexpected picker"); } }));
  deepStrictEqual(next, { mode: "compare", left: source, right: { connectionId: "b", language: "fr", rootPath: "/" }, languagesLocked: false });
});

test("first use and deleted partners require a choice; cancellation keeps the source untouched", async () => {
  for (const saved of [undefined, { ...partner, connectionId: "deleted" }]) {
    let asked = 0;
    strictEqual(await prepareCompare(source, saved, ["a"], choices({ partner: async () => { asked++; return undefined; } })), undefined);
    strictEqual(asked, 1);
    const next = await prepareCompare(source, saved, ["a"], choices({ partner: async () => "a" }));
    strictEqual(next?.mode === "compare" && next.right.connectionId, "a");
  }
  strictEqual(source.selectedItemId, "page");
});

test("unavailable saved language requires a valid explicit choice, including cancellation", async () => {
  const saved = { ...partner, language: "removed" };
  strictEqual(await prepareCompare(source, saved, ["a", "b"], choices()), undefined);
  strictEqual(await prepareCompare(source, saved, ["a", "b"], choices({ language: async () => "invalid" })), undefined);
  const next = await prepareCompare(source, saved, ["a", "b"], choices({ language: async () => "fr" }));
  strictEqual(next?.mode === "compare" && next.right.language, "fr");
});

test("same-connection cross-language comparison requires explicit unlock when remembered locked", async () => {
  const saved = { ...partner, connectionId: "a", languagesLocked: true };
  strictEqual(await prepareCompare(source, saved, ["a"], choices()), undefined);
  const next = await prepareCompare(source, saved, ["a"], choices({ unlock: async () => true }));
  strictEqual(next?.mode === "compare" && next.languagesLocked, false);
  strictEqual(next?.mode === "compare" && next.right.language, "fr");
  const locked = await prepareCompare(source, { ...saved, language: "EN" }, ["a"], choices());
  strictEqual(locked?.mode === "compare" && locked.languagesLocked, true);
});

test("superseded partner and language preparation cannot commit", async () => {
  let current = true;
  strictEqual(await prepareCompare(source, undefined, ["a", "b"], choices({ current: () => current,
    partner: async () => { current = false; return "b"; } })), undefined);
  current = true;
  strictEqual(await prepareCompare(source, partner, ["a", "b"], choices({ current: () => current,
    languages: async () => { current = false; return ["en", "fr"]; } })), undefined);
});

test("catalog failure propagates without changing the source", async () => {
  await rejects(prepareCompare(source, partner, ["a", "b"], choices({ languages: async () => { throw Error("Offline"); } })), /Offline/u);
  strictEqual(source.language, "en");
});

test("navigation accepts only bounded absolute paths and nonempty item identities", () => {
  deepStrictEqual(navigationEndpoint(source, { rootPath: "relative", selectedItemId: "" }), { ...source, selectedItemId: undefined });
  deepStrictEqual(navigationEndpoint(source, { rootPath: "/sitecore/other", selectedItemId: "other", secret: "ignored" }), { ...source, rootPath: "/sitecore/other", selectedItemId: "other" });
});
