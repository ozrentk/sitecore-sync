import * as vscode from "vscode";

export interface IntegrationTest {
  readonly name: string;
  readonly execute: () => Promise<void>;
}

export class MemoryMemento implements vscode.Memento {
  readonly writes: { readonly key: string; readonly value: unknown }[] = [];
  updateCalls = 0;
  updateOverride:
    | ((key: string, value: unknown, call: number) => Promise<void>)
    | undefined;
  private readonly values = new Map<string, unknown>();

  constructor(initialValues: Readonly<Record<string, unknown>> = {}) {
    for (const [key, value] of Object.entries(initialValues)) {
      this.values.set(key, value);
    }
  }

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.updateCalls += 1;
    await this.updateOverride?.(key, value, this.updateCalls);
    if (value === undefined) {
      this.values.delete(key);
    } else {
      this.values.set(key, value);
    }
    this.writes.push({ key, value });
  }

  keys(): readonly string[] {
    return [...this.values.keys()];
  }
}

export class MemorySecretStorage implements vscode.SecretStorage, vscode.Disposable {
  readonly stores: { readonly key: string; readonly value: string }[] = [];
  readonly deletes: string[] = [];
  storeCalls = 0;
  deleteCalls = 0;
  storeOverride:
    | ((key: string, value: string, call: number) => Promise<void>)
    | undefined;
  deleteOverride:
    | ((key: string, call: number) => Promise<void>)
    | undefined;
  private readonly values = new Map<string, string>();
  private readonly changeEmitter = new vscode.EventEmitter<vscode.SecretStorageChangeEvent>();

  readonly onDidChange = this.changeEmitter.event;

  constructor(initialValues: Readonly<Record<string, string>> = {}) {
    for (const [key, value] of Object.entries(initialValues)) {
      this.values.set(key, value);
    }
  }

  async keys(): Promise<string[]> {
    return [...this.values.keys()];
  }

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.storeCalls += 1;
    await this.storeOverride?.(key, value, this.storeCalls);
    this.values.set(key, value);
    this.stores.push({ key, value });
    this.changeEmitter.fire({ key });
  }

  async delete(key: string): Promise<void> {
    this.deleteCalls += 1;
    await this.deleteOverride?.(key, this.deleteCalls);
    this.values.delete(key);
    this.deletes.push(key);
    this.changeEmitter.fire({ key });
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}
