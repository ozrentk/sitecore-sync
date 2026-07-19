import type { XmCloudConnection } from "../connections/connection";
import { print } from "graphql";
import {
  itemDetailsQuery,
  languagesQuery,
  nonStandardFieldIdsQuery,
  testConnectionQuery,
  treeLevelQuery,
} from "./graphql/authoringQueries";
import { SitecoreHttpClient, type SitecoreHttpLogger } from "./sitecoreHttpClient";

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

interface RawPageInfo {
  readonly hasNextPage?: unknown;
  readonly endCursor?: unknown;
}

interface RawLanguage {
  readonly name?: unknown;
  readonly displayName?: unknown;
  readonly englishName?: unknown;
  readonly nativeName?: unknown;
}

interface LanguagesQueryResponse {
  readonly data?: {
    readonly languages?: {
      readonly nodes?: readonly RawLanguage[];
      readonly pageInfo?: RawPageInfo;
    };
  };
  readonly errors?: readonly GraphQlError[];
}

interface RawItemField {
  readonly fieldId?: unknown;
  readonly name?: unknown;
  readonly label?: unknown;
  readonly value?: unknown;
  readonly containsFallbackValue?: unknown;
  readonly containsInheritedValue?: unknown;
  readonly containsStandardValue?: unknown;
  readonly templateField?: {
    readonly type?: unknown;
    readonly typeKey?: unknown;
    readonly versioning?: unknown;
    readonly sortOrder?: unknown;
    readonly section?: {
      readonly name?: unknown;
      readonly sortOrder?: unknown;
    };
  };
}

interface RawItemDetails {
  readonly itemId?: unknown;
  readonly path?: unknown;
  readonly version?: unknown;
  readonly language?: { readonly name?: unknown };
  readonly template?: { readonly templateId?: unknown; readonly name?: unknown };
  readonly versions?: readonly {
    readonly language?: { readonly name?: unknown };
    readonly version?: unknown;
  }[];
  readonly fields?: {
    readonly nodes?: readonly RawItemField[];
    readonly pageInfo?: RawPageInfo;
  };
}

interface ItemDetailsQueryResponse {
  readonly data?: { readonly item?: RawItemDetails | null };
  readonly errors?: readonly GraphQlError[];
}

interface NonStandardFieldIdsQueryResponse {
  readonly data?: {
    readonly item?: {
      readonly fields?: {
        readonly nodes?: readonly { readonly fieldId?: unknown }[];
        readonly pageInfo?: RawPageInfo;
      };
    } | null;
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
  private readonly http: SitecoreHttpClient;

  constructor(log: SitecoreHttpLogger) {
    this.http = new SitecoreHttpClient(log);
  }

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
      const page = await this.queryTreeLevelPage(
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

  async loadLanguages(
    connection: XmCloudConnection,
    clientSecret: string,
    signal: AbortSignal,
  ): Promise<readonly AuthoringLanguage[]> {
    const accessToken = await this.getAccessToken(connection, clientSecret, signal);
    const languages = new Map<string, AuthoringLanguage>();
    const seenCursors = new Set<string>();
    let after: string | undefined;

    do {
      const payload = await this.postGraphQl<LanguagesQueryResponse>(
        connection.serverUrl,
        accessToken,
        "Sitecore Authoring languages query",
        "XmCloudSyncLanguages",
        print(languagesQuery),
        { databaseName: "master", pageSize: 100, after: after ?? null },
        signal,
      );
      const collection = payload.data?.languages;
      if (!collection) {
        throw new Error("Authoring API response did not contain the languages collection.");
      }
      for (const raw of collection.nodes ?? []) {
        if (typeof raw.name !== "string") {
          throw new Error("Authoring API returned an invalid language.");
        }
        languages.set(raw.name.toLowerCase(), {
          name: raw.name,
          displayName: typeof raw.displayName === "string" ? raw.displayName : raw.name,
          englishName: typeof raw.englishName === "string" ? raw.englishName : raw.name,
          nativeName: typeof raw.nativeName === "string" ? raw.nativeName : raw.name,
        });
      }
      after = nextCursor(collection.pageInfo, "languages");
      assertNewCursor(after, seenCursors, "languages");
    } while (after !== undefined);

    return [...languages.values()].sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
    );
  }

  async loadItemDetails(
    connection: XmCloudConnection,
    clientSecret: string,
    itemId: string,
    language: string,
    signal: AbortSignal,
  ): Promise<AuthoringItemDetails> {
    const accessToken = await this.getAccessToken(connection, clientSecret, signal);
    const where = { database: "master", itemId, language };
    const [rawDetails, nonStandardFieldIds] = await Promise.all([
      this.loadItemDetailsPages(connection.serverUrl, accessToken, where, signal),
      this.loadNonStandardFieldIds(connection.serverUrl, accessToken, where, signal),
    ]);
    return parseItemDetails(rawDetails, nonStandardFieldIds);
  }

  private async loadItemDetailsPages(
    serverUrl: string,
    accessToken: string,
    where: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<RawItemDetails> {
    const fields: RawItemField[] = [];
    const seenCursors = new Set<string>();
    let item: RawItemDetails | undefined;
    let after: string | undefined;
    do {
      const payload = await this.postGraphQl<ItemDetailsQueryResponse>(
        serverUrl,
        accessToken,
        "Sitecore Authoring item-details query",
        "XmCloudSyncItemDetails",
        print(itemDetailsQuery),
        { where, pageSize: 100, after: after ?? null },
        signal,
      );
      if (!payload.data?.item) {
        throw new Error("The requested Authoring item was not found.");
      }
      item ??= payload.data.item;
      fields.push(...(payload.data.item.fields?.nodes ?? []));
      after = nextCursor(payload.data.item.fields?.pageInfo, "item fields");
      assertNewCursor(after, seenCursors, "item fields");
    } while (after !== undefined);
    return { ...item, fields: { nodes: fields } };
  }

  private async loadNonStandardFieldIds(
    serverUrl: string,
    accessToken: string,
    where: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<ReadonlySet<string>> {
    const fieldIds = new Set<string>();
    const seenCursors = new Set<string>();
    let after: string | undefined;
    do {
      const payload = await this.postGraphQl<NonStandardFieldIdsQueryResponse>(
        serverUrl,
        accessToken,
        "Sitecore Authoring non-Standard fields query",
        "XmCloudSyncNonStandardFieldIds",
        print(nonStandardFieldIdsQuery),
        { where, pageSize: 100, after: after ?? null },
        signal,
      );
      const item = payload.data?.item;
      if (!item) {
        throw new Error("The requested Authoring item was not found while classifying fields.");
      }
      const fields = item.fields;
      if (!fields) {
        return fieldIds;
      }
      for (const field of fields.nodes ?? []) {
        if (typeof field.fieldId !== "string") {
          throw new Error("Authoring API returned an invalid non-Standard field ID.");
        }
        fieldIds.add(normalizeGuid(field.fieldId));
      }
      after = nextCursor(fields.pageInfo, "non-Standard fields");
      assertNewCursor(after, seenCursors, "non-Standard fields");
    } while (after !== undefined);
    return fieldIds;
  }

  private async postGraphQl<T extends { readonly errors?: readonly GraphQlError[] }>(
    serverUrl: string,
    accessToken: string,
    requestName: string,
    operationName: string,
    query: string,
    variables: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<T> {
    const endpoint = new URL("/sitecore/api/authoring/graphql/v1/", serverUrl);
    const response = await this.http.request(
      endpoint,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ operationName, query, variables }),
      },
      { name: requestName, signal, retryable: true },
    );
    const payload = await readJson<T>(response, "Authoring GraphQL endpoint");
    if (!response.ok) {
      throw new Error(`${requestName} failed (${response.status}).`);
    }
    throwForGraphQlErrors(payload.errors);
    return payload;
  }

  clear(): void {
    this.tokens.clear();
    this.http.clear();
  }

  async testConnection(
    connection: XmCloudConnection,
    clientSecret: string,
    cancellationSignal?: AbortSignal,
  ): Promise<ConnectionTestResult> {
    const startedAt = performance.now();
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new DOMException("Connection test timed out.", "AbortError")),
      requestTimeoutMilliseconds,
    );
    const cancellationHandler = (): void =>
      controller.abort(new DOMException("Connection test cancelled.", "AbortError"));
    if (cancellationSignal?.aborted) {
      cancellationHandler();
    } else {
      cancellationSignal?.addEventListener("abort", cancellationHandler, { once: true });
    }

    try {
      const accessToken = await this.requestAccessToken(
        connection.clientId,
        clientSecret,
        controller.signal,
      );
      const siteResult = await this.querySites(
        connection.serverUrl,
        accessToken.value,
        controller.signal,
      );

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

  private async getAccessToken(
    connection: XmCloudConnection,
    clientSecret: string,
    signal: AbortSignal,
  ): Promise<string> {
    const cached = this.tokens.get(connection.id);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const token = await this.requestAccessToken(connection.clientId, clientSecret, signal);
    this.tokens.set(connection.id, {
      value: token.value,
      expiresAt: Date.now() + Math.max(token.expiresInSeconds - 60, 30) * 1_000,
    });
    return token.value;
  }

  private async requestAccessToken(
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

    const response = await this.http.request(
      tokenEndpoint,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      },
      { name: "Sitecore OAuth token request", signal, retryable: true },
    );

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

  private async queryTreeLevelPage(
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
    const response = await this.http.request(
      endpoint,
      {
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
      },
      { name: "Sitecore Authoring tree query", signal, retryable: true },
    );

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

  private async querySites(
    serverUrl: string,
    accessToken: string,
    signal: AbortSignal,
  ): Promise<SiteQueryResult> {
    const endpoint = new URL("/sitecore/api/authoring/graphql/v1/", serverUrl);
    const response = await this.http.request(
      endpoint,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          operationName: "XmCloudSyncTestConnection",
          query: print(testConnectionQuery),
        }),
      },
      { name: "Sitecore Authoring sites query", signal, retryable: true },
    );

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
}

export interface AuthoringLanguage {
  readonly name: string;
  readonly displayName: string;
  readonly englishName: string;
  readonly nativeName: string;
}

export type AuthoringFieldScope = "VERSIONED" | "UNVERSIONED" | "SHARED";

export interface AuthoringItemField {
  readonly fieldId: string;
  readonly name: string;
  readonly label: string;
  readonly value: string;
  readonly type: string;
  readonly typeKey: string;
  readonly scope: AuthoringFieldScope;
  readonly sortOrder: number;
  readonly sectionName: string;
  readonly sectionSortOrder: number;
  readonly isStandardTemplate: boolean;
  readonly containsFallbackValue: boolean;
  readonly containsInheritedValue: boolean;
  readonly containsStandardValue: boolean;
  readonly textual: boolean;
}

export interface AuthoringItemDetails {
  readonly itemId: string;
  readonly path: string;
  readonly language: string;
  readonly version: number;
  readonly template: { readonly templateId: string; readonly name: string };
  readonly availableVersions: readonly { readonly language: string; readonly version: number }[];
  readonly fields: readonly AuthoringItemField[];
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

function parseItemDetails(
  value: RawItemDetails,
  nonStandardFieldIds: ReadonlySet<string>,
): AuthoringItemDetails {
  if (
    typeof value.itemId !== "string" ||
    typeof value.path !== "string" ||
    typeof value.language?.name !== "string" ||
    typeof value.version !== "number" ||
    typeof value.template?.templateId !== "string" ||
    typeof value.template.name !== "string"
  ) {
    throw new Error("Authoring API returned invalid item details.");
  }

  const fields = (value.fields?.nodes ?? []).map((field): AuthoringItemField => {
    const definition = field.templateField;
    if (
      typeof field.fieldId !== "string" ||
      typeof field.name !== "string" ||
      typeof field.value !== "string" ||
      typeof definition?.type !== "string" ||
      typeof definition.typeKey !== "string" ||
      !isFieldScope(definition.versioning)
    ) {
      throw new Error("Authoring API returned an invalid item field.");
    }
    return {
      fieldId: field.fieldId,
      name: field.name,
      label: typeof field.label === "string" && field.label ? field.label : field.name,
      value: field.value,
      type: definition.type,
      typeKey: definition.typeKey,
      scope: definition.versioning,
      sortOrder: typeof definition.sortOrder === "number" ? definition.sortOrder : 0,
      sectionName: typeof definition.section?.name === "string" ? definition.section.name : "",
      sectionSortOrder:
        typeof definition.section?.sortOrder === "number" ? definition.section.sortOrder : 0,
      isStandardTemplate: !nonStandardFieldIds.has(normalizeGuid(field.fieldId)),
      containsFallbackValue: field.containsFallbackValue === true,
      containsInheritedValue: field.containsInheritedValue === true,
      containsStandardValue: field.containsStandardValue === true,
      textual: isTextualField(definition.typeKey, definition.type),
    };
  });

  fields.sort((left, right) =>
    left.sectionSortOrder - right.sectionSortOrder ||
    left.sortOrder - right.sortOrder ||
    left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
  );

  const availableVersions = (value.versions ?? [])
    .filter(
      (version): version is { readonly language: { readonly name: string }; readonly version: number } =>
        typeof version.language?.name === "string" && typeof version.version === "number",
    )
    .map((version) => ({ language: version.language.name, version: version.version }));

  return {
    itemId: value.itemId,
    path: value.path,
    language: value.language.name,
    version: value.version,
    template: { templateId: value.template.templateId, name: value.template.name },
    availableVersions,
    fields,
  };
}

function nextCursor(pageInfo: RawPageInfo | undefined, collectionName: string): string | undefined {
  if (pageInfo?.hasNextPage !== true) {
    return undefined;
  }
  if (typeof pageInfo.endCursor !== "string") {
    throw new Error(`Authoring API reported another ${collectionName} page without a cursor.`);
  }
  return pageInfo.endCursor;
}

function assertNewCursor(
  cursor: string | undefined,
  seenCursors: Set<string>,
  collectionName: string,
): void {
  if (!cursor) {
    return;
  }
  if (seenCursors.has(cursor)) {
    throw new Error(`Authoring API returned the same ${collectionName} cursor twice.`);
  }
  seenCursors.add(cursor);
}

function normalizeGuid(value: string): string {
  return value.replace(/[{}-]/g, "").toLowerCase();
}

function isFieldScope(value: unknown): value is AuthoringFieldScope {
  return value === "VERSIONED" || value === "UNVERSIONED" || value === "SHARED";
}

function isTextualField(typeKey: string, type: string): boolean {
  const normalized = `${typeKey} ${type}`.toLowerCase();
  return ["text", "html", "rich", "layout", "json", "xml", "code"].some((token) =>
    normalized.includes(token),
  );
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
