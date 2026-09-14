export interface XmCloudConnection {
  readonly id: string;
  readonly name: string;
  readonly serverUrl: string;
  readonly clientId: string;
  readonly deploymentClientId?: string;
  readonly deploymentEnvironmentId?: string;
  readonly createdAt: string;
}

export interface NewXmCloudConnection {
  readonly name: string;
  readonly serverUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

export function normalizeServerUrl(value: string): string {
  const url = new URL(value.trim());

  if (url.protocol !== "https:") {
    throw new Error("XM Cloud server URL must use HTTPS.");
  }

  if (url.username || url.password) {
    throw new Error("Do not include credentials in the server URL.");
  }

  if (url.search || url.hash) {
    throw new Error("Server URL must not contain a query string or fragment.");
  }

  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error("Enter the CM server origin without an API path.");
  }

  return url.origin;
}
