import { test } from "node:test";
import { strictEqual, deepStrictEqual, rejects, throws } from "node:assert/strict";
import { LayoutDiagnosticClient, deliveryEndpoint, type LayoutDiagnostic } from "../../src/sitecore/layoutDiagnostic";
import { compareLayouts, layoutEvidence } from "../../src/sitecore/layoutComparison";
import { SitecoreHttpClient } from "../../src/sitecore/sitecoreHttpClient";
import { QueuedHttpRuntime, noOpLogger, jsonResponse } from "./sitecoreClientTestHelpers";
const token = "edge-private-token";
const endpoint = "https://edge.example.test/api/graphql/v1";
const selection = { site: "Grenadier", route: "/page", language: "en-NZ" };
const signal = () => new AbortController().signal;
const rendered = (components: unknown[] = [{ uid: "a", componentName: "Form", dataSource: "ds", isContentResolved: false, fields: { title: "Title" } }]) => ({ sitecore: { route: { itemId: "page", fields: {}, placeholders: { main: components } } } });
const response = (value: unknown) => jsonResponse({ data: { layout: { item: { rendered: value } } } });
function fixture(value: Response, timeout = 30000) {
  const runtime = new QueuedHttpRuntime([value]);
  const client = new LayoutDiagnosticClient(new SitecoreHttpClient(noOpLogger, runtime), timeout);
  return { runtime, client, collect: () => client.collect("published-delivery", endpoint, token, selection, signal()) };
}
test("published layout preserves unresolved/absent evidence and pins one authenticated request", async () => {
  const f = fixture(response(JSON.stringify(rendered())));
  const result = await f.collect();
  deepStrictEqual(result.rendered, rendered());
  strictEqual(result.routePresence, "present"); strictEqual(result.graphql, "success");
  deepStrictEqual(layoutEvidence(result).resolution, { resolved: 0, unresolved: 1, unknown: 0 });
  strictEqual(f.runtime.requests.length, 1); strictEqual(f.runtime.requests[0].init.redirect, "error");
  strictEqual(new Headers(f.runtime.requests[0].init.headers).get("sc_apikey"), token);
  strictEqual(String(f.runtime.requests[0].input), endpoint);
  deepStrictEqual(JSON.parse(String(f.runtime.requests[0].init.body)).variables, selection);
  const unknown = layoutEvidence({ ...result, rendered: rendered([{ componentName: "unknown" }]) });
  strictEqual(unknown.resolution.unknown, 1);
});
test("route absence differs from HTTP failures and GraphQL partial/error results", async () => {
  const absent = await fixture(jsonResponse({ data: { layout: null } })).collect();
  strictEqual(absent.routePresence, "absent");
  const partial = await fixture(jsonResponse({ errors: [{ message: "Cannot resolve component" }], data: { layout: { item: { rendered: rendered() } } } })).collect();
  strictEqual(partial.httpStatus, 200); strictEqual(partial.graphql, "partial"); strictEqual(partial.routePresence, "present");
  const badQuery = await fixture(jsonResponse({ errors: [{ message: "Cannot query field" }] }, 400)).collect();
  strictEqual(badQuery.httpStatus, 400); strictEqual(badQuery.graphql, "errors");
  strictEqual(badQuery.errors[0].message, "Cannot query field");
  const errors = await fixture(jsonResponse({ errors: [{ message: "not available" }] })).collect();
  strictEqual(errors.graphql, "errors"); strictEqual(errors.routePresence, "unknown");
  for (const status of [401, 403, 429, 503, 302]) {
    const f = fixture(new Response(token, { status })); const report = await f.collect();
    strictEqual(report.httpStatus, status); strictEqual(report.routePresence, "unknown");
    strictEqual(f.runtime.requests.length, 1); strictEqual(f.runtime.waits.length, 0);
    strictEqual(JSON.stringify(report).includes(token), false);
  }
});
test("credential redaction covers decoded content and GraphQL error messages and never returns extensions", async () => {
  const f = fixture(jsonResponse({ errors: [{ message: token + " " + encodeURIComponent(token) + " Bearer secret https://example.test/?key=secret", extensions: { token } }], data: { layout: null } }));
  const report = await f.collect(); strictEqual(JSON.stringify(report).includes(token), false);
  strictEqual(JSON.stringify(report).includes("extensions"), false);
  const secret = await fixture(response(rendered([{ fields: { token } }]))).collect();
  strictEqual(secret.body, "credential-material"); strictEqual(secret.rendered, undefined);
});
test("streaming limits, invalid JSON, timeout and cancellation preserve bounded diagnostic outcomes", async () => {
  const oversize = fixture(new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(2 * 1024 * 1024)); c.enqueue(new Uint8Array(1)); c.close(); } })));
  strictEqual((await oversize.collect()).body, "too-large");
  strictEqual((await fixture(new Response("not json")).collect()).body, "invalid");
  const stalled = fixture(new Response(new ReadableStream({ start() {} })), 10);
  strictEqual((await stalled.collect()).transport, "timeout");
  const f = fixture(response(rendered()));
  const report = await f.client.collect("published-delivery", endpoint, token, selection, AbortSignal.abort());
  strictEqual(report.transport, "cancelled"); strictEqual(f.runtime.requests.length, 0);
  const controller = new AbortController();
  const active = fixture(new Response(new ReadableStream({ start() {} })));
  const pending = active.client.collect("published-delivery", endpoint, token, selection, controller.signal);
  setTimeout(() => controller.abort(), 10);
  strictEqual((await pending).transport, "cancelled");
});
test("configured delivery validation never accepts Preview endpoints, URL credentials or arbitrary query", async () => {
  for (const value of ["http://edge.test/api/graphql/v1", "https://a:b@edge.test/api/graphql/v1", "https://cm.test/sitecore/api/graph/edge", endpoint + "?token=x", endpoint + "#x"]) throws(() => deliveryEndpoint(value));
  const f = fixture(response(rendered()));
  await rejects(f.client.collect("published-delivery", endpoint, token, { ...selection, route: "bad" }, signal()));
  strictEqual(f.runtime.requests.length, 0);
});
test("comparison exposes field, placement, datasource and resolution differences with duplicate/missing UID ambiguity", async () => {
  const base = await fixture(response(rendered())).collect();
  const other = { ...base, endpointRole: "cm-preview" as const, rendered: { sitecore: { route: { itemId: "different", fields: { name: "x" }, placeholders: { other: [
    { uid: "a", componentName: "Different", dataSource: "other", isContentResolved: true, fields: {} },
    { uid: "duplicate" }, { uid: "duplicate" }, { componentName: "no id" }
  ] } } } } };
  const result = compareLayouts(other, base);
  deepStrictEqual(result.comparison.matches[0].differences, ["placement", "componentName", "dataSource", "isContentResolved", "fields"]);
  strictEqual(result.comparison.ambiguous.length, 3);
  strictEqual(result.comparison.routeDifferences?.includes("itemId"), true);
  strictEqual(result.preview, other); strictEqual(result.published, base);
  throws(() => compareLayouts({ ...other, selection: { ...selection, language: "en" } }, base));
  strictEqual(compareLayouts({ ...other, rendered: null }, base).comparison.status, "inconclusive");
  strictEqual(layoutEvidence({ ...base, rendered: rendered(Array.from({ length: 501 }, () => ({}))) }).limited, true);
});
test("network errors cannot expose raw errors or credentials", async () => {
  const runtime = new QueuedHttpRuntime([]);
  runtime.fetch = async () => { throw Error(token); };
  const report: LayoutDiagnostic = await new LayoutDiagnosticClient(new SitecoreHttpClient(noOpLogger, runtime)).collect("published-delivery", endpoint, token, selection, signal());
  strictEqual(report.transport, "network-error"); strictEqual(JSON.stringify(report).includes(token), false);
});
test("fixed rendering probe distinguishes schema support, missing item/field and a published ComponentQuery", async () => {
  const capability = { data: { __schema: { queryType: { fields: [{ name: "item" }] } }, __type: { fields: ["id", "path", "fields"].map(name => ({ name })) } } };
  for (const [item, expected] of [
    [null, "item-unavailable"],
    [{ id: "904D4725538E469B93174FA34C410316", path: "/sitecore/layout/Renderings/Test", fields: [] }, "field-unavailable"],
    [{ id: "904D4725538E469B93174FA34C410316", path: "/sitecore/layout/Renderings/Test", fields: [{ name: "ComponentQuery", value: "query { item { id } }" }] }, "published-value"],
    [{ id: "other", path: "/sitecore/layout/Renderings/Test", fields: [] }, "identity-mismatch"],
  ] as const) {
    const runtime = new QueuedHttpRuntime([jsonResponse(capability), jsonResponse({ data: { item } })]);
    const result = await new LayoutDiagnosticClient(new SitecoreHttpClient(noOpLogger, runtime)).inspectRendering(endpoint, token, "en", signal());
    strictEqual(result.status, expected); strictEqual(runtime.requests.length, 2);
    strictEqual(JSON.parse(String(runtime.requests[1].init.body)).variables.route, "904D4725-538E-469B-9317-4FA34C410316");
  }
  const runtime = new QueuedHttpRuntime([jsonResponse({ data: { __schema: { queryType: { fields: [] } }, __type: { fields: [] } } })]);
  strictEqual((await new LayoutDiagnosticClient(new SitecoreHttpClient(noOpLogger, runtime)).inspectRendering(endpoint, token, "en", signal())).status, "schema-unsupported");
  strictEqual(runtime.requests.length, 1);
});
