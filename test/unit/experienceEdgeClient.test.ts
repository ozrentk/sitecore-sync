import {
  deepStrictEqual,
  match,
  rejects,
  strictEqual,
} from "node:assert/strict";
import { test } from "node:test";
import { ExperienceEdgeClient } from "../../src/sitecore/experienceEdgeClient";
import {
  jsonResponse,
  noOpLogger,
  QueuedHttpRuntime,
  requestBody,
} from "./sitecoreClientTestHelpers";

const endpoint = "https://edge.example.com/api/graphql/v1";
const token = "edge-token";
const signal = new AbortController().signal;

test("item constructs the Edge query and filters malformed optional fields", async () => {
  const runtime = new QueuedHttpRuntime([jsonResponse({
    data: {
      item: {
        id: "item-id",
        name: "Home",
        path: "/sitecore/content/Home",
        fields: [
          { name: "Title", value: "Welcome" },
          { name: "Count", value: 42 },
          { name: 42, value: "ignored" },
          null,
        ],
      },
    },
  })]);
  const client = new ExperienceEdgeClient(noOpLogger, runtime);

  deepStrictEqual(
    await client.item(endpoint, token, "item-id", "en", signal),
    {
      id: "item-id",
      name: "Home",
      path: "/sitecore/content/Home",
      fields: { Title: "Welcome" },
    },
  );
  strictEqual(runtime.requests.length, 1);
  strictEqual(runtime.requests[0]?.input.toString(), endpoint);
  strictEqual(runtime.requests[0]?.init.method, "POST");
  strictEqual(runtime.requests[0]?.init.signal, signal);
  const headers = new Headers(runtime.requests[0]?.init.headers);
  strictEqual(headers.get("content-type"), "application/json");
  strictEqual(headers.get("sc_apikey"), token);
  const body = requestBody(runtime, 0);
  deepStrictEqual(body.variables, { path: "item-id", language: "en" });
  strictEqual(typeof body.query, "string");
  match(body.query as string, /query XmCloudSyncEdgeItem/u);
});

test("item returns undefined for a missing item and rejects malformed items", async () => {
  const missingRuntime = new QueuedHttpRuntime([
    jsonResponse({ data: { item: null } }),
  ]);
  strictEqual(
    await new ExperienceEdgeClient(noOpLogger, missingRuntime).item(
      endpoint,
      token,
      "missing",
      "en",
      signal,
    ),
    undefined,
  );

  for (const item of [
    { id: 42, name: "Home", path: "/sitecore/content/Home", fields: [] },
    { id: "item-id", name: 42, path: "/sitecore/content/Home", fields: [] },
    { id: "item-id", name: "Home", path: 42, fields: [] },
  ]) {
    const runtime = new QueuedHttpRuntime([jsonResponse({ data: { item } })]);
    await rejects(
      new ExperienceEdgeClient(noOpLogger, runtime).item(
        endpoint,
        token,
        "item-id",
        "en",
        signal,
      ),
      /Experience Edge returned an invalid item/u,
    );
  }
});

test("renderedLayout preserves strings, serializes objects, and accepts absent layout", async () => {
  const runtime = new QueuedHttpRuntime([
    jsonResponse({ data: { layout: { item: { id: "route-id", rendered: "serialized" } } } }),
    jsonResponse({ data: { layout: { item: { id: 42, rendered: { sitecore: { route: true } } } } } }),
    jsonResponse({ data: { layout: { item: { id: "empty", rendered: "" } } } }),
    jsonResponse({ data: { layout: null } }),
  ]);
  const client = new ExperienceEdgeClient(noOpLogger, runtime);

  deepStrictEqual(
    await client.renderedLayout(endpoint, token, "website", "/home", "en", signal),
    { itemId: "route-id", rendered: "serialized" },
  );
  deepStrictEqual(
    await client.renderedLayout(endpoint, token, "website", "/object", "en", signal),
    { itemId: undefined, rendered: JSON.stringify({ sitecore: { route: true } }) },
  );
  strictEqual(
    await client.renderedLayout(endpoint, token, "website", "/empty", "en", signal),
    undefined,
  );
  strictEqual(
    await client.renderedLayout(endpoint, token, "website", "/missing", "en", signal),
    undefined,
  );
  deepStrictEqual(requestBody(runtime, 0).variables, {
    site: "website",
    route: "/home",
    language: "en",
  });
});

test("listSites parses optional metadata and filters malformed entries", async () => {
  const runtime = new QueuedHttpRuntime([
    jsonResponse({
      data: {
        site: {
          allSiteInfo: {
            results: [
              { name: "website", hostname: "www.example.com", rootPath: "/sitecore/content/Tenant/Site" },
              { name: "minimal", hostname: 42, rootPath: null },
              { name: 42, hostname: "ignored.example.com" },
              null,
            ],
          },
        },
      },
    }),
    jsonResponse({ data: {} }),
  ]);
  const client = new ExperienceEdgeClient(noOpLogger, runtime);

  deepStrictEqual(await client.listSites(endpoint, token, signal), [
    {
      name: "website",
      hostname: "www.example.com",
      rootPath: "/sitecore/content/Tenant/Site",
    },
    { name: "minimal", hostname: undefined, rootPath: undefined },
  ]);
  deepStrictEqual(requestBody(runtime, 0).variables, {});
  deepStrictEqual(await client.listSites(endpoint, token, signal), []);
});

test("Edge queries reject malformed item and site collections", async () => {
  const invalidItemRuntime = new QueuedHttpRuntime([jsonResponse({
    data: {
      item: {
        id: "item-id",
        name: "Home",
        path: "/sitecore/content/Home",
        fields: {},
      },
    },
  })]);
  await rejects(
    new ExperienceEdgeClient(noOpLogger, invalidItemRuntime).item(
      endpoint,
      token,
      "item-id",
      "en",
      signal,
    ),
    /Experience Edge returned an invalid item/u,
  );

  const invalidSitesRuntime = new QueuedHttpRuntime([jsonResponse({
    data: { site: { allSiteInfo: { results: {} } } },
  })]);
  await rejects(
    new ExperienceEdgeClient(noOpLogger, invalidSitesRuntime).listSites(endpoint, token, signal),
    /Experience Edge returned an invalid site list/u,
  );
});

test("Edge queries surface GraphQL errors and validate response envelopes", async () => {
  for (const [response, expected] of [
    [jsonResponse({ errors: [{ message: "First" }, null, { message: "Second" }] }), /First; Second/u],
    [jsonResponse({ errors: [{ message: 42 }] }), /returned a GraphQL error/u],
    [jsonResponse({ errors: {} }), /returned an invalid response/u],
    [jsonResponse(null), /returned an invalid response/u],
    [new Response("not json", { status: 200 }), /returned invalid JSON/u],
    [jsonResponse({ data: {} }, 403), /failed \(403\)/u],
  ] as const) {
    const runtime = new QueuedHttpRuntime([response]);
    await rejects(
      new ExperienceEdgeClient(noOpLogger, runtime).item(
        endpoint,
        token,
        "item-id",
        "en",
        signal,
      ),
      expected,
    );
  }
});

test("probeApplication constructs a public request and retains only diagnostic headers", async () => {
  const body = "x".repeat(5_000_010);
  const runtime = new QueuedHttpRuntime([new Response(body, {
    status: 206,
    headers: {
      age: "12",
      "cache-control": "public, max-age=60",
      "content-type": "text/html; charset=utf-8",
      "set-cookie": "secret=value",
      "x-vercel-cache": "HIT",
      "x-vercel-id": "fra1::example",
      "x-unrelated": "ignored",
    },
  })]);
  const client = new ExperienceEdgeClient(noOpLogger, runtime);

  const result = await client.probeApplication("https://www.example.com/page", signal);

  strictEqual(result.status, 206);
  strictEqual(result.body.length, 5_000_000);
  strictEqual(result.body, body.slice(0, 5_000_000));
  deepStrictEqual(result.headers, {
    age: "12",
    "cache-control": "public, max-age=60",
    "x-vercel-cache": "HIT",
    "x-vercel-id": "fra1::example",
    "content-type": "text/html; charset=utf-8",
  });
  strictEqual(runtime.requests[0]?.input.toString(), "https://www.example.com/page");
  strictEqual(runtime.requests[0]?.init.method, "GET");
  strictEqual(runtime.requests[0]?.init.signal, signal);
  const headers = new Headers(runtime.requests[0]?.init.headers);
  strictEqual(headers.get("accept"), "text/html,application/xhtml+xml,application/json");
  strictEqual(headers.get("cache-control"), "no-cache");
  strictEqual(headers.has("sc_apikey"), false);
});
