import {
  SitecoreHttpClient,
  type SitecoreHttpLogger,
  type SitecoreHttpRuntime,
} from "./sitecoreHttpClient";

interface EdgeGraphQlError {
  readonly message?: unknown;
}

interface EdgeItemResponse {
  readonly data?: {
    readonly item?: {
      readonly id?: unknown;
      readonly name?: unknown;
      readonly path?: unknown;
      readonly fields?: readonly { readonly name?: unknown; readonly value?: unknown }[];
    } | null;
  };
  readonly errors?: readonly EdgeGraphQlError[];
}

interface EdgeLayoutResponse {
  readonly data?: {
    readonly layout?: {
      readonly item?: { readonly id?: unknown; readonly rendered?: unknown } | null;
    } | null;
  };
  readonly errors?: readonly EdgeGraphQlError[];
}

interface EdgeSitesResponse {
  readonly data?: {
    readonly site?: {
      readonly allSiteInfo?: {
        readonly results?: readonly {
          readonly name?: unknown;
          readonly hostname?: unknown;
          readonly rootPath?: unknown;
        }[];
      } | null;
    } | null;
  };
  readonly errors?: readonly EdgeGraphQlError[];
}

export interface EdgeItem {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly fields: Readonly<Record<string, string>>;
}

export interface ApplicationProbe {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface EdgeRenderedLayout {
  readonly itemId?: string;
  readonly rendered: string;
}

export interface EdgeSiteInfo {
  readonly name: string;
  readonly hostname?: string;
  readonly rootPath?: string;
}

export class ExperienceEdgeClient {
  private readonly http: SitecoreHttpClient;

  constructor(log: SitecoreHttpLogger, httpRuntime?: SitecoreHttpRuntime) {
    this.http = new SitecoreHttpClient(log, httpRuntime);
  }

  async item(
    endpoint: string,
    token: string,
    itemId: string,
    language: string,
    signal: AbortSignal,
  ): Promise<EdgeItem | undefined> {
    const payload = await this.query<EdgeItemResponse>(
      endpoint,
      token,
      "query Experience Edge item",
      `query XmCloudSyncEdgeItem($path: String!, $language: String!) {
        item(path: $path, language: $language) {
          id
          name
          path
          fields {
            name
            value
          }
        }
      }`,
      { path: itemId, language },
      signal,
    );
    const item = payload.data?.item;
    if (!item) {
      return undefined;
    }
    if (
      typeof item.id !== "string" ||
      typeof item.name !== "string" ||
      typeof item.path !== "string"
    ) {
      throw new Error("Experience Edge returned an invalid item.");
    }
    if (item.fields !== undefined && !Array.isArray(item.fields)) {
      throw new Error("Experience Edge returned an invalid item.");
    }
    const fields: Record<string, string> = {};
    for (const field of item.fields ?? []) {
      if (
        isRecord(field) &&
        typeof field.name === "string" &&
        typeof field.value === "string"
      ) {
        fields[field.name] = field.value;
      }
    }
    return { id: item.id, name: item.name, path: item.path, fields };
  }

  async renderedLayout(
    endpoint: string,
    token: string,
    siteName: string,
    route: string,
    language: string,
    signal: AbortSignal,
  ): Promise<EdgeRenderedLayout | undefined> {
    const payload = await this.query<EdgeLayoutResponse>(
      endpoint,
      token,
      "query Experience Edge rendered layout",
      `query XmCloudSyncEdgeLayout($site: String!, $route: String!, $language: String!) {
        layout(site: $site, routePath: $route, language: $language) {
          item {
            id
            rendered
          }
        }
      }`,
      { site: siteName, route, language },
      signal,
    );
    const item = payload.data?.layout?.item;
    const rendered = item?.rendered;
    const serialized = typeof rendered === "string"
      ? rendered
      : rendered === undefined || rendered === null
        ? undefined
        : JSON.stringify(rendered);
    return serialized
      ? { itemId: typeof item?.id === "string" ? item.id : undefined, rendered: serialized }
      : undefined;
  }

  async listSites(
    endpoint: string,
    token: string,
    signal: AbortSignal,
  ): Promise<readonly EdgeSiteInfo[]> {
    const payload = await this.query<EdgeSitesResponse>(
      endpoint,
      token,
      "query Experience Edge sites",
      `query XmCloudSyncEdgeSites {
        site {
          allSiteInfo {
            results {
              name
              hostname
              rootPath
            }
          }
        }
      }`,
      {},
      signal,
    );
    const sites = payload.data?.site?.allSiteInfo?.results ?? [];
    if (!Array.isArray(sites)) {
      throw new Error("Experience Edge returned an invalid site list.");
    }
    return sites.flatMap(
      (site): readonly EdgeSiteInfo[] => isRecord(site) && typeof site.name === "string"
        ? [{
            name: site.name,
            hostname: typeof site.hostname === "string" ? site.hostname : undefined,
            rootPath: typeof site.rootPath === "string" ? site.rootPath : undefined,
          }]
        : [],
    );
  }

  async probeApplication(url: string, signal: AbortSignal): Promise<ApplicationProbe> {
    const response = await this.http.request(
      url,
      {
        method: "GET",
        headers: {
          accept: "text/html,application/xhtml+xml,application/json",
          "cache-control": "no-cache",
        },
      },
      { name: "probe published application response", signal, retryable: true },
    );
    const body = (await response.text()).slice(0, 5_000_000);
    const headers: Record<string, string> = {};
    for (const name of ["age", "cache-control", "x-vercel-cache", "x-vercel-id", "content-type"]) {
      const value = response.headers.get(name);
      if (value) {
        headers[name] = value;
      }
    }
    return { status: response.status, headers, body };
  }

  clear(): void {
    this.http.clear();
  }

  private async query<T extends { readonly errors?: readonly EdgeGraphQlError[] }>(
    endpoint: string,
    token: string,
    name: string,
    query: string,
    variables: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<T> {
    const response = await this.http.request(
      endpoint,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          sc_apikey: token,
        },
        body: JSON.stringify({ query, variables }),
      },
      { name, signal, retryable: true },
    );
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new Error(`${name} returned invalid JSON.`);
    }
    if (!isRecord(parsed)) {
      throw new Error(`${name} returned an invalid response.`);
    }
    const payload = parsed as T;
    if (!response.ok) {
      throw new Error(`${name} failed (${response.status}).`);
    }
    const errors = payload.errors;
    if (errors !== undefined && !Array.isArray(errors)) {
      throw new Error(`${name} returned an invalid response.`);
    }
    if (errors?.length) {
      const messages = errors
        .flatMap((error): readonly string[] =>
          isRecord(error) && typeof error.message === "string" ? [error.message] : []
        )
        .join("; ");
      throw new Error(messages || `${name} returned a GraphQL error.`);
    }
    return payload;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
