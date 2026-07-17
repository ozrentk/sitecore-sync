import type { XmCloudConnection } from "../connections/connection";
import { print } from "graphql";
import { testConnectionQuery, treeLevelQuery } from "./graphql/authoringQueries";

const tokenEndpoint = "https://auth.sitecorecloud.io/oauth/token";
const audience = "https://api.sitecorecloud.io";
const requestTimeoutMilliseconds = 30_000;

interface TokenResponse {
  readonly access_token?: unknown;
  readonly expires_in?: unknown;
}

interface AccessToken {
  readonly value: string;
  readonly expiresInSeconds: number;
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

interface RawAuthoringTreeItem {
  readonly itemId?: unknown;
  readonly name?: unknown;
  readonly displayName?: unknown;
  readonly path?: unknown;
  readonly hasChildren?: unknown;
}

interface TreeLevelQueryResponse {
  readonly data?: {
    readonly item?: (RawAuthoringTreeItem & {
      readonly children?: {
        readonly nodes?: readonly RawAuthoringTreeItem[];
        readonly pageInfo?: {
          readonly hasNextPage?: unknown;
          readonly endCursor?: unknown;
        };
      };
    }) | null;
  };
  readonly errors?: readonly GraphQlError[];
}

export interface AuthoringTreeItem {
  readonly itemId: string;
  readonly name: string;
  readonly displayName: string;
  readonly path: string;
  readonly hasChildren: boolean;
}

export interface AuthoringTreeLevel {
  readonly item: AuthoringTreeItem;
  readonly children: readonly AuthoringTreeItem[];
}

export type AuthoringItemLocator =
  | { readonly path: string }
  | { readonly itemId: string };

interface CachedToken {
  readonly value: string;
  readonly expiresAt: number;
}

export class AuthoringContentClient {
  private readonly tokens = new Map<string, CachedToken>();

  async loadTreeLevel(
    connection: XmCloudConnection,
    clientSecret: string,
    locator: AuthoringItemLocator,
    language: string,
    signal: AbortSignal,
  ): Promise<AuthoringTreeLevel> {
    const accessToken = await this.getAccessToken(connection, clientSecret, signal);
    const children: AuthoringTreeItem[] = [];
    const seenCursors = new Set<string>();
    let item: AuthoringTreeItem | undefined;
    let after: string | undefined;

    do {
      const page = await queryTreeLevelPage(
        connection.serverUrl,
        accessToken,
        locator,
        language,
        after,
        signal,
      );
      item ??= page.item;
      children.push(...page.children);
      after = page.nextCursor;
      if (after && seenCursors.has(after)) {
        throw new Error("Authoring API returned the same children-page cursor twice.");
      }
      if (after) {
        seenCursors.add(after);
      }
    } while (after !== undefined);

    return { item, children };
  }

  clear(): void {
    this.tokens.clear();
  }

  private async getAccessToken(
    connection: XmCloudConnection,
    clientSecret: string,
    signal: AbortSignal,
  ): Promise<string> {
    const cached = this.tokens.get(connection.id);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const token = await requestAccessToken(connection.clientId, clientSecret, signal);
    this.tokens.set(connection.id, {
      value: token.value,
      expiresAt: Date.now() + Math.max(token.expiresInSeconds - 60, 30) * 1_000,
    });
    return token.value;
  }
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
    const siteResult = await querySites(connection.serverUrl, accessToken.value, controller.signal);

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
): Promise<AccessToken> {
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

  return {
    value: payload.access_token,
    expiresInSeconds:
      typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in)
        ? payload.expires_in
        : 300,
  };
}

async function queryTreeLevelPage(
  serverUrl: string,
  accessToken: string,
  locator: AuthoringItemLocator,
  language: string,
  after: string | undefined,
  signal: AbortSignal,
): Promise<{
  readonly item: AuthoringTreeItem;
  readonly children: readonly AuthoringTreeItem[];
  readonly nextCursor?: string;
}> {
  const endpoint = new URL("/sitecore/api/authoring/graphql/v1/", serverUrl);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      operationName: "XmCloudSyncTreeLevel",
      query: print(treeLevelQuery),
      variables: {
        where: { database: "master", language, ...locator },
        pageSize: 100,
        after: after ?? null,
      },
    }),
    signal,
  });

  const payload = await readJson<TreeLevelQueryResponse>(
    response,
    "Authoring GraphQL endpoint",
  );
  if (!response.ok) {
    throw new Error(`Authoring API request failed (${response.status}).`);
  }
  throwForGraphQlErrors(payload.errors);
  if (!payload.data?.item) {
    const identifier = "path" in locator ? locator.path : locator.itemId;
    throw new Error(`Authoring item “${identifier}” was not found.`);
  }

  const item = parseTreeItem(payload.data.item);
  const children = (payload.data.item.children?.nodes ?? []).map(parseTreeItem);
  const pageInfo = payload.data.item.children?.pageInfo;
  const hasNextPage = pageInfo?.hasNextPage === true;
  const endCursor = pageInfo?.endCursor;
  if (hasNextPage && typeof endCursor !== "string") {
    throw new Error("Authoring API reported another children page without a cursor.");
  }

  return {
    item,
    children,
    ...(hasNextPage ? { nextCursor: endCursor as string } : {}),
  };
}

function parseTreeItem(value: RawAuthoringTreeItem): AuthoringTreeItem {
  if (
    typeof value.itemId !== "string" ||
    typeof value.name !== "string" ||
    typeof value.path !== "string"
  ) {
    throw new Error("Authoring API returned an invalid content-tree item.");
  }

  return {
    itemId: value.itemId,
    name: value.name,
    displayName: typeof value.displayName === "string" ? value.displayName : value.name,
    path: value.path,
    hasChildren: value.hasChildren === true,
  };
}

function throwForGraphQlErrors(errors: readonly GraphQlError[] | undefined): void {
  if (!errors?.length) {
    return;
  }

  const messages = errors
    .map((error) => error.message)
    .filter((message): message is string => typeof message === "string")
    .join("; ");
  throw new Error(messages || "Authoring API returned a GraphQL error.");
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
      query: print(testConnectionQuery),
    }),
    signal,
  });

  const payload = await readJson<TestQueryResponse>(response, "Authoring GraphQL endpoint");
  if (!response.ok) {
    throw new Error(`Authoring API request failed (${response.status}).`);
  }
  throwForGraphQlErrors(payload.errors);
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
