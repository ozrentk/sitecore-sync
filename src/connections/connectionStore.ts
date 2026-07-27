import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { NewXmCloudConnection, XmCloudConnection } from "./connection";
import type { AuthoringSite } from "../sitecore/authoringClient";

const connectionsKey = "sitecoreXmCloudSync.connections.v1";
const secretPrefix = "sitecoreXmCloudSync.connectionSecret.v1";
const deploymentSecretPrefix = "sitecoreXmCloudSync.deploymentSecret.v1";
const speCredentialSecretPrefix = "sitecoreXmCloudSync.speCredential.v1";
const favoritePathsKey = "sitecoreXmCloudSync.favoritePaths.v1";
const verifiedSitesKey = "sitecoreXmCloudSync.verifiedSites.v1";

interface StoredFavoritePath {
  readonly connectionId: string;
  readonly path: string;
}

interface StoredVerifiedSites {
  readonly connectionId: string;
  readonly sites: readonly AuthoringSite[];
}

function secretKey(connectionId: string): string {
  return `${secretPrefix}.${connectionId}`;
}

function deploymentSecretKey(connectionId: string): string {
  return `${deploymentSecretPrefix}.${connectionId}`;
}

function speCredentialSecretKey(connectionId: string): string {
  return `${speCredentialSecretPrefix}.${connectionId}`;
}

export interface SpeCredential {
  readonly username: string;
  readonly password: string;
}

function isConnection(value: unknown): value is XmCloudConnection {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<XmCloudConnection>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.serverUrl === "string" &&
    typeof candidate.clientId === "string" &&
    typeof candidate.createdAt === "string"
  );
}

export class ConnectionStore implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();

  readonly onDidChange = this.changeEmitter.event;

  constructor(
    private readonly globalState: vscode.Memento,
    private readonly secrets: vscode.SecretStorage,
  ) {}

  list(): readonly XmCloudConnection[] {
    const stored = this.globalState.get<unknown>(connectionsKey, []);
    if (!Array.isArray(stored)) {
      return [];
    }

    return stored.filter(isConnection).sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
    );
  }

  get(connectionId: string): XmCloudConnection | undefined {
    return this.list().find((connection) => connection.id === connectionId);
  }

  hasName(name: string): boolean {
    return this.list().some(
      (connection) => connection.name.localeCompare(name, undefined, { sensitivity: "base" }) === 0,
    );
  }

  listFavoritePaths(connectionId: string): readonly string[] {
    return this.readFavorites()
      .filter((favorite) => favorite.connectionId === connectionId)
      .map((favorite) => favorite.path)
      .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }));
  }

  listVerifiedSites(connectionId: string): readonly AuthoringSite[] {
    return this.readVerifiedSites()
      .find((entry) => entry.connectionId === connectionId)
      ?.sites ?? [];
  }

  hasVerifiedSiteCatalog(connectionId: string): boolean {
    return this.readVerifiedSites().some((entry) => entry.connectionId === connectionId);
  }

  async storeVerifiedSites(
    connectionId: string,
    sites: readonly AuthoringSite[],
  ): Promise<void> {
    if (!this.get(connectionId)) {
      throw new Error("The XM Cloud connection no longer exists.");
    }
    const remaining = this.readVerifiedSites().filter((entry) =>
      entry.connectionId !== connectionId
    );
    await this.globalState.update(verifiedSitesKey, [
      ...remaining,
      { connectionId, sites: [...sites] },
    ]);
    this.changeEmitter.fire();
  }

  async addFavoritePath(connectionId: string, path: string): Promise<boolean> {
    if (!this.get(connectionId)) {
      throw new Error("The XM Cloud connection no longer exists.");
    }
    const normalizedPath = normalizeFavoritePath(path);
    const favorites = this.readFavorites();
    if (favorites.some((favorite) =>
      favorite.connectionId === connectionId &&
      favorite.path.localeCompare(normalizedPath, undefined, { sensitivity: "base" }) === 0
    )) {
      return false;
    }
    await this.globalState.update(favoritePathsKey, [
      ...favorites,
      { connectionId, path: normalizedPath },
    ]);
    this.changeEmitter.fire();
    return true;
  }

  async removeFavoritePath(connectionId: string, path: string): Promise<void> {
    const favorites = this.readFavorites().filter((favorite) => !(
      favorite.connectionId === connectionId &&
      favorite.path.localeCompare(path, undefined, { sensitivity: "base" }) === 0
    ));
    await this.globalState.update(favoritePathsKey, favorites);
    this.changeEmitter.fire();
  }

  async add(input: NewXmCloudConnection): Promise<XmCloudConnection> {
    const connection: XmCloudConnection = {
      id: randomUUID(),
      name: input.name,
      serverUrl: input.serverUrl,
      clientId: input.clientId,
      createdAt: new Date().toISOString(),
    };

    await this.secrets.store(secretKey(connection.id), input.clientSecret);
    try {
      await this.globalState.update(connectionsKey, [...this.list(), connection]);
    } catch (error: unknown) {
      await this.secrets.delete(secretKey(connection.id));
      throw error;
    }

    this.changeEmitter.fire();
    return connection;
  }

  async getClientSecret(connectionId: string): Promise<string | undefined> {
    return this.secrets.get(secretKey(connectionId));
  }

  async configureDeploymentMonitoring(
    connectionId: string,
    clientId: string,
    clientSecret: string,
    environmentId: string,
  ): Promise<void> {
    const connection = this.get(connectionId);
    if (!connection) {
      throw new Error("The XM Cloud connection no longer exists.");
    }
    await this.secrets.store(deploymentSecretKey(connectionId), clientSecret);
    try {
      await this.globalState.update(
        connectionsKey,
        this.list().map((candidate) => candidate.id === connectionId
          ? {
              ...candidate,
              deploymentClientId: clientId,
              deploymentEnvironmentId: environmentId,
            }
          : candidate),
      );
    } catch (error: unknown) {
      await this.secrets.delete(deploymentSecretKey(connectionId));
      throw error;
    }
    this.changeEmitter.fire();
  }

  async getDeploymentClientSecret(connectionId: string): Promise<string | undefined> {
    return this.secrets.get(deploymentSecretKey(connectionId));
  }

  async getSpeCredential(connectionId: string): Promise<SpeCredential | undefined> {
    const stored = await this.secrets.get(speCredentialSecretKey(connectionId));
    if (!stored) {
      return undefined;
    }
    try {
      const credential = JSON.parse(stored) as Partial<SpeCredential>;
      return typeof credential.username === "string" && credential.username.trim() &&
          typeof credential.password === "string" && credential.password
        ? { username: credential.username, password: credential.password }
        : undefined;
    } catch {
      return undefined;
    }
  }

  async storeSpeCredential(
    connectionId: string,
    username: string,
    password: string,
  ): Promise<void> {
    if (!this.get(connectionId)) {
      throw new Error("The XM Cloud connection no longer exists.");
    }
    await this.secrets.store(
      speCredentialSecretKey(connectionId),
      JSON.stringify({ username, password } satisfies SpeCredential),
    );
  }

  async deleteSpeCredential(connectionId: string): Promise<void> {
    await this.secrets.delete(speCredentialSecretKey(connectionId));
  }

  async remove(connectionId: string): Promise<void> {
    const remaining = this.list().filter((connection) => connection.id !== connectionId);
    await this.globalState.update(connectionsKey, remaining);
    await this.globalState.update(
      favoritePathsKey,
      this.readFavorites().filter((favorite) => favorite.connectionId !== connectionId),
    );
    await this.globalState.update(
      verifiedSitesKey,
      this.readVerifiedSites().filter((entry) => entry.connectionId !== connectionId),
    );
    await this.secrets.delete(secretKey(connectionId));
    await this.secrets.delete(deploymentSecretKey(connectionId));
    await this.secrets.delete(speCredentialSecretKey(connectionId));
    this.changeEmitter.fire();
  }

  private readFavorites(): readonly StoredFavoritePath[] {
    const stored = this.globalState.get<unknown>(favoritePathsKey, []);
    if (!Array.isArray(stored)) {
      return [];
    }
    return stored.filter((favorite): favorite is StoredFavoritePath => Boolean(
      favorite &&
      typeof favorite === "object" &&
      typeof (favorite as Partial<StoredFavoritePath>).connectionId === "string" &&
      typeof (favorite as Partial<StoredFavoritePath>).path === "string",
    ));
  }

  private readVerifiedSites(): readonly StoredVerifiedSites[] {
    const stored = this.globalState.get<unknown>(verifiedSitesKey, []);
    if (!Array.isArray(stored)) {
      return [];
    }
    return stored.flatMap((entry): readonly StoredVerifiedSites[] => {
      if (
        !entry ||
        typeof entry !== "object" ||
        typeof (entry as Partial<StoredVerifiedSites>).connectionId !== "string" ||
        !Array.isArray((entry as Partial<StoredVerifiedSites>).sites)
      ) {
        return [];
      }
      const sites = (entry as Partial<StoredVerifiedSites>).sites?.filter(
        (site): site is AuthoringSite => Boolean(
          site &&
          typeof site === "object" &&
          typeof (site as Partial<AuthoringSite>).name === "string" &&
          typeof (site as Partial<AuthoringSite>).rootPath === "string" &&
          (
            (site as Partial<AuthoringSite>).rootItemId === undefined ||
            typeof (site as Partial<AuthoringSite>).rootItemId === "string"
          ),
        ),
      ) ?? [];
      return [{ connectionId: (entry as StoredVerifiedSites).connectionId, sites }];
    });
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}

function normalizeFavoritePath(value: string): string {
  const trimmed = value.trim().replace(/\\/gu, "/").replace(/\/{2,}/gu, "/");
  if (trimmed !== "/sitecore" && !trimmed.startsWith("/sitecore/")) {
    throw new Error("Favorite paths must begin with /sitecore.");
  }
  return trimmed.length > 1 ? trimmed.replace(/\/$/u, "") : trimmed;
}
