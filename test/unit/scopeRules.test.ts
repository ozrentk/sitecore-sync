import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { assertScopeRuleDefinition, prepareScopeRule, executeScopeRule } from "../../src/sitecore/scopeRules";
import type { ScopeFixtureManifest, ScopeFixtureStep } from "../../src/sitecore/scopeFixtures";
import type { AuthoringItemDetails, AuthoringItemField, AuthoringContentClient } from "../../src/sitecore/authoringClient";
import { testConnection } from "./sitecoreClientTestHelpers";

const fieldId = "00000000000000000000000000000001";
const fixture: ScopeFixtureManifest = { itemId: "00000000000000000000000000000002", path: "/sitecore/content/Test",
  templateId: "00000000000000000000000000000003", templatePath: "/sitecore/templates/User Defined/xm-fallback-scope-123456abcdef",
  languages: ["en-NZ", "en-AU", "en"], fields: [{ fieldId, name: "FixtureEnabled", scope: "VERSIONED" }] };
const input = { fieldId, language: "en-NZ", sharedEnabled: false, languageEnabled: true };
const signal = new AbortController().signal;
function runtime() {
  const definitions = [
    ["Type", "Single-Line Text", "SHARED", "ab162cc0dc804abf8871998ee5d7ba32", "Grouped Droplist"],
    ["Shared", "", "SHARED", "be351a73fcb0421393fac302d8ab4f51", "Checkbox"],
    ["Unversioned", "", "SHARED", "39847666389d409b95bdf2016f11eed5", "Checkbox"],
    ["Enable Shared Language Fallback", "1", "SHARED", "24cb32f0e3644f37b4000f2899097b5b", "Checkbox"],
    ["Enable Language Fallback", "", "VERSIONED", "fa6225380c134130a00145984241aa00", "Checkbox"],
  ] as const;
  const fields: AuthoringItemField[] = definitions.map(([name, value, scope, id, type]) => ({
    name, value, scope, fieldId: id, type, typeKey: type.toLowerCase(), label: name, textual: false,
    sortOrder: 0, sectionName: "Data", sectionSortOrder: 0, isStandardTemplate: false,
    containsFallbackValue: false, containsInheritedValue: false, containsStandardValue: false,
  }));
  const english: AuthoringItemDetails = { itemId: fieldId, path: `${fixture.templatePath}/Fixture fields/FixtureEnabled`,
    name: "FixtureEnabled", displayName: "FixtureEnabled", language: "en", version: 1, fields,
    hasChildren: false, template: { templateId: "455a3e98a6274b408035e683a0331ac7", name: "Template field" },
    availableVersions: [{ language: "en", version: 1 }] };
  let local: AuthoringItemDetails = { ...english, language: "en-NZ", version: 0, fields: [] };
  const checkpoints: ScopeFixtureStep[][] = []; const writes: string[] = [];
  let failUpdate = false; let validations = 0;
  const client: Pick<AuthoringContentClient, "loadItem" | "validateAddItemVersion" | "addItemVersion" | "updateItemFields"> = {
    loadItem: async (_c, _s, _id, language) => structuredClone(language === "en" ? english : local),
    validateAddItemVersion: async () => { validations++; },
    addItemVersion: async (_c, _s, args) => {
      strictEqual(checkpoints.at(-1)?.at(-1)?.status, "outcome-unknown");
      deepStrictEqual(args, { itemId: fieldId, language: "en-NZ" }); writes.push("version");
      local = { ...structuredClone(english), language: "en-NZ" }; return structuredClone(local);
    },
    updateItemFields: async (_c, _s, args) => {
      strictEqual(checkpoints.at(-1)?.at(-1)?.status, "outcome-unknown"); writes.push("update");
      strictEqual(args.itemId, fieldId); strictEqual(args.version, 1);
      deepStrictEqual(Object.keys(args.fields), ["Enable Shared Language Fallback", "Enable Language Fallback"]);
      if (failUpdate) { throw new Error("transport failed"); }
      local = { ...local, fields: local.fields.map(field => args.fields[field.name] === undefined ? field : { ...field, value: args.fields[field.name]! }) };
      return structuredClone(local);
    },
  };
  return { client, english, fields, checkpoints, writes, validations: () => validations,
    checkpoint: async (steps: readonly ScopeFixtureStep[]) => { checkpoints.push(structuredClone(steps) as ScopeFixtureStep[]); },
    setLocal: (change: Partial<AuthoringItemDetails>) => { local = { ...local, ...change }; },
    existing: () => { local = { ...structuredClone(english), language: "en-NZ" }; },
    fail: () => { failUpdate = true; } };
}

test("scope rules create only the missing metadata version then write exactly two checkboxes", async () => {
  const f = runtime();
  const plan = await prepareScopeRule(f.client, testConnection, "secret", fixture, input, signal);
  strictEqual(plan.createVersion, true); strictEqual(plan.previousLanguage, null); strictEqual(plan.previousShared, "1");
  deepStrictEqual(f.writes, []); strictEqual(f.validations(), 1);
  await executeScopeRule(f.client, testConnection, "secret", fixture, plan, f.checkpoint, signal);
  deepStrictEqual(f.writes, ["version", "update"]);
  deepStrictEqual(f.checkpoints.at(-1)?.map(step => step.status), ["version-created", "updated"]);
});

test("existing rule locale needs one write and stale snapshots stop before any write", async () => {
  const f = runtime(); f.existing();
  const plan = await prepareScopeRule(f.client, testConnection, "secret", fixture, input, signal);
  strictEqual(plan.createVersion, false); strictEqual(f.validations(), 0);
  await executeScopeRule(f.client, testConnection, "secret", fixture, plan, f.checkpoint, signal);
  deepStrictEqual(f.writes, ["update"]);
  const stale = runtime();
  const old = await prepareScopeRule(stale.client, testConnection, "secret", fixture, input, signal);
  stale.fields[3] = { ...stale.fields[3]!, value: "" };
  await rejects(executeScopeRule(stale.client, testConnection, "secret", fixture, old, stale.checkpoint, signal), /changed after preview/u);
  deepStrictEqual(stale.writes, []);
});

test("rule failures retain partial outcomes and do not retry", async () => {
  const f = runtime(); f.fail();
  const plan = await prepareScopeRule(f.client, testConnection, "secret", fixture, input, signal);
  await rejects(executeScopeRule(f.client, testConnection, "secret", fixture, plan, f.checkpoint, signal), /transport/u);
  deepStrictEqual(f.writes, ["version", "update"]);
  deepStrictEqual(f.checkpoints.at(-1)?.map(step => step.status), ["version-created", "outcome-unknown"]);
  const storage = runtime();
  const storagePlan = await prepareScopeRule(storage.client, testConnection, "secret", fixture, input, signal);
  await rejects(executeScopeRule(storage.client, testConnection, "secret", fixture, storagePlan,
    async () => { throw new Error("storage failed"); }, signal), /storage/u);
  deepStrictEqual(storage.writes, []);
  const controller = new AbortController();
  await rejects(executeScopeRule(storage.client, testConnection, "secret", fixture, storagePlan,
    async steps => { await storage.checkpoint(steps); controller.abort(); }, controller.signal));
  deepStrictEqual(storage.writes, []);
});

test("rule controls reject foreign identities, fields, locales, versions and malformed metadata", async () => {
  const f = runtime();
  for (const change of [
    { itemId: fixture.itemId }, { path: "/sitecore/templates/Real/Field" }, { language: "en-NZ" }, { version: 2 },
    { template: { templateId: fixture.templateId, name: "Other" } },
    { fields: [...f.english.fields, f.english.fields[3]!] },
    { fields: f.english.fields.map(field => field.name === "Enable Language Fallback" ? { ...field, scope: "SHARED" as const } : field) },
    { fields: f.english.fields.map(field => ({ ...field, containsFallbackValue: true })) },
    { fields: f.english.fields.map(field => field.name === "Enable Language Fallback" ? { ...field, value: "false" } : field) },
  ]) { await rejects(async () => assertScopeRuleDefinition(fixture, fieldId, { ...f.english, ...change }, "en")); }
  await rejects(prepareScopeRule(f.client, testConnection, "secret", fixture, { ...input, fieldId: fixture.itemId }, signal));
  await rejects(prepareScopeRule(f.client, testConnection, "secret", fixture, { ...input, language: "fr" }, signal));
  const shared = { ...fixture, fields: [{ fieldId, name: "FixtureShared", scope: "SHARED" as const }] };
  await rejects(prepareScopeRule(f.client, testConnection, "secret", shared, input, signal));
  f.setLocal({ availableVersions: [{ language: "en-NZ", version: 1 }] });
  await rejects(prepareScopeRule(f.client, testConnection, "secret", fixture, input, signal), /inconsistent/u);
  deepStrictEqual(f.writes, []);
});

test("rule readback mismatch remains an unknown write", async () => {
  const f = runtime(); f.existing();
  f.client.updateItemFields = async () => ({ ...structuredClone(f.english), language: "en-NZ" });
  const plan = await prepareScopeRule(f.client, testConnection, "secret", fixture, input, signal);
  await rejects(executeScopeRule(f.client, testConnection, "secret", fixture, plan, f.checkpoint, signal), /verification/u);
  strictEqual(f.checkpoints.at(-1)?.at(-1)?.status, "outcome-unknown");
});
