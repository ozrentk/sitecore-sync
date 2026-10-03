import { deepStrictEqual, strictEqual, rejects } from "node:assert/strict";
import { test } from "node:test";
import { McpService, type McpOperation } from "../../src/mcp/service";
import { toolSchemas } from "../../src/mcp/tools";
import type { AuthoringItemDetails, AuthoringItemField } from "../../src/sitecore/authoringClient";
import { testConnection } from "./sitecoreClientTestHelpers";

const itemId = "00000000-0000-0000-0000-000000000001";
const fieldId = "00000000-0000-0000-0000-000000000002";
function fixture() {
  let details: AuthoringItemDetails = { itemId, name: "Test", displayName: "Test", path: "/sitecore/content/Test", language: "en", version: 1,
    hasChildren: false, template: { templateId: itemId, name: "Page" }, availableVersions: [{ language: "en", version: 1 }],
    fields: [{ fieldId, name: "Title", label: "Title", value: "old", type: "Single-Line Text", typeKey: "single-line text", scope: "VERSIONED",
      sortOrder: 0, sectionName: "Content", sectionSortOrder: 0, isStandardTemplate: false, containsFallbackValue: false,
      containsInheritedValue: false, containsStandardValue: false, textual: true }] };
  let records: McpOperation[] = []; let confirmed = true; let writes = 0; let reads = 0;
  let current = testConnection; let fail = false; let failSave = false;
  const service = new McpService({ get: id => id === current.id ? current : undefined,
    getClientSecret: async () => "private-credential", listVerifiedSites: () => [] }, {
    loadItem: async () => { reads++; return details; }, loadLanguages: async () => [{ name: "en", displayName: "English", englishName: "English", nativeName: "English" }],
    validateAddItemVersion: async () => { if (fail) { throw new Error("Unsupported contract"); } },
    addItemVersion: async () => {
      strictEqual(records.at(-1)?.status, "outcome-unknown"); writes++;
      if (fail) { throw new Error("private-credential raw server error"); }
      details = { ...details, version: 1 }; return details;
    },
    resetItemField: async () => {
      strictEqual(records.at(-1)?.status, "outcome-unknown"); writes++;
      if (fail) { throw new Error("private-credential raw server error"); }
      details = { ...details, fields: [{ ...details.fields[0]!, value: "Standard value", containsStandardValue: true }] }; return details;
    },
    searchItemsByName: async () => ({ items: [], hasMore: false, totalCount: 0 }),
    collectFallbackDiagnostic: async () => '{}',
    createItem: async (_connection, _secret, input) => {
      strictEqual(records.at(-1)?.status, "outcome-unknown"); writes++;
      if (fail) { throw new Error("private-credential raw server error"); }
      return { ...details, path: `/sitecore/content/Test/${input.name}` };
    },
    updateItemFields: async (_connection, _secret, input) => {
      strictEqual(records.at(-1)?.status, "outcome-unknown"); writes++;
      if (fail) { throw new Error("private-credential raw server error"); }
      details = { ...details, fields: [{ ...details.fields[0]!, value: input.fields.Title! }] }; return details;
    },
  }, [testConnection], { confirm: async () => confirmed, loadJournal: () => records,
    saveJournal: async value => { if (failSave) { throw new Error("storage failed"); } records = structuredClone(value) as McpOperation[]; } });
  const call = (name: string, input: unknown = {}) => service.call(name, input, new AbortController().signal);
  return { service, call, records: () => records, reads: () => reads, writes: () => writes,
    mutate: (change: Partial<AuthoringItemDetails>) => { details = { ...details, ...change }; },
    changeValue: (value: string) => { details = { ...details, fields: [{ ...details.fields[0]!, value }] }; },
    changeField: (change: Partial<AuthoringItemField>) => { details = { ...details, fields: [{ ...details.fields[0]!, ...change }] }; },
    duplicateFieldName: () => { details = { ...details, fields: [...details.fields, { ...details.fields[0]!, fieldId: itemId }] }; },
    decline: () => { confirmed = false; }, fail: () => { fail = true; }, failSave: () => { failSave = true; },
    changeConnection: () => { current = { ...current, serverUrl: "https://other.example.test" }; } };
}
const update = { connectionId: testConnection.id, item: itemId, language: "en", version: 1, fieldId, value: "new" };
async function preview(f: ReturnType<typeof fixture>): Promise<string> {
  return (await f.call("preview_field_update", update) as { planId: string }).planId;
}

test("MCP validates tool inputs and exposes only safe connection metadata", async () => {
  const f = fixture();
  const connections = await f.call("list_connections");
  strictEqual(JSON.stringify(connections).includes("clientId"), false);
  await rejects(f.call("read_item", { connectionId: "other", item: itemId, language: "en" }), /not exposed/u);
  await rejects(f.call("read_item", { ...update, item: "https://example.test" }), /Invalid/u);
  await rejects(f.call("__proto__"), /Unknown/u);
  strictEqual(f.reads(), 0);
  strictEqual(toolSchemas.preview_field_update.safeParse({ ...update, version: 0 }).success, false);
  strictEqual(toolSchemas.preview_fallback_test_items.safeParse({ connectionId: testConnection.id, parent: itemId, example: itemId, fieldId, languages: ["en", "EN"] }).success, false);
  f.changeConnection(); await rejects(f.call("read_item", { connectionId: testConnection.id, item: itemId, language: "en" }), /changed/u);
});
test("MCP field update requires opt-in and confirmation, verifies state, journals and refuses replay", async () => {
  const f = fixture(); const planId = await preview(f);
  await rejects(f.call("execute_plan", { planId }), /Enable MCP Mutations/u); strictEqual(f.writes(), 0);
  f.service.enableMutations(testConnection.id);
  const result = await f.call("execute_plan", { planId }) as McpOperation;
  strictEqual(result.status, "completed"); strictEqual(f.writes(), 1);
  await rejects(f.call("execute_plan", { planId }), /already used/u);
  strictEqual(JSON.stringify(f.records()).includes('"new"'), false);
});
test("MCP cancelled, stale, missing-version and persistence failures cannot send writes", async () => {
  const declined = fixture(); const id = await preview(declined); declined.service.enableMutations(testConnection.id); declined.decline();
  await rejects(declined.call("execute_plan", { planId: id }), /cancelled/u); strictEqual(declined.writes(), 0);
  const stale = fixture(); const staleId = await preview(stale); stale.service.enableMutations(testConnection.id); stale.changeValue("concurrent edit");
  await rejects(stale.call("execute_plan", { planId: staleId }), /changed after preview/u); strictEqual(stale.writes(), 0);
  strictEqual(stale.records()[0]!.status, "stopped");
  const storage = fixture(); const storageId = await preview(storage); storage.service.enableMutations(testConnection.id); storage.failSave();
  await rejects(storage.call("execute_plan", { planId: storageId })); strictEqual(storage.writes(), 0);
  const missing = fixture(); missing.mutate({ version: 0 }); await rejects(preview(missing), /existing local version/u);
});
test("MCP write failure preserves unknown outcome and never exposes server errors", async () => {
  const f = fixture(); const planId = await preview(f); f.service.enableMutations(testConnection.id); f.fail();
  await rejects(f.call("execute_plan", { planId }), error => error instanceof Error && /Inspect list_operations/u.test(error.message) && !error.message.includes("private-credential"));
  strictEqual(f.writes(), 1); strictEqual(f.records()[0]!.status, "outcome-unknown");
  deepStrictEqual(await f.call("list_operations"), f.records());
});
test("MCP creates the four controlled fixtures and retains confirmed IDs", async () => {
  const f = fixture();
  const result = await f.call("preview_fallback_test_items", { connectionId: testConnection.id, parent: "/sitecore/content/Test", example: itemId, fieldId, languages: ["en-NZ", "en-AU", "en"] }) as { planId: string };
  strictEqual(f.writes(), 0); f.service.enableMutations(testConnection.id);
  await f.call("execute_plan", { planId: result.planId });
  strictEqual(f.writes(), 4); strictEqual(f.records()[0]!.targets.every(target => target.status === "created" && target.itemId), true);
});
test("MCP stop aborts access and exact reads redact known credentials", async () => {
  const f = fixture(); f.changeValue("private-credential");
  const result = await f.call("read_item", { connectionId: testConnection.id, item: itemId, language: "en" });
  strictEqual(JSON.stringify(result).includes("private-credential"), false);
  await rejects(f.service.call("list_connections", {}, AbortSignal.abort()));
  f.service.dispose(); await rejects(f.call("list_connections"));
});

test("MCP refuses shared, system, fallback-derived and ambiguous-name field updates", async () => {
  for (const change of [{ scope: "SHARED" as const }, { name: "__Renderings" }, { containsFallbackValue: true }, { isStandardTemplate: true }]) {
    const f = fixture(); f.changeField(change); await rejects(preview(f), /cannot be changed/u); strictEqual(f.writes(), 0);
  }
  const duplicate = fixture(); duplicate.duplicateFieldName(); await rejects(preview(duplicate), /cannot be changed/u);
});

test("MCP expires plans and bounds pending previews", async context => {
  let now = 1000; context.mock.method(Date, "now", () => now);
  const f = fixture(); const planId = await preview(f); f.service.enableMutations(testConnection.id);
  now += 600001; await rejects(f.call("execute_plan", { planId }), /expired/u); strictEqual(f.writes(), 0);
  for (let index = 0; index < 20; index++) { await preview(f); }
  await rejects(preview(f), /Too many/u);
});


test("MCP reset is distinct from literal empty and accepts a nonempty Standard Value", async () => {
  const f = fixture();
  const { value: _value, ...input } = update;
  const plan = await f.call("preview_field_reset", input) as { planId: string };
  strictEqual(f.writes(), 0);
  await rejects(f.call("execute_plan", { planId: plan.planId }), /Enable MCP Mutations/u);
  f.service.enableMutations(testConnection.id);
  const result = await f.call("execute_plan", { planId: plan.planId }) as McpOperation;
  strictEqual(result.status, "completed"); strictEqual(result.targets[0]!.status, "reset");
  strictEqual(f.writes(), 1);
  await rejects(f.call("execute_plan", { planId: plan.planId }), /already used/u);
});

test("MCP first-version creation requires a missing configured locale, rechecks state and journals", async () => {
  const input = { connectionId: testConnection.id, item: itemId, language: "en" };
  const f = fixture();
  await rejects(f.call("preview_language_version", input), /no existing local version/u);
  f.mutate({ version: 0, fields: [], availableVersions: [] });
  await rejects(f.call("preview_language_version", { ...input, language: "fr" }), /no existing local version/u);
  const plan = await f.call("preview_language_version", input) as { planId: string };
  strictEqual(f.writes(), 0); f.service.enableMutations(testConnection.id);
  const result = await f.call("execute_plan", { planId: plan.planId }) as McpOperation;
  strictEqual(result.status, "completed"); strictEqual(result.targets[0]!.version, 1);
  strictEqual(result.targets[0]!.status, "version-created"); strictEqual(f.writes(), 1);
  const stale = fixture(); stale.mutate({ version: 0, fields: [], availableVersions: [] });
  const stalePlan = await stale.call("preview_language_version", input) as { planId: string };
  stale.service.enableMutations(testConnection.id); stale.mutate({ path: "/sitecore/content/Moved" });
  await rejects(stale.call("execute_plan", { planId: stalePlan.planId }), /changed after preview/u);
  strictEqual(stale.writes(), 0);
});

test("MCP reset and version-creation failures retain unknown outcomes without retry", async () => {
  for (const name of ["preview_field_reset", "preview_language_version"]) {
    const f = fixture(); const { value: _value, ...reset } = update;
    if (name === "preview_language_version") { f.mutate({ version: 0, fields: [], availableVersions: [] }); }
    const input = name === "preview_field_reset" ? reset : { connectionId: testConnection.id, item: itemId, language: "en" };
    const plan = await f.call(name, input) as { planId: string };
    f.service.enableMutations(testConnection.id); f.fail();
    await rejects(f.call("execute_plan", { planId: plan.planId }), /Inspect list_operations/u);
    strictEqual(f.records()[0]!.status, "outcome-unknown"); strictEqual(f.writes(), 1);
  }
});
