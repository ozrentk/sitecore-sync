import { test } from "node:test";
import { strictEqual, deepStrictEqual, rejects } from "node:assert/strict";
import { PreviewDiagnosticClient } from "../../src/sitecore/previewDiagnostic";
import { SitecoreHttpClient } from "../../src/sitecore/sitecoreHttpClient";
import { QueuedHttpRuntime, noOpLogger, jsonResponse } from "./sitecoreClientTestHelpers";
const selection = { site: "Example", route: "/page", language: "en-AU" };
const token = "separate-preview-token";
function fixture(response: Response) {
  const runtime = new QueuedHttpRuntime([response]);
  return { runtime, client: new PreviewDiagnosticClient(new SitecoreHttpClient(noOpLogger, runtime)) };
}
test("Preview diagnostic pins CM endpoint, uses separate token and preserves effective evidence", async () => {
  const rendered = { sitecore: { route: { itemLanguage: "en-AU", itemVersion: 1 } } };
  const { client, runtime } = fixture(jsonResponse({ data: { layout: { item: { rendered: JSON.stringify(rendered) } } } }));
  const result = await client.collect("https://cm.example.test", token, selection, new AbortController().signal) as Record<string, unknown>;
  deepStrictEqual(result.rendered, rendered); strictEqual(result.provenance, "unverified");
  strictEqual(String(runtime.requests[0].input), "https://cm.example.test/sitecore/api/graph/edge");
  strictEqual(runtime.requests[0].init.redirect, "error");
  strictEqual(new Headers(runtime.requests[0].init.headers).get("sc_apikey"), token);
  deepStrictEqual(JSON.parse(String(runtime.requests[0].init.body)).variables, selection);
  strictEqual(JSON.stringify(result).includes(token), false);
});
test("Preview rejects HTTP, partial GraphQL, invalid and oversized responses without retry or error leakage", async () => {
  for (const response of [jsonResponse({ secret: token }, 503), jsonResponse({ errors: [{ message: token }], data: {} }),
    new Response("not json"), new Response("x".repeat(2 * 1024 * 1024 + 1)),
    jsonResponse({ data: { layout: { item: { rendered: { leaked: token } } } } })]) {
    const { client, runtime } = fixture(response);
    await rejects(client.collect("https://cm.example.test", token, selection, new AbortController().signal), error => error instanceof Error && !error.message.includes(token));
    strictEqual(runtime.requests.length, 1); strictEqual(runtime.waits.length, 0);
  }
});
test("Preview null layout is unresolved; cancellation and invalid input do not issue requests", async () => {
  const { client, runtime } = fixture(jsonResponse({ data: { layout: null } }));
  await rejects(client.collect("https://cm.example.test", token, selection, AbortSignal.abort()), /cancelled/);
  await rejects(client.collect("https://cm.example.test", token, { ...selection, route: "bad" }, new AbortController().signal), /Invalid/);
  strictEqual(runtime.requests.length, 0);
  const result = await client.collect("https://cm.example.test", token, selection, new AbortController().signal) as Record<string, unknown>;
  strictEqual(result.status, "unresolved");
});
