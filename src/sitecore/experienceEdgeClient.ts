import { SitecoreHttpClient, type SitecoreHttpLogger } from "./sitecoreHttpClient";

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

export class ExperienceEdgeClient {
  private readonly http: SitecoreHttpClient;

  constructor(log: SitecoreHttpLogger) {
    this.http = new SitecoreHttpClient(log);
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
    const fields: Record<string, string> = {};
    for (const field of item.fields ?? []) {
      if (typeof field.name === "string" && typeof field.value === "string") {
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
    let payload: T;
    try {
      payload = JSON.parse(text) as T;
    } catch {
      throw new Error(`${name} returned invalid JSON.`);
    }
    if (!response.ok) {
      throw new Error(`${name} failed (${response.status}).`);
    }
    if (payload.errors?.length) {
      const messages = payload.errors
        .map((error) => error.message)
        .filter((value): value is string => typeof value === "string")
        .join("; ");
      throw new Error(messages || `${name} returned a GraphQL error.`);
    }
    return payload;
  }
}
