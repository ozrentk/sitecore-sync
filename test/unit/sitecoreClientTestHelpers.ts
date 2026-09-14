import type { XmCloudConnection } from "../../src/connections/connection";
import type {
  SitecoreHttpLogger,
  SitecoreHttpRuntime,
} from "../../src/sitecore/sitecoreHttpClient";

export interface RecordedRequest {
  readonly input: string | URL;
  readonly init: RequestInit;
}

export class QueuedHttpRuntime implements SitecoreHttpRuntime {
  readonly requests: RecordedRequest[] = [];
  readonly waits: number[] = [];
  nowValue = Date.UTC(2026, 0, 1);

  constructor(private readonly responses: Response[]) {}

  async fetch(input: string | URL, init: RequestInit): Promise<Response> {
    this.requests.push({ input, init });
    const response = this.responses.shift();
    if (!response) {
      throw new Error("Test runtime ran out of HTTP responses.");
    }
    return response;
  }

  now(): number {
    return this.nowValue;
  }

  random(): number {
    return 0;
  }

  async wait(delayMilliseconds: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      throw signal.reason;
    }
    this.waits.push(delayMilliseconds);
    this.nowValue += delayMilliseconds;
  }

  remainingResponseCount(): number {
    return this.responses.length;
  }
}

export const noOpLogger: SitecoreHttpLogger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
};

export const testConnection: XmCloudConnection = {
  id: "test-connection",
  name: "Test CM",
  serverUrl: "https://cm.example.com",
  clientId: "client-id",
  createdAt: "2026-01-01T00:00:00.000Z",
};

export function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function tokenResponse(): Response {
  return jsonResponse({ access_token: "access-token", expires_in: 300 });
}

export function requestBody(runtime: QueuedHttpRuntime, index: number): Record<string, unknown> {
  const body = runtime.requests[index]?.init.body;
  if (typeof body !== "string") {
    throw new Error(`Request ${index} did not contain a string body.`);
  }
  return JSON.parse(body) as Record<string, unknown>;
}
