import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { NewXmCloudConnection, XmCloudConnection } from "./connection";

const connectionsKey = "sitecoreXmCloudSync.connections.v1";
const secretPrefix = "sitecoreXmCloudSync.connectionSecret.v1";

function secretKey(connectionId: string): string {
  return `${secretPrefix}.${connectionId}`;
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

  async remove(connectionId: string): Promise<void> {
    const remaining = this.list().filter((connection) => connection.id !== connectionId);
    await this.globalState.update(connectionsKey, remaining);
    await this.secrets.delete(secretKey(connectionId));
    this.changeEmitter.fire();
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}
