import type { XmCloudConnection } from "../connections/connection";

const tokenEndpoint = "https://auth.sitecorecloud.io/oauth/token";
const audience = "https://api.sitecorecloud.io";
const requestTimeoutMilliseconds = 30_000;

interface TokenResponse {
  readonly access_token?: unknown;
}

interface GraphQlError {
  readonly message?: unknown;
}

interface TestQueryResponse {
  readonly data?: {
    readonly sites?: readonly {
      readonly name?: unknown;
      readonly rootPath?: unknown;
      readonly rootItem?: { readonly itemId?: unknown } | null;
    }[];
  };
  readonly errors?: readonly GraphQlError[];
}

export interface AuthoringSite {
  readonly name: string;
  readonly rootPath: string;
  readonly rootItemId?: string;
}

export interface ConnectionTestResult {
  readonly sites: readonly AuthoringSite[];
  readonly duplicateSiteCount: number;
  readonly elapsedMilliseconds: number;
}

interface SiteQueryResult {
  readonly sites: readonly AuthoringSite[];
  readonly duplicateSiteCount: number;
}

export async function testAuthoringConnection(
  connection: XmCloudConnection,
  clientSecret: string,
  cancellationSignal?: AbortSignal,
): Promise<ConnectionTestResult> {
  const startedAt = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Connection test timed out.")), requestTimeoutMilliseconds);
  const cancellationHandler = (): void => controller.abort(new Error("Connection test cancelled."));
  cancellationSignal?.addEventListener("abort", cancellationHandler, { once: true });

  try {
    const accessToken = await requestAccessToken(
      connection.clientId,
      clientSecret,
      controller.signal,
    );
    const siteResult = await querySites(connection.serverUrl, accessToken, controller.signal);

    return {
      sites: siteResult.sites,
      duplicateSiteCount: siteResult.duplicateSiteCount,
      elapsedMilliseconds: Math.round(performance.now() - startedAt),
    };
  } finally {
    clearTimeout(timeout);
    cancellationSignal?.removeEventListener("abort", cancellationHandler);
  }
}

async function requestAccessToken(
  clientId: string,
  clientSecret: string,
  signal: AbortSignal,
): Promise<string> {
  const body = new URLSearchParams({
    audience,
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });

  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal,
  });

  const payload = await readJson<TokenResponse>(response, "OAuth token endpoint");
  if (!response.ok) {
    throw new Error(`Authentication failed (${response.status}).`);
  }
  if (typeof payload.access_token !== "string" || payload.access_token.length === 0) {
    throw new Error("Authentication response did not contain an access token.");
  }

  return payload.access_token;
}

async function querySites(
  serverUrl: string,
  accessToken: string,
  signal: AbortSignal,
): Promise<SiteQueryResult> {
  const endpoint = new URL("/sitecore/api/authoring/graphql/v1/", serverUrl);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      operationName: "XmCloudSyncTestConnection",
      query:
        "query XmCloudSyncTestConnection { sites { name rootPath rootItem { itemId } } }",
    }),
    signal,
  });

  const payload = await readJson<TestQueryResponse>(response, "Authoring GraphQL endpoint");
  if (!response.ok) {
    throw new Error(`Authoring API request failed (${response.status}).`);
  }
  if (payload.errors?.length) {
    const messages = payload.errors
      .map((error) => error.message)
      .filter((message): message is string => typeof message === "string")
      .join("; ");
    throw new Error(messages || "Authoring API returned a GraphQL error.");
  }
  if (!Array.isArray(payload.data?.sites)) {
    throw new Error("Authoring API response did not contain the expected sites collection.");
  }

  const validSites = payload.data.sites
    .map((site): AuthoringSite | undefined => {
      if (typeof site.name !== "string" || typeof site.rootPath !== "string") {
        return undefined;
      }

      const rootItemId = site.rootItem?.itemId;
      return {
        name: site.name,
        rootPath: site.rootPath,
        ...(typeof rootItemId === "string" ? { rootItemId } : {}),
      };
    })
    .filter((site): site is AuthoringSite => site !== undefined);

  const uniqueSites = new Map<string, AuthoringSite>();
  for (const site of validSites) {
    const key = JSON.stringify([site.name, site.rootPath, site.rootItemId ?? null]);
    if (!uniqueSites.has(key)) {
      uniqueSites.set(key, site);
    }
  }

  return {
    sites: [...uniqueSites.values()].sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
    ),
    duplicateSiteCount: validSites.length - uniqueSites.size,
  };
}

async function readJson<T>(response: Response, endpointName: string): Promise<T> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Error(`${endpointName} returned an unexpected content type (${contentType || "unknown"}).`);
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new Error(`${endpointName} returned invalid JSON.`);
  }
}
