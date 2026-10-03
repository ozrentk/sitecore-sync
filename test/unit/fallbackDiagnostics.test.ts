import { deepStrictEqual, strictEqual, rejects } from "node:assert/strict";
import { test } from "node:test";
import { Kind, parse } from "graphql";
import { buildFallbackProbes, collectFallbackDiagnostic, serializeFallbackDiagnostic } from "../../src/sitecore/fallbackDiagnostics";
import { AuthoringContentClient } from "../../src/sitecore/authoringClient";
import { jsonResponse, noOpLogger, QueuedHttpRuntime, requestBody, testConnection, tokenResponse } from "./sitecoreClientTestHelpers";

const id = "00000000-0000-0000-0000-000000000001";
const probes = buildFallbackProbes(id, ["en-NZ", "en"]);
const schema = { data: { __schema: { types: [] } } };
const page = (more = false, cursor = "next") => ({ data: { item: { version: 0, fields: { nodes: [{ value: "", containsFallbackValue: null }], pageInfo: { hasNextPage: more, endCursor: cursor } } } } });
const signal = new AbortController().signal;
interface TestReport {
  schema: { status: string };
  observations: { status: string; outcome?: string; pages: { data: { item: null | { fields: { nodes: Record<string, unknown>[] } } } }[] }[];
}
const asJson = (report: unknown): TestReport => JSON.parse(JSON.stringify(report)) as TestReport;

test("version-zero null fields are preserved as no-local-fields, not a malformed response", async () => {
  const report = asJson(await collectFallbackDiagnostic(probes.slice(0, 1), async op => op === "IntrospectionQuery" ? schema
    : { data: { item: { version: 0, language: { name: "en-NZ" }, fields: null } } }, signal));
  strictEqual(report.observations[0].status, "complete");
  strictEqual(report.observations[0].outcome, "no-local-fields");
  strictEqual(report.observations[0].pages[0].data.item!.fields, null);
});

test("diagnostic preserves raw missing/null provenance and paginates each exact and cross-check read", async () => {
  const calls: Readonly<Record<string, unknown>>[] = [];
  const responses = [schema, page(true), page(), { data: { item: null } }, page()];
  const report = asJson(await collectFallbackDiagnostic(probes, async (_op, _query, variables) => {
    calls.push(variables); return responses.shift();
  }, signal));
  strictEqual(report.schema.status, "complete");
  deepStrictEqual(report.observations.map((entry: { status: string }) => entry.status), ["complete", "complete", "complete"]);
  strictEqual(calls[2]?.after, "next");
  strictEqual(calls[3]?.after, null);
  strictEqual(report.observations[0].pages[0].data.item!.fields.nodes[0].containsFallbackValue, null);
  strictEqual("containsInheritedValue" in report.observations[0].pages[0].data.item!.fields.nodes[0], false);
  strictEqual(report.observations[1].pages[0].data.item, null);
});

test("schema failure does not prevent probes; failed reads never masquerade as absent items", async () => {
  let calls = 0;
  const report = asJson(await collectFallbackDiagnostic(probes.slice(0, 1), async () => {
    calls++; throw new Error("private server detail");
  }, signal));
  strictEqual(calls, 2);
  strictEqual(report.schema.status, "unavailable");
  strictEqual(report.observations[0].status, "unavailable");
  strictEqual(JSON.stringify(report).includes("private server detail"), false);
});

test("malformed pages, repeated cursors and byte/page limits are explicitly incomplete", async () => {
  for (const [response, expected] of [
    [{ data: {} }, "invalid-response"],
    [{ data: { item: { fields: null } } }, "invalid-response"],
    [page(true), "invalid-response"],
    [{ data: { item: { value: "x".repeat(6 * 1024 * 1024) } } }, "limit-reached"],
  ] as const) {
    const report = asJson(await collectFallbackDiagnostic(probes.slice(0, 1), async op => op === "IntrospectionQuery" ? schema : response, signal));
    strictEqual(report.observations[0].status, expected);
  }
  let cursor = 0;
  const report = asJson(await collectFallbackDiagnostic(probes.slice(0, 1), async op => op === "IntrospectionQuery" ? schema : page(true, String(cursor++)), signal));
  strictEqual(report.observations[0].pages.length, 50);
  strictEqual(report.observations[0].status, "limit-reached");
});

test("diagnostic cancels before requests and after a request that ignores cancellation", async () => {
  let calls = 0;
  await rejects(collectFallbackDiagnostic(probes, async () => { calls++; }, AbortSignal.abort()), { name: "AbortError" });
  strictEqual(calls, 0);
  const controller = new AbortController();
  await rejects(collectFallbackDiagnostic(probes, async () => { controller.abort(); return schema; }, controller.signal), { name: "AbortError" });
});

test("diagnostic client uses existing authentication, fixed queries and strips known credentials from report", async () => {
  const runtime = new QueuedHttpRuntime([tokenResponse(), jsonResponse(schema),
    jsonResponse({ data: { item: null } }), jsonResponse({ data: { item: { fields: { nodes: [{ value: "client-secret access-token" }], pageInfo: { hasNextPage: false } } } } }),
    jsonResponse({ data: { item: null } })]);
  const client = new AuthoringContentClient(noOpLogger, runtime);
  const text = await client.collectFallbackDiagnostic(testConnection, "client-secret", { itemId: id, languages: ["en"] }, signal);
  strictEqual(text.includes("client-secret"), false);
  strictEqual(text.includes("access-token"), false);
  for (let i = 1; i < runtime.requests.length; i++) {
    strictEqual(String(runtime.requests[i]!.input), "https://cm.example.com/sitecore/api/authoring/graphql/v1/");
    const operations = parse(requestBody(runtime, i).query as string).definitions.filter(definition => definition.kind === Kind.OPERATION_DEFINITION);
    deepStrictEqual(operations.map(operation => operation.operation), ["query"]);
  }
  strictEqual((requestBody(runtime, 2).query as string).includes("withLanguageFallback: false"), true);
  strictEqual((requestBody(runtime, 3).query as string).includes("withLanguageFallback: true"), true);
  strictEqual((requestBody(runtime, 4).query as string).includes("withLanguageFallback: false"), true);
  deepStrictEqual((requestBody(runtime, 4).variables as { where: unknown }).where,
    { database: "master", language: "en", path: "/sitecore/system/Languages/en" });
  deepStrictEqual(JSON.parse(serializeFallbackDiagnostic({ value: 'a"b\nc' }, ['a"b\nc'])), { value: "[REDACTED]" });
  deepStrictEqual(JSON.parse(serializeFallbackDiagnostic({ ":": ":" }, [":"])), { "[REDACTED]": "[REDACTED]" });
});

test("diagnostic validates inputs before authentication and supports schema-only requests", async () => {
  const runtime = new QueuedHttpRuntime([tokenResponse(), jsonResponse(schema)]);
  const client = new AuthoringContentClient(noOpLogger, runtime);
  await rejects(client.collectFallbackDiagnostic(testConnection, "test-secret", { itemId: "invalid", languages: ["en"] }, signal));
  strictEqual(runtime.requests.length, 0);
  const report = JSON.parse(await client.collectFallbackDiagnostic(testConnection, "test-secret", undefined, signal));
  strictEqual(report.observations.length, 0);
  strictEqual(runtime.requests.length, 2);
});
