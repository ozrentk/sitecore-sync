import {
  deepStrictEqual,
  match,
  rejects,
  strictEqual,
} from "node:assert/strict";
import { test } from "node:test";
import {
  SitecoreHttpClient,
  type SitecoreHttpLogger,
  type SitecoreHttpRuntime,
} from "../../src/sitecore/sitecoreHttpClient";

type FetchOutcome = Response | Error;

class TestRuntime implements SitecoreHttpRuntime {
  readonly requests: { readonly input: string | URL; readonly init: RequestInit }[] = [];
  readonly waits: number[] = [];
  nowValue = Date.UTC(2026, 0, 1, 0, 0, 0);
  randomValue = 0;
  waitOverride:
    | ((delayMilliseconds: number, signal: AbortSignal) => Promise<void>)
    | undefined;

  constructor(private readonly outcomes: FetchOutcome[]) {}

  async fetch(input: string | URL, init: RequestInit): Promise<Response> {
    this.requests.push({ input, init });
    const outcome = this.outcomes.shift();
    if (!outcome) {
      throw new Error("Test runtime ran out of fetch outcomes.");
    }
    if (outcome instanceof Error) {
      throw outcome;
    }
    return outcome;
  }

  now(): number {
    return this.nowValue;
  }

  random(): number {
    return this.randomValue;
  }

  async wait(delayMilliseconds: number, signal: AbortSignal): Promise<void> {
    this.waits.push(delayMilliseconds);
    if (this.waitOverride) {
      await this.waitOverride(delayMilliseconds, signal);
      return;
    }
    if (signal.aborted) {
      throw signal.reason;
    }
    this.nowValue += delayMilliseconds;
  }
}

class TestLogger implements SitecoreHttpLogger {
  readonly traces: string[] = [];
  readonly debugs: string[] = [];
  readonly infos: string[] = [];
  readonly warnings: string[] = [];

  trace(message: string): void {
    this.traces.push(message);
  }

  debug(message: string): void {
    this.debugs.push(message);
  }

  info(message: string): void {
    this.infos.push(message);
  }

  warn(message: string): void {
    this.warnings.push(message);
  }
}

function requestOptions(
  signal: AbortSignal = new AbortController().signal,
  retryable = true,
) {
  return { name: "Load item", signal, retryable } as const;
}

test("request forwards request data and returns a successful response", async () => {
  const response = new Response("created", { status: 201 });
  const runtime = new TestRuntime([response]);
  const logger = new TestLogger();
  const client = new SitecoreHttpClient(logger, runtime);
  const controller = new AbortController();
  const ignoredController = new AbortController();

  const actual = await client.request(
    "https://cm.example.com/sitecore/api/items/1",
    {
      method: "POST",
      headers: { authorization: "Bearer token" },
      body: "payload",
      signal: ignoredController.signal,
    },
    requestOptions(controller.signal),
  );

  strictEqual(actual, response);
  strictEqual(runtime.requests.length, 1);
  strictEqual(runtime.requests[0]?.input.toString(), "https://cm.example.com/sitecore/api/items/1");
  strictEqual(runtime.requests[0]?.init.method, "POST");
  strictEqual(runtime.requests[0]?.init.body, "payload");
  strictEqual(runtime.requests[0]?.init.signal, controller.signal);
  deepStrictEqual(runtime.waits, []);
  deepStrictEqual(logger.traces, ["Load item: HTTP attempt 1/4."]);
});

test("request retries every configured transient HTTP status", async () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    const runtime = new TestRuntime([
      new Response(null, { status }),
      new Response(null, { status: 200 }),
    ]);
    const logger = new TestLogger();
    const client = new SitecoreHttpClient(logger, runtime);

    const response = await client.request(
      "https://cm.example.com/sitecore/api/items/1",
      {},
      requestOptions(),
    );

    strictEqual(response.status, 200, `HTTP ${status}`);
    strictEqual(runtime.requests.length, 2, `HTTP ${status}`);
    deepStrictEqual(runtime.waits, [500], `HTTP ${status}`);
  }
});

test("request does not retry a permanent HTTP failure", async () => {
  const runtime = new TestRuntime([new Response(null, { status: 401 })]);
  const logger = new TestLogger();
  const client = new SitecoreHttpClient(logger, runtime);

  const response = await client.request(
    "https://cm.example.com/sitecore/api/items/1",
    {},
    requestOptions(),
  );

  strictEqual(response.status, 401);
  strictEqual(runtime.requests.length, 1);
  deepStrictEqual(runtime.waits, []);
  deepStrictEqual(logger.warnings, []);
});

test("request does not retry a network failure when retries are disabled", async () => {
  const failure = new Error("connection refused");
  const runtime = new TestRuntime([failure]);
  const client = new SitecoreHttpClient(new TestLogger(), runtime);

  await rejects(
    client.request(
      "https://cm.example.com/sitecore/api/items/1",
      {},
      requestOptions(undefined, false),
    ),
    (error: unknown) => error === failure,
  );
  strictEqual(runtime.requests.length, 1);
  deepStrictEqual(runtime.waits, []);
});

test("request exhausts network retries with exponential backoff", async () => {
  const failure = new Error("socket closed");
  const runtime = new TestRuntime([failure, failure, failure, failure]);
  const logger = new TestLogger();
  const client = new SitecoreHttpClient(logger, runtime);

  await rejects(
    client.request(
      "https://cm.example.com/sitecore/api/items/1",
      {},
      requestOptions(),
    ),
    (error: unknown) => error === failure,
  );

  strictEqual(runtime.requests.length, 4);
  deepStrictEqual(runtime.waits, [500, 1_000, 2_000]);
  strictEqual(logger.warnings.length, 4);
  match(logger.warnings[3] ?? "", /stopped retrying after 4 attempts/u);
});

test("request returns the final transient response after exhausting retries", async () => {
  const runtime = new TestRuntime([
    new Response(null, { status: 503 }),
    new Response(null, { status: 503 }),
    new Response(null, { status: 503 }),
    new Response(null, { status: 503 }),
  ]);
  const logger = new TestLogger();
  const client = new SitecoreHttpClient(logger, runtime);

  const response = await client.request(
    "https://cm.example.com/sitecore/api/items/1",
    {},
    requestOptions(),
  );

  strictEqual(response.status, 503);
  strictEqual(runtime.requests.length, 4);
  deepStrictEqual(runtime.waits, [500, 1_000, 2_000]);
  match(logger.warnings[3] ?? "", /stopped retrying after 4 attempts \(HTTP 503\)/u);
});

test("request honors Retry-After expressed as seconds", async () => {
  const runtime = new TestRuntime([
    new Response(null, { status: 429, headers: { "retry-after": "2.5" } }),
    new Response(null, { status: 200 }),
  ]);
  const client = new SitecoreHttpClient(new TestLogger(), runtime);

  await client.request(
    "https://cm.example.com/sitecore/api/items/1",
    {},
    requestOptions(),
  );

  deepStrictEqual(runtime.waits, [2_500]);
});

test("request honors Retry-After expressed as an HTTP date", async () => {
  const runtime = new TestRuntime([
    new Response(null, {
      status: 503,
      headers: { "retry-after": "Thu, 01 Jan 2026 00:00:03 GMT" },
    }),
    new Response(null, { status: 200 }),
  ]);
  const client = new SitecoreHttpClient(new TestLogger(), runtime);

  await client.request(
    "https://cm.example.com/sitecore/api/items/1",
    {},
    requestOptions(),
  );

  deepStrictEqual(runtime.waits, [3_000]);
});

test("request falls back to jittered backoff for an invalid Retry-After value", async () => {
  const runtime = new TestRuntime([
    new Response(null, { status: 503, headers: { "retry-after": "later" } }),
    new Response(null, { status: 200 }),
  ]);
  runtime.randomValue = 0.5;
  const client = new SitecoreHttpClient(new TestLogger(), runtime);

  await client.request(
    "https://cm.example.com/sitecore/api/items/1",
    {},
    requestOptions(),
  );

  deepStrictEqual(runtime.waits, [562]);
});

test("request cancels a transient response body before retrying", async () => {
  let bodyCancelled = false;
  const body = new ReadableStream({
    cancel(): void {
      bodyCancelled = true;
    },
  });
  const runtime = new TestRuntime([
    new Response(body, { status: 503 }),
    new Response(null, { status: 200 }),
  ]);
  const client = new SitecoreHttpClient(new TestLogger(), runtime);

  await client.request(
    "https://cm.example.com/sitecore/api/items/1",
    {},
    requestOptions(),
  );

  strictEqual(bodyCancelled, true);
});

test("request shares a Retry-After cooldown by origin and clear removes it", async () => {
  const runtime = new TestRuntime([
    new Response(null, { status: 429, headers: { "retry-after": "2" } }),
    new Response(null, { status: 200 }),
    new Response(null, { status: 200 }),
    new Response(null, { status: 200 }),
  ]);
  const logger = new TestLogger();
  const client = new SitecoreHttpClient(logger, runtime);

  await client.request(
    "https://cm.example.com/sitecore/api/items/1",
    {},
    requestOptions(undefined, false),
  );
  await client.request(
    "https://other.example.com/sitecore/api/items/1",
    {},
    requestOptions(),
  );
  await client.request(
    "https://cm.example.com/sitecore/api/items/2",
    {},
    requestOptions(),
  );
  client.clear();
  await client.request(
    "https://cm.example.com/sitecore/api/items/3",
    {},
    requestOptions(),
  );

  deepStrictEqual(runtime.waits, [2_000]);
  strictEqual(logger.debugs.length, 1);
  match(logger.debugs[0] ?? "", /endpoint cooldown/u);
});

test("request propagates cancellation during a retry delay", async () => {
  const runtime = new TestRuntime([
    new Response(null, { status: 503 }),
    new Response(null, { status: 200 }),
  ]);
  const client = new SitecoreHttpClient(new TestLogger(), runtime);
  const controller = new AbortController();
  const reason = new Error("cancelled by user");
  runtime.waitOverride = async (_delay, signal) => {
    controller.abort(reason);
    throw signal.reason;
  };

  await rejects(
    client.request(
      "https://cm.example.com/sitecore/api/items/1",
      {},
      requestOptions(controller.signal),
    ),
    (error: unknown) => error === reason,
  );
  strictEqual(runtime.requests.length, 1);
});

test("request rejects a pre-aborted request without calling fetch", async () => {
  const runtime = new TestRuntime([new Response(null, { status: 200 })]);
  const client = new SitecoreHttpClient(new TestLogger(), runtime);
  const controller = new AbortController();
  const reason = new Error("already cancelled");
  controller.abort(reason);

  await rejects(
    client.request(
      "https://cm.example.com/sitecore/api/items/1",
      {},
      requestOptions(controller.signal),
    ),
    (error: unknown) => error === reason,
  );
  strictEqual(runtime.requests.length, 0);
});

test("request logs retry diagnostics without URL, credentials, or failure details", async () => {
  const secret = "super-secret-token";
  const failure = new Error(`request failed with ${secret}`);
  const runtime = new TestRuntime([failure, failure, failure, failure]);
  const logger = new TestLogger();
  const client = new SitecoreHttpClient(logger, runtime);

  await rejects(
    client.request(
      `https://cm.example.com/sitecore/api/items/1?access_token=${secret}`,
      { headers: { authorization: `Bearer ${secret}` } },
      requestOptions(),
    ),
  );

  const logOutput = [
    ...logger.traces,
    ...logger.debugs,
    ...logger.infos,
    ...logger.warnings,
  ].join("\n");
  strictEqual(logOutput.includes(secret), false);
  strictEqual(logOutput.includes("access_token"), false);
  strictEqual(logOutput.includes("authorization"), false);
  strictEqual(logOutput.includes("request failed"), false);
});
