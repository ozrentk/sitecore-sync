import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { PublishingClient } from "../../src/sitecore/publishingClient";
import {
  jsonResponse,
  noOpLogger,
  QueuedHttpRuntime,
  requestBody,
  testConnection,
  tokenResponse,
} from "./sitecoreClientTestHelpers";

const signal = new AbortController().signal;

test("start parses the operation ID and constructs a non-retryable mutation", async () => {
  const runtime = new QueuedHttpRuntime([
    tokenResponse(),
    jsonResponse({ data: { publishItem: { operationId: "publish-123" } } }),
  ]);
  const client = new PublishingClient(noOpLogger, runtime);

  const operationId = await client.start(
    testConnection,
    "client-secret",
    {
      itemIds: ["item-a", "item-b"],
      languages: ["en", "de-DE"],
      mode: "FULL",
      publishSubItems: true,
      publishRelatedItems: false,
      displayName: "Test publish",
    },
    signal,
  );

  strictEqual(operationId, "publish-123");
  strictEqual(runtime.requests.length, 2);
  strictEqual(runtime.requests[1]?.input.toString(), "https://cm.example.com/sitecore/api/authoring/graphql/v1/");
  deepStrictEqual(requestBody(runtime, 1).variables, {
    input: {
      sourceDatabase: "master",
      targetDatabases: ["experienceedge"],
      rootItemIds: ["item-a", "item-b"],
      publishSubItems: true,
      publishRelatedItems: false,
      publishItemMode: "FULL",
      languages: ["en", "de-DE"],
      displayName: "Test publish",
    },
  });
});

test("start rejects a missing publishing operation ID", async () => {
  const runtime = new QueuedHttpRuntime([tokenResponse(), jsonResponse({ data: { publishItem: {} } })]);
  const client = new PublishingClient(noOpLogger, runtime);

  await rejects(
    client.start(
      testConnection,
      "client-secret",
      {
        itemIds: ["item-a"],
        languages: ["en"],
        mode: "SMART",
        publishSubItems: false,
        publishRelatedItems: false,
        displayName: "Test publish",
      },
      signal,
    ),
    /did not return a publishing operation ID/u,
  );
});

test("status parses and validates every returned status field", async () => {
  const runtime = new QueuedHttpRuntime([
    tokenResponse(),
    jsonResponse({
      data: {
        publishingStatus: {
          state: "COMPLETED",
          isDone: true,
          isFailed: false,
          processed: 12,
          languages: [{ name: "en" }, { name: "de-DE" }],
          targetDatabase: { name: "experienceedge" },
        },
      },
    }),
  ]);
  const client = new PublishingClient(noOpLogger, runtime);

  const status = await client.status(testConnection, "client-secret", "publish-123", signal);

  deepStrictEqual(status, {
    state: "COMPLETED",
    isDone: true,
    isFailed: false,
    processed: 12,
    languages: ["en", "de-DE"],
    targetDatabase: "experienceedge",
  });
  deepStrictEqual(requestBody(runtime, 1).variables, { operationId: "publish-123" });
});

test("status accepts a null target database but rejects malformed required fields", async () => {
  const validStatus = {
    state: "QUEUED",
    isDone: false,
    isFailed: false,
    processed: 0,
    languages: [{ name: "en" }],
    targetDatabase: null,
  };
  const validRuntime = new QueuedHttpRuntime([
    tokenResponse(),
    jsonResponse({ data: { publishingStatus: validStatus } }),
  ]);
  const validClient = new PublishingClient(noOpLogger, validRuntime);
  deepStrictEqual(
    await validClient.status(testConnection, "client-secret", "publish-123", signal),
    { state: "QUEUED", isDone: false, isFailed: false, processed: 0, languages: ["en"] },
  );

  for (const invalidStatus of [
    { ...validStatus, state: null },
    { ...validStatus, isDone: "false" },
    { ...validStatus, processed: -1 },
    { ...validStatus, processed: 1.5 },
    { ...validStatus, languages: [{ name: 42 }] },
    { ...validStatus, languages: undefined },
    { ...validStatus, languages: [null] },
    { ...validStatus, targetDatabase: {} },
  ]) {
    const runtime = new QueuedHttpRuntime([
      tokenResponse(),
      jsonResponse({ data: { publishingStatus: invalidStatus } }),
    ]);
    const client = new PublishingClient(noOpLogger, runtime);
    await rejects(
      client.status(testConnection, "client-secret", "publish-123", signal),
      /returned invalid publishing status/u,
    );
  }
});

test("publishing requests surface GraphQL messages and the generic fallback", async () => {
  for (const [errors, expected] of [
    [[{ message: "First" }, { message: "Second" }], /First; Second/u],
    [[{ message: 42 }], /Publishing GraphQL returned an error/u],
  ] as const) {
    const runtime = new QueuedHttpRuntime([tokenResponse(), jsonResponse({ errors })]);
    const client = new PublishingClient(noOpLogger, runtime);
    await rejects(
      client.status(testConnection, "client-secret", "publish-123", signal),
      expected,
    );
  }
});

test("invalid publishing status identifies the mismatched fields without disclosing response values", async () => {
  const runtime = new QueuedHttpRuntime([tokenResponse(), jsonResponse({ data: { publishingStatus: {
    state: "RUNNING", isDone: false, isFailed: false, processed: "private-response-value",
    languages: "private-language-value", targetDatabase: null,
  } } })]);
  const client = new PublishingClient(noOpLogger, runtime);
  await rejects(client.status(testConnection, "client-secret", "publish-123", signal), (error: unknown) => {
    strictEqual(error instanceof Error, true);
    const message = (error as Error).message;
    strictEqual(message.includes("processed expected a non-negative integer, received string"), true);
    strictEqual(message.includes("languages expected null or an array of named languages, received string"), true);
    strictEqual(message.includes("remote publishing outcome is unknown"), true);
    strictEqual(message.includes("private-response-value"), false);
    strictEqual(message.includes("private-language-value"), false);
    return true;
  });
});

test("publishing rejects unexpected content types and invalid JSON", async () => {
  for (const [response, expected] of [
    [new Response("<html>error</html>", { headers: { "content-type": "text/html" } }), /unexpected content type \(text\/html\)/u],
    [new Response("not json", { headers: { "content-type": "application/json" } }), /returned invalid JSON/u],
  ] as const) {
    const runtime = new QueuedHttpRuntime([tokenResponse(), response]);
    const client = new PublishingClient(noOpLogger, runtime);
    await rejects(
      client.status(testConnection, "client-secret", "publish-123", signal),
      expected,
    );
  }
});

test("publishing validates authentication responses", async () => {
  for (const response of [
    jsonResponse({}, 200),
    jsonResponse({ access_token: "access-token" }, 401),
  ]) {
    const runtime = new QueuedHttpRuntime([response]);
    const client = new PublishingClient(noOpLogger, runtime);
    await rejects(
      client.status(testConnection, "client-secret", "publish-123", signal),
      /Publishing authentication failed/u,
    );
  }
});


test("null language metadata preserves running, completed and failed publishing states", async () => {
  for (const flags of [
    { state: "RUNNING", isDone: false, isFailed: false },
    { state: "COMPLETED", isDone: true, isFailed: false },
    { state: "FAILED", isDone: true, isFailed: true },
  ]) {
    const runtime = new QueuedHttpRuntime([tokenResponse(), jsonResponse({ data: { publishingStatus: {
      ...flags, processed: 0, languages: null, targetDatabase: null,
    } } })]);
    const client = new PublishingClient(noOpLogger, runtime);
    deepStrictEqual(await client.status(testConnection, "client-secret", "publish-123", signal),
      { ...flags, processed: 0, languages: [] });
    strictEqual(runtime.requests.length, 2);
  }
});
