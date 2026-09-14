import type { XmCloudConnection } from "../connections/connection";
import { SitecoreHttpClient, type SitecoreHttpLogger } from "./sitecoreHttpClient";

const tokenEndpoint = "https://auth.sitecorecloud.io/oauth/token";
const audience = "https://api.sitecorecloud.io";
const deployApiBase = "https://xmclouddeploy-api.sitecorecloud.io";

interface CachedToken {
  readonly value: string;
  readonly expiresAt: number;
}

interface TokenResponse {
  readonly access_token?: unknown;
  readonly expires_in?: unknown;
}

interface EnvironmentDto {
  readonly id?: unknown;
  readonly host?: unknown;
}

interface EnvironmentPage {
  readonly data?: unknown;
  readonly totalCount?: unknown;
  readonly pageNumber?: unknown;
  readonly pageSize?: unknown;
}

interface DeploymentDto {
  readonly id?: unknown;
  readonly createdAt?: unknown;
  readonly startedAt?: unknown;
  readonly deploymentStartedAt?: unknown;
}

export interface DeploymentCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface DeploymentBaseline {
  readonly environmentId: string;
  readonly deploymentId?: string;
  readonly createdAt?: string;
  readonly startedAt?: string;
  readonly deploymentStartedAt?: string;
}

export class DeploymentClient {
  private readonly tokens = new Map<string, CachedToken>();
  private readonly http: SitecoreHttpClient;

  constructor(log: SitecoreHttpLogger) {
    this.http = new SitecoreHttpClient(log);
  }

  async resolveEnvironment(
    connection: XmCloudConnection,
    credentials: DeploymentCredentials,
    signal: AbortSignal,
  ): Promise<DeploymentBaseline> {
    const token = await this.getAccessToken(credentials, signal);
    const expectedHost = new URL(connection.serverUrl).hostname.toLowerCase();
    let pageNumber = 1;
    while (true) {
      const url = new URL("/api/environments/v1", deployApiBase);
      url.searchParams.set("PageNumber", String(pageNumber));
      url.searchParams.set("PageSize", "50");
      const page = await this.getJson<EnvironmentPage>(url, token, "list deployment environments", signal);
      const environments = Array.isArray(page.data) ? page.data as EnvironmentDto[] : [];
      const match = environments.find((environment) =>
        typeof environment.host === "string" && normalizeHost(environment.host) === expectedHost
      );
      if (match && typeof match.id === "string" && match.id) {
        return this.getLatestDeployment(match.id, credentials, signal);
      }
      const totalCount = finiteNumber(page.totalCount, environments.length);
      const pageSize = finiteNumber(page.pageSize, 50);
      if (pageNumber * pageSize >= totalCount || environments.length === 0) {
        break;
      }
      pageNumber += 1;
    }
    throw new Error(
      `Deployment monitoring could not match ${connection.serverUrl} to an environment visible to the organization automation client.`,
    );
  }

  async getLatestDeployment(
    environmentId: string,
    credentials: DeploymentCredentials,
    signal: AbortSignal,
  ): Promise<DeploymentBaseline> {
    const token = await this.getAccessToken(credentials, signal);
    const url = new URL(
      `/api/environments/v1/${encodeURIComponent(environmentId)}/deployments`,
      deployApiBase,
    );
    const payload = await this.getJson<unknown>(url, token, "get latest environment deployment", signal);
    const deployments = Array.isArray(payload) ? payload as DeploymentDto[] : [];
    const latest = deployments
      .filter((deployment): deployment is DeploymentDto & { readonly id: string } =>
        typeof deployment.id === "string" && deployment.id.length > 0
      )
      .sort((left, right) => deploymentTime(right) - deploymentTime(left))[0];
    return {
      environmentId,
      deploymentId: latest?.id,
      createdAt: stringValue(latest?.createdAt),
      startedAt: stringValue(latest?.startedAt),
      deploymentStartedAt: stringValue(latest?.deploymentStartedAt),
    };
  }

  clear(): void {
    this.tokens.clear();
    this.http.clear();
  }

  private async getAccessToken(
    credentials: DeploymentCredentials,
    signal: AbortSignal,
  ): Promise<string> {
    const cached = this.tokens.get(credentials.clientId);
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
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
        }),
      },
      { name: "Sitecore Deploy OAuth token request", signal, retryable: true },
    );
    const payload = await readJson<TokenResponse>(response, "Sitecore Deploy OAuth token request");
    if (!response.ok || typeof payload.access_token !== "string" || !payload.access_token) {
      throw new Error(`Deployment monitoring authentication failed (${response.status}).`);
    }
    const expiresIn = typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in)
      ? payload.expires_in
      : 300;
    this.tokens.set(credentials.clientId, {
      value: payload.access_token,
      expiresAt: Date.now() + Math.max(expiresIn - 60, 30) * 1_000,
    });
    return payload.access_token;
  }

  private async getJson<T>(
    url: URL,
    token: string,
    name: string,
    signal: AbortSignal,
  ): Promise<T> {
    const response = await this.http.request(
      url,
      { method: "GET", headers: { authorization: `Bearer ${token}` } },
      { name, signal, retryable: true },
    );
    const payload = await readJson<T>(response, name);
    if (!response.ok) {
      throw new Error(`${name} failed (${response.status}).`);
    }
    return payload;
  }
}

function normalizeHost(value: string): string {
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).hostname.toLowerCase();
  } catch {
    return value.trim().replace(/^https?:\/\//iu, "").replace(/\/$/u, "").toLowerCase();
  }
}

function deploymentTime(deployment: DeploymentDto): number {
  for (const value of [deployment.createdAt, deployment.startedAt, deployment.deploymentStartedAt]) {
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return 0;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function readJson<T>(response: Response, name: string): Promise<T> {
  const text = await response.text();
  if (!text) {
    throw new Error(`${name} returned an empty response.`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${name} returned invalid JSON.`);
  }
}
