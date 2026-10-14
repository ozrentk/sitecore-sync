import { deepStrictEqual, match, rejects, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { AuthoringContentClient, AuthoringItemNotFoundError } from "../../src/sitecore/authoringClient";
import {
  jsonResponse,
  noOpLogger,
  QueuedHttpRuntime,
  requestBody,
  testConnection,
  tokenResponse,
} from "./sitecoreClientTestHelpers";

const signal = new AbortController().signal;

test("comparison fallback is opt-in for both field queries and preserves requested locale and version zero", async () => {
  for (const fallback of [false, true]) {
    const runtime = new QueuedHttpRuntime([tokenResponse(), jsonResponse({ data: { item: {
      itemId: "item-id", name: "Home", path: "/sitecore/Home", language: { name: "en-NZ" }, version: 0,
      template: { templateId: "template", name: "Page" }, fields: null,
    } } }), jsonResponse({ data: { item: { fields: null } } })]);
    const item = await new AuthoringContentClient(noOpLogger, runtime)
      .loadItemDetails(testConnection, "secret", "item-id", "en-NZ", signal, fallback);
    strictEqual(item.version, 0);
    for (const index of [1, 2]) {
      const request = requestBody(runtime, index);
      match(String(request.query), new RegExp(`withLanguageFallback: ${fallback}`));
      deepStrictEqual((request.variables as { where: unknown }).where, { database: "master", itemId: "item-id", language: "en-NZ" });
    }
  }
});

test("fallback field reads reject outer locale and identity mismatches", async () => {
  for (const wrong of [{ itemId: "wrong", language: { name: "en-NZ" } }, { itemId: "item-id", language: { name: "en" } }]) {
    const runtime = new QueuedHttpRuntime([tokenResponse(), jsonResponse({ data: { item: {
      ...wrong, version: 1, fields: { nodes: [], pageInfo: { hasNextPage: false } },
    } } }), jsonResponse({ data: { item: { fields: null } } })]);
    await rejects(new AuthoringContentClient(noOpLogger, runtime)
      .loadItemDetails(testConnection, "secret", "item-id", "en-NZ", signal, true), /different item, locale or version/u);
  }
});

test("fallback pagination preserves its policy and rejects numbered-version drift", async () => {
  for (const nextVersion of [1, 2]) {
    const page = (version: number, more: boolean) => jsonResponse({ data: { item: {
      itemId: "item-id", name: "Home", path: "/sitecore/Home", language: { name: "en-NZ" }, version,
      template: { templateId: "template", name: "Page" },
      fields: { nodes: [], pageInfo: { hasNextPage: more, endCursor: more ? "next" : null } },
    } } });
    const runtime = new QueuedHttpRuntime([tokenResponse(), page(1, true),
      jsonResponse({ data: { item: { fields: null } } }), page(nextVersion, false)]);
    const read = new AuthoringContentClient(noOpLogger, runtime)
      .loadItemDetails(testConnection, "secret", "item-id", "en-NZ", signal, true);
    if (nextVersion === 2) await rejects(read, /different item, locale or version/u);
    else strictEqual((await read).version, 1);
    match(String(requestBody(runtime, 3).query), /withLanguageFallback: true/u);
    strictEqual((requestBody(runtime, 3).variables as { after: string }).after, "next");
  }
});

function treeItem(itemId: string, name: string, path: string) {
  return { itemId, name, displayName: `${name} display`, path, hasChildren: true };
}

test("loadTreeLevel parses paged items and sends the returned cursor", async () => {
  const root = treeItem("root-id", "Root", "/sitecore/content/Root");
  const firstChild = treeItem("child-1", "First", "/sitecore/content/Root/First");
  const secondChild = treeItem("child-2", "Second", "/sitecore/content/Root/Second");
  const runtime = new QueuedHttpRuntime([
    tokenResponse(),
    jsonResponse({
      data: { item: { ...root, children: { nodes: [firstChild], pageInfo: { hasNextPage: true, endCursor: "cursor-1" } } } },
    }),
    jsonResponse({
      data: { item: { ...root, children: { nodes: [secondChild], pageInfo: { hasNextPage: false, endCursor: null } } } },
    }),
  ]);
  const client = new AuthoringContentClient(noOpLogger, runtime);

  const level = await client.loadTreeLevel(
    testConnection,
    "client-secret",
    { path: root.path },
    "en",
    signal,
  );

  strictEqual(level.item.itemId, "root-id");
  deepStrictEqual(level.children.map((item) => item.itemId), ["child-1", "child-2"]);
  const secondVariables = requestBody(runtime, 2).variables as Record<string, unknown>;
  strictEqual(secondVariables.after, "cursor-1");
});

test("loadTreeLevel rejects invalid items and broken pagination", async () => {
  const root = treeItem("root-id", "Root", "/sitecore/content/Root");
  for (const payload of [
    { data: { item: { ...root, itemId: 42, children: { nodes: [] } } } },
    { data: { item: { ...root, children: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } } } },
  ]) {
    const runtime = new QueuedHttpRuntime([tokenResponse(), jsonResponse(payload)]);
    const client = new AuthoringContentClient(noOpLogger, runtime);
    await rejects(
      client.loadTreeLevel(testConnection, "client-secret", { itemId: "root-id" }, "en", signal),
      /invalid content-tree item|another children page without a cursor/u,
    );
  }
});

test("loadTreeLevel rejects a repeated pagination cursor", async () => {
  const root = treeItem("root-id", "Root", "/sitecore/content/Root");
  const page = {
    data: { item: { ...root, children: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "same" } } } },
  };
  const runtime = new QueuedHttpRuntime([tokenResponse(), jsonResponse(page), jsonResponse(page)]);
  const client = new AuthoringContentClient(noOpLogger, runtime);

  await rejects(
    client.loadTreeLevel(testConnection, "client-secret", { itemId: "root-id" }, "en", signal),
    /same children-page cursor twice/u,
  );
});

test("loadLanguages applies fallbacks, de-duplicates, sorts, and validates names", async () => {
  const runtime = new QueuedHttpRuntime([
    tokenResponse(),
    jsonResponse({
      data: {
        languages: {
          nodes: [
            { name: "fr", displayName: "French", englishName: "French", nativeName: "Français" },
            { name: "EN", displayName: null },
            { name: "en", displayName: "English" },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    }),
  ]);
  const client = new AuthoringContentClient(noOpLogger, runtime);

  deepStrictEqual(await client.loadLanguages(testConnection, "client-secret", signal), [
    { name: "en", displayName: "English", englishName: "en", nativeName: "en" },
    { name: "fr", displayName: "French", englishName: "French", nativeName: "Français" },
  ]);

  const invalidRuntime = new QueuedHttpRuntime([
    tokenResponse(),
    jsonResponse({ data: { languages: { nodes: [{ name: 42 }] } } }),
  ]);
  await rejects(
    new AuthoringContentClient(noOpLogger, invalidRuntime).loadLanguages(
      testConnection,
      "client-secret",
      signal,
    ),
    /returned an invalid language/u,
  );
});

test("loadItemIconReferences resolves item icons before deduplicated template fallbacks", async () => {
  const runtime = new QueuedHttpRuntime([
    tokenResponse(),
    jsonResponse({
      data: {
        item0: {
          itemId: "{ITEM-ONE}",
          icon: { value: " Network/16x16/home.png " },
          template: { templateId: "template-one" },
        },
        item1: {
          itemId: "item-two",
          icon: null,
          template: { templateId: "{SHARED-TEMPLATE}" },
        },
        item2: {
          itemId: "item-three",
          icon: { value: "" },
          template: { templateId: "shared-template" },
        },
      },
    }),
    jsonResponse({
      data: {
        template0: {
          itemId: "shared-template",
          icon: { value: " Office/16x16/document.png " },
        },
      },
    }),
  ]);
  const client = new AuthoringContentClient(noOpLogger, runtime);

  deepStrictEqual(
    await client.loadItemIconReferences(
      testConnection,
      "client-secret",
      ["{ITEM-ONE}", "item-two", "item-three", "item-two"],
      "de",
      signal,
    ),
    [
      { itemId: "{ITEM-ONE}", configuredIcon: "Network/16x16/home.png" },
      { itemId: "item-two", configuredIcon: "Office/16x16/document.png" },
      { itemId: "item-three", configuredIcon: "Office/16x16/document.png" },
    ],
  );
  const body = requestBody(runtime, 1);
  strictEqual(body.operationName, "XmCloudSyncItemIcons");
  match(String(body.query), /item0: item\(where: \$where0\)/u);
  match(String(body.query), /template \{ templateId \}/u);
  deepStrictEqual(body.variables, {
    where0: { database: "master", language: "de", itemId: "{ITEM-ONE}" },
    where1: { database: "master", language: "de", itemId: "item-two" },
    where2: { database: "master", language: "de", itemId: "item-three" },
  });
  const templateBody = requestBody(runtime, 2);
  strictEqual(templateBody.operationName, "XmCloudSyncTemplateIcons");
  match(String(templateBody.query), /template0: item\(where: \$where0\)/u);
  deepStrictEqual(templateBody.variables, {
    where0: { database: "master", itemId: "{SHARED-TEMPLATE}" },
  });
});

test("loadItemIconReferences isolates optional icon failures from tree loading", async () => {
  const invalidRuntime = new QueuedHttpRuntime([
    tokenResponse(),
    jsonResponse({ data: { item0: { itemId: "other-item", icon: { value: 42 } } } }),
  ]);
  await rejects(
    new AuthoringContentClient(noOpLogger, invalidRuntime).loadItemIconReferences(
      testConnection,
      "client-secret",
      ["expected-item"],
      "en",
      signal,
    ),
    /invalid item icon data/u,
  );

  const missingRuntime = new QueuedHttpRuntime([
    tokenResponse(),
    jsonResponse({ data: { item0: null } }),
  ]);
  deepStrictEqual(
    await new AuthoringContentClient(noOpLogger, missingRuntime).loadItemIconReferences(
      testConnection,
      "client-secret",
      ["missing-item"],
      "en",
      signal,
    ),
    [{ itemId: "missing-item" }],
  );

  const missingTemplateIconRuntime = new QueuedHttpRuntime([
    tokenResponse(),
    jsonResponse({
      data: {
        item0: {
          itemId: "expected-item",
          icon: null,
          template: { templateId: "template-id" },
        },
      },
    }),
    jsonResponse({ data: { template0: null } }),
  ]);
  deepStrictEqual(
    await new AuthoringContentClient(noOpLogger, missingTemplateIconRuntime)
      .loadItemIconReferences(
        testConnection,
        "client-secret",
        ["expected-item"],
        "en",
        signal,
      ),
    [{ itemId: "expected-item" }],
  );

  const malformedTemplateRuntime = new QueuedHttpRuntime([
    tokenResponse(),
    jsonResponse({
      data: {
        item0: {
          itemId: "expected-item",
          icon: null,
          template: { templateId: "template-id" },
        },
      },
    }),
    jsonResponse({
      data: { template0: { itemId: "other-template", icon: null } },
    }),
  ]);
  await rejects(
    new AuthoringContentClient(noOpLogger, malformedTemplateRuntime).loadItemIconReferences(
      testConnection,
      "client-secret",
      ["expected-item"],
      "en",
      signal,
    ),
    /invalid template icon data/u,
  );
});

test("loadItemIcon fetches an authenticated same-origin raster asset", async () => {
  const runtime = new QueuedHttpRuntime([
    tokenResponse(),
    new Response(Uint8Array.from([1, 2, 3]), {
      headers: { "content-type": "image/png" },
    }),
  ]);
  const client = new AuthoringContentClient(noOpLogger, runtime);

  strictEqual(
    await client.loadItemIcon(
      testConnection,
      "client-secret",
      "Network/16x16/home.png",
      signal,
    ),
    "data:image/png;base64,AQID",
  );
  strictEqual(
    String(runtime.requests[1]?.input),
    "https://cm.example.com/-/icon/Network/16x16/home.png",
  );
  const headers = new Headers(runtime.requests[1]?.init.headers);
  strictEqual(headers.get("authorization"), "Bearer access-token");
  strictEqual(runtime.requests[1]?.init.redirect, "error");

  await rejects(
    new AuthoringContentClient(noOpLogger, new QueuedHttpRuntime([])).loadItemIcon(
      testConnection,
      "client-secret",
      "https://external.example.test/icon.png",
      signal,
    ),
    /not supported/u,
  );
});

test("loadItemDetails parses, classifies, and orders item fields", async () => {
  const standardFieldId = "{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}";
  const customFieldId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const runtime = new QueuedHttpRuntime([
    tokenResponse(),
    jsonResponse({
      data: {
        item: {
          itemId: "item-id",
          name: "Home",
          displayName: "Homepage",
          path: "/sitecore/content/Home",
          hasChildren: false,
          language: { name: "en" },
          version: 2,
          template: { templateId: "template-id", name: "Page" },
          versions: [{ language: { name: "en" }, version: 2 }, { language: null, version: "bad" }],
          fields: {
            nodes: [
              {
                fieldId: customFieldId,
                name: "Body",
                label: "",
                value: "Text",
                containsFallbackValue: true,
                templateField: {
                  type: "Rich Text",
                  typeKey: "richtext",
                  versioning: "VERSIONED",
                  sortOrder: 20,
                  section: { name: "Content", sortOrder: 10 },
                },
              },
              {
                fieldId: standardFieldId,
                name: "Title",
                label: "Title label",
                value: "Welcome",
                templateField: {
                  type: "Single-Line Text",
                  typeKey: "text",
                  versioning: "SHARED",
                  sortOrder: 10,
                  section: { name: "Content", sortOrder: 10 },
                },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    }),
    jsonResponse({
      data: {
        item: {
          fields: {
            nodes: [{ fieldId: customFieldId }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    }),
  ]);
  const client = new AuthoringContentClient(noOpLogger, runtime);

  const item = await client.loadItemDetails(testConnection, "client-secret", "item-id", "en", signal);

  strictEqual(item.displayName, "Homepage");
  deepStrictEqual(item.availableVersions, [{ language: "en", version: 2 }]);
  deepStrictEqual(item.fields.map((field) => field.name), ["Title", "Body"]);
  strictEqual(item.fields[0]?.isStandardTemplate, true);
  strictEqual(item.fields[0]?.scope, "SHARED");
  strictEqual(item.fields[1]?.isStandardTemplate, false);
  strictEqual(item.fields[1]?.label, "Body");
  strictEqual(item.fields[1]?.containsFallbackValue, true);
  strictEqual(item.fields[1]?.textual, true);
});

test("loadItemDetails rejects malformed item fields", async () => {
  const runtime = new QueuedHttpRuntime([
    tokenResponse(),
    jsonResponse({
      data: {
        item: {
          itemId: "item-id",
          name: "Home",
          path: "/sitecore/content/Home",
          language: { name: "en" },
          version: 1,
          template: { templateId: "template-id", name: "Page" },
          fields: {
            nodes: [{ fieldId: "field-id", name: "Title", value: 42, templateField: { type: "Text", typeKey: "text", versioning: "VERSIONED" } }],
          },
        },
      },
    }),
    jsonResponse({ data: { item: { fields: { nodes: [] } } } }),
  ]);
  const client = new AuthoringContentClient(noOpLogger, runtime);

  await rejects(
    client.loadItemDetails(testConnection, "client-secret", "item-id", "en", signal),
    /returned an invalid item field/u,
  );
});

test("createItem validates the mutation response before reloading the item", async () => {
  const runtime = new QueuedHttpRuntime([
    tokenResponse(),
    jsonResponse({ data: { createItem: { item: { itemId: "new-item" } } } }),
  ]);
  const client = new AuthoringContentClient(noOpLogger, runtime);

  await rejects(
    client.createItem(
      testConnection,
      "client-secret",
      {
        name: "New item",
        templateId: "template-id",
        parent: "parent-id",
        language: "en",
      },
      signal,
    ),
    /did not confirm the created item/u,
  );
  strictEqual(runtime.requests.length, 2);
});

test("updateItemFields rejects a mutation result for a different item", async () => {
  const runtime = new QueuedHttpRuntime([
    tokenResponse(),
    jsonResponse({
      data: { updateItem: { item: { itemId: "different-item", language: { name: "en" } } } },
    }),
  ]);
  const client = new AuthoringContentClient(noOpLogger, runtime);

  await rejects(
    client.updateItemFields(
      testConnection,
      "client-secret",
      { itemId: "expected-item", language: "en", version: 1, fields: { Title: "Updated" } },
      signal,
    ),
    /did not confirm the updated item/u,
  );
  strictEqual(runtime.requests.length, 2);
});

test("deleteItem requires an explicit successful mutation result", async () => {
  const successfulRuntime = new QueuedHttpRuntime([
    tokenResponse(),
    jsonResponse({ data: { deleteItem: { successful: true } } }),
  ]);
  await new AuthoringContentClient(noOpLogger, successfulRuntime).deleteItem(
    testConnection,
    "client-secret",
    { itemId: "item-id" },
    signal,
  );

  const failedRuntime = new QueuedHttpRuntime([
    tokenResponse(),
    jsonResponse({ data: { deleteItem: { successful: false } } }),
  ]);
  await rejects(
    new AuthoringContentClient(noOpLogger, failedRuntime).deleteItem(
      testConnection,
      "client-secret",
      { path: "/sitecore/content/Home" },
      signal,
    ),
    /did not confirm that the item was deleted/u,
  );
});

test("authoring rejects GraphQL errors, non-JSON content, and invalid JSON", async () => {
  for (const [response, expected] of [
    [jsonResponse({ errors: [{ message: "Not authorized" }] }), /Not authorized/u],
    [new Response("<html>error</html>", { headers: { "content-type": "text/html" } }), /unexpected content type \(text\/html\)/u],
    [new Response("not json", { headers: { "content-type": "application/json" } }), /returned invalid JSON/u],
  ] as const) {
    const runtime = new QueuedHttpRuntime([tokenResponse(), response]);
    const client = new AuthoringContentClient(noOpLogger, runtime);
    await rejects(
      client.loadTreeLevel(testConnection, "client-secret", { itemId: "root-id" }, "en", signal),
      expected,
    );
  }
});


test("indexed name search uses variables, bounded paging and deduplicated results", async () => {
  const found = treeItem("abcd", "Vehicle", "/sitecore/content/Vehicle");
  const runtime = new QueuedHttpRuntime([tokenResponse(), jsonResponse({ data: { search: { totalCount: 100, results: [{ innerItem: found }, { innerItem: { ...found, itemId: "{ABCD}" } }] } } })]);
  const client = new AuthoringContentClient(noOpLogger, runtime);
  const result = await client.searchItemsByName(testConnection, "secret", 'Vehicle "quote"', "en-CA", 0, signal);
  strictEqual(result.items.length, 1);
  strictEqual(result.hasMore, true);
  const body = requestBody(runtime, 1);
  deepStrictEqual(body.variables, { name: 'Vehicle "quote"', language: "en-CA" });
  match(String(body.query), /index: "sitecore_master_index"/);
  match(String(body.query), /pageSize: 50, pageIndex: 0/);
  strictEqual(String(body.query).includes('Vehicle "quote"'), false);
  await rejects(client.searchItemsByName(testConnection, "secret", "name", "en", 10, signal), /page/);
  await rejects(client.searchItemsByName(testConnection, "secret", "", "en", 0, signal), /requires/);
  await rejects(client.searchItemsByName(testConnection, "secret", "name", "en", 0, AbortSignal.abort()), /abort/i);
});

test("indexed search rejects failures and invalid result envelopes", async () => {
  for (const payload of [{ errors: [{ message: "Index unavailable" }] }, { data: { search: null } }, { data: { search: { totalCount: -1, results: [] } } }, { data: { search: { totalCount: 1, results: [{ innerItem: { itemId: 42 } }] } } }]) {
    const client = new AuthoringContentClient(noOpLogger, new QueuedHttpRuntime([tokenResponse(), jsonResponse(payload)]));
    await rejects(client.searchItemsByName(testConnection, "secret", "Page", "en", 0, signal));
  }
});


test("exact lookup distinguishes an absent item from a malformed response", async () => {
  const missing = new AuthoringContentClient(noOpLogger, new QueuedHttpRuntime([tokenResponse(), jsonResponse({ data: { item: null } })]));
  await rejects(missing.loadTreeLevel(testConnection, "secret", { path: "/missing" }, "en", signal), AuthoringItemNotFoundError);
  const malformed = new AuthoringContentClient(noOpLogger, new QueuedHttpRuntime([tokenResponse(), jsonResponse({ data: {} })]));
  await rejects(malformed.loadTreeLevel(testConnection, "secret", { path: "/missing" }, "en", signal), error => error instanceof Error && !(error instanceof AuthoringItemNotFoundError));
});


test("version contract validation skips execution and rejects malformed or unsupported contracts", async () => {
  const input = { itemId: "item-id", language: "en-NZ" };
  for (const payload of [{ data: { __typename: "Mutation" } }, { data: {} }, { errors: [{ message: "Unknown type" }] }]) {
    const runtime = new QueuedHttpRuntime([tokenResponse(), jsonResponse(payload)]);
    const task = new AuthoringContentClient(noOpLogger, runtime).validateAddItemVersion(testConnection, "secret", input, signal);
    if ("data" in payload && payload.data?.__typename) { await task; } else { await rejects(task); }
    const body = requestBody(runtime, 1);
    match(String(body.query), /@skip\(if: \$validateOnly\)/u);
    deepStrictEqual(body.variables, { input: { database: "master", ...input }, validateOnly: true });
    strictEqual(runtime.requests.length, 2);
  }
});

test("version creation validates identity, language and version and never retries a failed write", async () => {
  for (const item of [null, { itemId: "other", language: { name: "en" }, version: 1 },
    { itemId: "item-id", language: { name: "fr" }, version: 1 },
    { itemId: "item-id", language: { name: "en" }, version: 0 }]) {
    const runtime = new QueuedHttpRuntime([tokenResponse(), jsonResponse({ data: { addItemVersion: { item } } })]);
    await rejects(new AuthoringContentClient(noOpLogger, runtime).addItemVersion(testConnection, "secret", { itemId: "item-id", language: "en" }, signal));
    strictEqual((requestBody(runtime, 1).variables as { validateOnly: boolean }).validateOnly, false);
    strictEqual(runtime.requests.length, 2);
  }
  const failed = new QueuedHttpRuntime([tokenResponse(), jsonResponse({}, 503)]);
  await rejects(new AuthoringContentClient(noOpLogger, failed).addItemVersion(testConnection, "secret", { itemId: "item-id", language: "en" }, signal));
  strictEqual(failed.requests.length, 2); deepStrictEqual(failed.waits, []);
});

test("field reset sends reset true while literal empty update sends false", async () => {
  for (const reset of [true, false]) {
    const runtime = new QueuedHttpRuntime([tokenResponse(), jsonResponse({ data: { updateItem: null } })]);
    const client = new AuthoringContentClient(noOpLogger, runtime);
    const input = { itemId: "item-id", language: "en", version: 1 };
    await rejects(reset ? client.resetItemField(testConnection, "secret", { ...input, fieldName: "Title" }, signal)
      : client.updateItemFields(testConnection, "secret", { ...input, fields: { Title: "" } }, signal));
    deepStrictEqual((requestBody(runtime, 1).variables as { input: unknown }).input,
      { database: "master", ...input, fields: [{ name: "Title", value: "", reset }] });
    strictEqual(runtime.requests.length, 2);
  }
});


test("new version and reset read back the exact acknowledged locale and version", async () => {
  for (const reset of [true, false]) {
    const item = { itemId: "item-id", name: "Test", displayName: "Test", path: "/sitecore/content/Test", hasChildren: false,
      language: { name: "en" }, version: 1, template: { templateId: "template-id", name: "Page" }, versions: [],
      fields: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } };
    const runtime = new QueuedHttpRuntime([tokenResponse(),
      jsonResponse({ data: { [reset ? "updateItem" : "addItemVersion"]: { item } } }),
      jsonResponse({ data: { item } }), jsonResponse({ data: { item } })]);
    const client = new AuthoringContentClient(noOpLogger, runtime);
    const input = { itemId: "item-id", language: "en" };
    const result = reset ? await client.resetItemField(testConnection, "secret", { ...input, version: 1, fieldName: "Title" }, signal)
      : await client.addItemVersion(testConnection, "secret", input, signal);
    strictEqual(result.version, 1); strictEqual(result.language, "en");
    deepStrictEqual((requestBody(runtime, 2).variables as { where: unknown }).where,
      { database: "master", itemId: "item-id", language: "en", version: 1 });
  }
  const runtime = new QueuedHttpRuntime([]);
  await rejects(new AuthoringContentClient(noOpLogger, runtime).addItemVersion(testConnection, "secret", { itemId: "item-id", language: "en" }, AbortSignal.abort()));
  strictEqual(runtime.requests.length, 0);
});


test("editor exact reads reject wrong numbered version and mutation never reads latest or retries", async () => {
  const runtime = new QueuedHttpRuntime([tokenResponse(), jsonResponse({ data: { item: {
    itemId: "item-id", language: { name: "en" }, version: 3, fields: null,
  } } }), jsonResponse({ data: { item: { fields: null } } })]);
  await rejects(new AuthoringContentClient(noOpLogger, runtime).loadItem(testConnection, "secret", { itemId: "item-id" }, "en", 2, signal, false, true), /different item, locale or version/);
  const successful = new QueuedHttpRuntime([tokenResponse(), jsonResponse({ data: { updateItem: { item: { itemId: "item-id", language: { name: "en" }, version: 2 } } } })]);
  await new AuthoringContentClient(noOpLogger, successful).updateEditorFields(testConnection, "secret", { itemId: "item-id", language: "en", version: 2, fields: { Title: "" } }, signal);
  strictEqual(successful.requests.length, 2);
  deepStrictEqual((requestBody(successful, 1).variables as { input: unknown }).input, { database: "master", itemId: "item-id", language: "en", version: 2, fields: [{ name: "Title", value: "", reset: false }] });
  const failure = new QueuedHttpRuntime([tokenResponse(), jsonResponse({}, 503)]);
  await rejects(new AuthoringContentClient(noOpLogger, failure).updateEditorFields(testConnection, "secret", { itemId: "item-id", language: "en", version: 2, fields: { Title: "text" } }, signal));
  strictEqual(failure.requests.length, 2); deepStrictEqual(failure.waits, []);
});


test("editor latest read pins field classification and rejects mismatched classification evidence", async () => {
  for (const metadataVersion of [2, 3]) {
    const runtime = new QueuedHttpRuntime([tokenResponse(), jsonResponse({ data: { item: {
      itemId: "item-id", language: { name: "en" }, version: 2, name: "Item", path: "/sitecore/content/Item",
      template: { templateId: "template", name: "Component" }, fields: null,
    } } }), jsonResponse({ data: { item: { itemId: "item-id", language: { name: "en" }, version: metadataVersion, fields: null } } })]);
    const result = new AuthoringContentClient(noOpLogger, runtime).loadItem(testConnection, "secret", { itemId: "item-id" }, "en", undefined, signal, false, true);
    if (metadataVersion === 3) await rejects(result, /classification returned a different/);
    else strictEqual((await result).version, 2);
    deepStrictEqual((requestBody(runtime, 2).variables as { where: unknown }).where, { database: "master", itemId: "item-id", language: "en", version: 2 });
    match(String(requestBody(runtime, 2).query), /withLanguageFallback: false/);
  }
});
