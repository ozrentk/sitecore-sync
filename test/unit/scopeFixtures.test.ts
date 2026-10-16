import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import type { AuthoringItemDetails, AuthoringItemField, CreateAuthoringItemInput, UpdateAuthoringItemInput } from "../../src/sitecore/authoringClient";
import { assertScopeItem, createScopeFixture, prepareScopeFixture, scopeFields, type ScopeFixturePlan, type ScopeFixtureStep } from "../../src/sitecore/scopeFixtures";
import { testConnection } from "./sitecoreClientTestHelpers";

const id = (n: number): string => n.toString(16).padStart(32, "0");
const normalize = (value: string): string => value.replace(/[{}-]/gu, "").toLowerCase();
const signal = new AbortController().signal;
const plan: ScopeFixturePlan = { name: "xm-fallback-scope-123456abcdef", parentId: id(1), parentPath: "/sitecore/content/Test",
  templateParentId: id(2), templatePath: "/sitecore/templates/User Defined/xm-fallback-scope-123456abcdef",
  languages: ["en-NZ", "en-AU", "en"], definitions: { template: id(3), section: id(4), field: id(5), standard: id(6) } };
function field(name: string, value: string, fieldId = id(99)): AuthoringItemField {
  return { fieldId, name, label: name, value, scope: "VERSIONED", type: "Single-Line Text", typeKey: "single-line text",
    containsFallbackValue: false, containsInheritedValue: false, containsStandardValue: false,
    isStandardTemplate: false, sectionName: "Content", sectionSortOrder: 0, sortOrder: 0, textual: true };
}
function item(itemId: string, path: string, fields: AuthoringItemField[] = []): AuthoringItemDetails {
  return { itemId, path, name: path.split("/").at(-1)!, displayName: "Test", language: "en", version: 1,
    hasChildren: false, template: { templateId: id(3), name: "Template" }, availableVersions: [{ language: "en", version: 1 }], fields };
}
function runtime() {
  let nextId = 100; const items = new Map<string, AuthoringItemDetails>();
  items.set(id(1), item(id(1), plan.parentPath)); items.set(id(2), item(id(2), "/sitecore/templates/User Defined"));
  for (const [key, name] of [["template", "Template"], ["section", "Template section"], ["field", "Template field"], ["standard", "Standard template"]] as const) {
    items.set(plan.definitions[key], item(plan.definitions[key], `/sitecore/templates/System/Templates/${name}`));
  }
  const writes: string[] = []; let failAt = 0; let wrongId = false;
  let checkpoints: ScopeFixtureStep[][] = [];
  const beforeWrite = (name: string) => {
    strictEqual(checkpoints.at(-1)?.at(-1)?.status, "outcome-unknown"); writes.push(name);
    if (writes.length === failAt) { throw new Error("transport failed"); }
  };
  const client = {
    loadItem: async (_connection: unknown, _secret: string, locator: { itemId: string } | { path: string }, language: string) => {
      const found = "itemId" in locator ? items.get(normalize(locator.itemId)) : [...items.values()].find(candidate => candidate.path === locator.path);
      if (!found) { throw new Error("Missing mock item"); }
      if (found.path === `${plan.parentPath}/${plan.name}`) {
        const fields = scopeFields.map(expected => {
          const definition = [...items.values()].find(candidate => candidate.name === expected.name)!;
          return { ...field(expected.name, expected.name === "FixtureDefaulted"
            ? (language === "en" ? "English explicit defaulted source" : "Requested standard default") : "", definition.itemId),
            scope: expected.scope, containsStandardValue: expected.name === "FixtureDefaulted" && language !== "en" };
        });
        return { ...found, language, fields };
      }
      return { ...found, language };
    },
    createItem: async (_connection: unknown, _secret: string, input: CreateAuthoringItemInput) => {
      beforeWrite("create"); const parent = items.get(normalize(input.parent))!;
      const created = { ...item(wrongId ? plan.parentId : id(nextId++), `${parent.path}/${input.name}`,
        Object.entries(input.fields ?? {}).map(([name, value]) => field(name, value))),
        template: { templateId: normalize(input.templateId), name: "Fixture" } };
      items.set(created.itemId, created); return created;
    },
    updateItemFields: async (_connection: unknown, _secret: string, input: UpdateAuthoringItemInput) => {
      beforeWrite("update"); strictEqual(Number.parseInt(normalize(input.itemId), 16) >= 100, true);
      const target = items.get(normalize(input.itemId))!;
      return { ...target, language: input.language, fields: Object.entries(input.fields).map(([name, value]) => field(name, value)) };
    },
    addItemVersion: async (_connection: unknown, _secret: string, input: { itemId: string; language: string }) => {
      beforeWrite("version"); strictEqual(Number.parseInt(normalize(input.itemId), 16) >= 100, true);
      return { ...items.get(normalize(input.itemId))!, language: input.language };
    },
  };
  const checkpoint = async (steps: readonly ScopeFixtureStep[]) => { checkpoints.push(structuredClone(steps) as ScopeFixtureStep[]); };
  return { client, checkpoint, items, writes, checkpoints: () => checkpoints,
    fail: (index: number) => { failAt = index; }, wrongId: () => { wrongId = true; },
    clearCheckpoints: () => { checkpoints = []; } };
}

test("isolated scope recipe resolves live metadata and creates only new owned targets", async () => {
  const f = runtime();
  deepStrictEqual(await prepareScopeFixture(f.client, testConnection, "secret", { itemId: id(1) }, plan.languages, "123456abcdef", signal), plan);
  const manifest = await createScopeFixture(plan, f.client, testConnection, "secret", f.checkpoint, signal);
  strictEqual(f.writes.length, 14); strictEqual(manifest.fields.length, 5);
  strictEqual(f.checkpoints().at(-1)?.every(step => step.status !== "outcome-unknown"), true);
  const actual = await f.client.loadItem(testConnection, "secret", { itemId: manifest.itemId }, "en-NZ");
  assertScopeItem(manifest, actual);
  strictEqual(actual.fields.find(candidate => candidate.name === "FixtureDefaulted")?.containsStandardValue, true);
  await rejects(async () => assertScopeItem(manifest, { ...actual, path: "/sitecore/content/Other" }), /identity/u);
  await rejects(async () => assertScopeItem(manifest, { ...actual, fields: actual.fields.map(candidate => ({ ...candidate, scope: "SHARED" })) }), /contract/u);
});

test("scope recipe stops on uncertain writes, reused identities, cancellation and checkpoint failure", async () => {
  const failed = runtime(); failed.fail(3);
  await rejects(createScopeFixture(plan, failed.client, testConnection, "secret", failed.checkpoint, signal), /transport/u);
  strictEqual(failed.writes.length, 3); strictEqual(failed.checkpoints().at(-1)?.at(-1)?.status, "outcome-unknown");
  const reused = runtime(); reused.wrongId();
  await rejects(createScopeFixture(plan, reused.client, testConnection, "secret", reused.checkpoint, signal), /existing identity/u);
  strictEqual(reused.writes.length, 1);
  const cancelled = runtime(); const controller = new AbortController();
  await rejects(createScopeFixture(plan, cancelled.client, testConnection, "secret", async steps => {
    await cancelled.checkpoint(steps); controller.abort();
  }, controller.signal)); strictEqual(cancelled.writes.length, 0);
  const storage = runtime();
  await rejects(createScopeFixture(plan, storage.client, testConnection, "secret", async () => { throw new Error("storage"); }, signal), /storage/u);
  strictEqual(storage.writes.length, 0);
});

test("scope preparation rejects unsupported locale lists, noncontent parents and wrong metadata paths", async () => {
  const f = runtime();
  for (const languages of [["en"], ["en-NZ", "fr"], ["en-NZ", "EN-nz", "en"]]) {
    await rejects(prepareScopeFixture(f.client, testConnection, "secret", { itemId: id(1) }, languages, "123456abcdef", signal));
  }
  f.items.set(id(1), item(id(1), "/sitecore/system/Test"));
  await rejects(prepareScopeFixture(f.client, testConnection, "secret", { itemId: id(1) }, plan.languages, "123456abcdef", signal), /content parent/u);
  strictEqual(f.writes.length, 0);
});
