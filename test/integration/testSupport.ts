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
