import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { AuthoringContentClient } from "../../src/sitecore/authoringClient";
import {
  jsonResponse,
  noOpLogger,
  QueuedHttpRuntime,
  requestBody,
  testConnection,
  tokenResponse,
} from "./sitecoreClientTestHelpers";

const signal = new AbortController().signal;

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
