import { print } from "graphql";
import type { XmCloudConnection } from "../connections/connection";
import type { PublishMode } from "../publishing/publishingTypes";
import { SitecoreHttpClient, type SitecoreHttpLogger } from "./sitecoreHttpClient";
import { publishItemsMutation, publishingStatusQuery } from "./graphql/publishingQueries";

const tokenEndpoint = "https://auth.sitecorecloud.io/oauth/token";
const audience = "https://api.sitecorecloud.io";

interface CachedToken {
  readonly value: string;
  readonly expiresAt: number;
}

interface GraphQlError {
  readonly message?: unknown;
}

interface PublishResponse {
  readonly data?: { readonly publishItem?: { readonly operationId?: unknown } | null };
  readonly errors?: readonly GraphQlError[];
}

interface StatusResponse {
  readonly data?: {
    readonly publishingStatus?: {
      readonly state?: unknown;
      readonly isDone?: unknown;
      readonly isFailed?: unknown;
      readonly processed?: unknown;
      readonly languages?: readonly { readonly name?: unknown }[];
      readonly targetDatabase?: { readonly name?: unknown } | null;
    } | null;
  };
  readonly errors?: readonly GraphQlError[];
}

export interface StartPublishInput {
  readonly itemIds: readonly string[];
  readonly languages: readonly string[];
  readonly mode: PublishMode;
  readonly publishSubItems: boolean;
  readonly publishRelatedItems: boolean;
  readonly displayName: string;
}

export interface PublishingStatus {
  readonly state: string;
  readonly isDone: boolean;
  readonly isFailed: boolean;
  readonly processed: number;
  readonly languages: readonly string[];
  readonly targetDatabase?: string;
}

export class PublishingClient {
  private readonly tokens = new Map<string, CachedToken>();
  private readonly http: SitecoreHttpClient;

  constructor(log: SitecoreHttpLogger) {
    this.http = new SitecoreHttpClient(log);
  }

  async start(
    connection: XmCloudConnection,
    clientSecret: string,
    input: StartPublishInput,
    signal: AbortSignal,
  ): Promise<string> {
    const payload = await this.postGraphQl<PublishResponse>(
      connection,
      clientSecret,
      "start Sitecore publish",
      "XmCloudSyncPublishItems",
      print(publishItemsMutation),
      {
        input: {
          sourceDatabase: "master",
          targetDatabases: ["experienceedge"],
          rootItemIds: input.itemIds,
          publishSubItems: input.publishSubItems,
          publishRelatedItems: input.publishRelatedItems,
          publishItemMode: input.mode,
          languages: input.languages,
          displayName: input.displayName,
        },
      },
      signal,
      false,
    );
    const operationId = payload.data?.publishItem?.operationId;
    if (typeof operationId !== "string" || !operationId) {
      throw new Error("Authoring API did not return a publishing operation ID.");
    }
    return operationId;
  }

  async status(
    connection: XmCloudConnection,
    clientSecret: string,
    operationId: string,
    signal: AbortSignal,
  ): Promise<PublishingStatus> {
    const payload = await this.postGraphQl<StatusResponse>(
      connection,
      clientSecret,
      "check Sitecore publishing status",
      "XmCloudSyncPublishingStatus",
      print(publishingStatusQuery),
      { operationId },
      signal,
      true,
    );
    const status = payload.data?.publishingStatus;
    if (!status) {
      throw new Error("Authoring API did not return publishing status.");
    }
    return {
      state: typeof status.state === "string" ? status.state : "UNKNOWN",
      isDone: status.isDone === true,
      isFailed: status.isFailed === true,
      processed: typeof status.processed === "number" ? status.processed : 0,
      languages: (status.languages ?? [])
        .map((language) => language.name)
        .filter((name): name is string => typeof name === "string"),
      targetDatabase: typeof status.targetDatabase?.name === "string"
        ? status.targetDatabase.name
        : undefined,
    };
  }

  clear(): void {
    this.tokens.clear();
    this.http.clear();
  }

  private async postGraphQl<T extends { readonly errors?: readonly GraphQlError[] }>(
    connection: XmCloudConnection,
    clientSecret: string,
    requestName: string,
    operationName: string,
    query: string,
    variables: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
    retryable: boolean,
  ): Promise<T> {
    const token = await this.getToken(connection, clientSecret, signal);
    const endpoint = new URL("/sitecore/api/authoring/graphql/v1/", connection.serverUrl);
    const response = await this.http.request(
      endpoint,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ operationName, query, variables }),
      },
      { name: requestName, signal, retryable },
    );
    const payload = await readJson<T>(response, requestName);
    if (!response.ok) {
      throw new Error(`${requestName} failed (${response.status}).`);
    }
    throwForErrors(payload.errors);
    return payload;
  }

  private async getToken(
    connection: XmCloudConnection,
    clientSecret: string,
    signal: AbortSignal,
  ): Promise<string> {
    const cached = this.tokens.get(connection.id);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    const response = await this.http.request(
      tokenEndpoint,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          audience,
          grant_type: "client_credentials",
          client_id: connection.clientId,
          client_secret: clientSecret,
        }),
      },
      { name: "Sitecore publishing OAuth token request", signal, retryable: true },
    );
    const payload = await readJson<{ readonly access_token?: unknown; readonly expires_in?: unknown }>(
      response,
      "Sitecore publishing OAuth token request",
    );
    if (!response.ok || typeof payload.access_token !== "string" || !payload.access_token) {
      throw new Error(`Publishing authentication failed (${response.status}).`);
    }
    const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 300;
    this.tokens.set(connection.id, {
      value: payload.access_token,
      expiresAt: Date.now() + Math.max(expiresIn - 60, 30) * 1_000,
    });
    return payload.access_token;
  }
}

function throwForErrors(errors: readonly GraphQlError[] | undefined): void {
  if (!errors?.length) {
    return;
  }
  const message = errors
    .map((error) => error.message)
    .filter((value): value is string => typeof value === "string")
    .join("; ");
  throw new Error(message || "Publishing GraphQL returned an error.");
}

async function readJson<T>(response: Response, name: string): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${name} returned invalid JSON.`);
  }
}
