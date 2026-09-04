import {
  deepStrictEqual,
  match,
  strictEqual,
} from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as vscode from "vscode";
import type { XmCloudConnection } from "../../src/connections/connection";
import type { AuthoringContentClient } from "../../src/sitecore/authoringClient";
import { JavaScriptTaskHost } from "../../src/tasks/javascriptTaskHost";
import type { IntegrationTest } from "./testSupport";

const extensionId = "OzrenTK.sitecore-xm-cloud-sync";

interface AuthoringCall {
  readonly operation: string;
  readonly input: unknown;
  readonly language?: string;
  readonly version?: number;
  readonly permanently?: boolean;
}

class TaskOutput {
  text = "";

  append(value: string): void {
    this.text += value;
  }
}

export const javaScriptTaskHostTests: readonly IntegrationTest[] = [
  {
    name: "JavaScript item tasks execute in a worker and route Authoring operations",
    async execute(): Promise<void> {
      await withTaskScript(`
export async function run(context, sitecore, log) {
  const item = await sitecore.items.get({ itemId: " item-1 ", version: 2 });
  const children = await sitecore.items.getChildren({ path: " /sitecore/content ", language: " da " });
  const created = await sitecore.items.create({
    name: " New item ",
    templateId: " template-1 ",
    parent: " parent-1 ",
    fields: { Title: "Created" },
  });
  const updated = await sitecore.items.update({
    itemId: " item-1 ",
    version: 2,
    fields: { Title: "Updated" },
  });
  const deleted = await sitecore.items.delete({ path: " /sitecore/content/Old ", permanently: true });
  log.info("worker-log", context.marker);
  return {
    status: "ok",
    message: [item.itemId, children.count, created.itemId, updated.itemId, deleted.successful].join("|"),
  };
}
`, async (scriptPath, workingDirectory) => {
        const calls: AuthoringCall[] = [];
        const authoringClient = authoringClientFor(calls);
        const output = new TaskOutput();
        const source = new vscode.CancellationTokenSource();
        try {
          const outcome = await new JavaScriptTaskHost(authoringClient).run({
            workerPath: workerPath(),
            scriptPath,
            workingDirectory,
            context: { marker: "context-marker" },
            connection: connection(),
            clientSecret: "client-secret",
            defaultLanguage: "en",
            cancellationToken: source.token,
            output: output as unknown as vscode.OutputChannel,
          });

          deepStrictEqual(outcome, {
            cancelled: false,
            exitCode: 0,
            result: {
              status: "ok",
              message: "item-1|0|created-item|item-1|true",
            },
          });
          deepStrictEqual(calls, [
            {
              operation: "items.get",
              input: { itemId: "item-1" },
              language: "en",
              version: 2,
            },
            {
              operation: "items.getChildren",
              input: { path: "/sitecore/content" },
              language: "da",
            },
            {
              operation: "items.create",
              input: {
                name: "New item",
                templateId: "template-1",
                parent: "parent-1",
                language: "en",
                fields: { Title: "Created" },
              },
            },
            {
              operation: "items.update",
              input: {
                itemId: "item-1",
                language: "en",
                version: 2,
                fields: { Title: "Updated" },
              },
            },
            {
              operation: "items.delete",
              input: { path: "/sitecore/content/Old" },
              permanently: true,
            },
          ]);
          match(output.text, /worker-log context-marker/u);
          strictEqual(output.text.includes("client-secret"), false);
        } finally {
          source.dispose();
        }
      });
    },
  },
  {
    name: "JavaScript item tasks return validated Authoring request failures",
    async execute(): Promise<void> {
      await withTaskScript(`
export async function run(_context, sitecore) {
  await sitecore.items.update({ itemId: "", version: 0, fields: {} });
}
`, async (scriptPath, workingDirectory) => {
        const output = new TaskOutput();
        const source = new vscode.CancellationTokenSource();
        try {
          const outcome = await new JavaScriptTaskHost(authoringClientFor([])).run({
            workerPath: workerPath(),
            scriptPath,
            workingDirectory,
            context: {},
            connection: connection(),
            clientSecret: "client-secret",
            defaultLanguage: "en",
            cancellationToken: source.token,
            output: output as unknown as vscode.OutputChannel,
          });

          strictEqual(outcome.cancelled, false);
          strictEqual(outcome.exitCode, 1);
          deepStrictEqual(outcome.result, {
            status: "error",
            message: "itemId must be a non-empty string.",
          });
          match(output.text, /itemId must be a non-empty string/u);
        } finally {
          source.dispose();
        }
      });
    },
  },
  {
    name: "JavaScript item task cancellation aborts in-flight Authoring work",
    async execute(): Promise<void> {
      await withTaskScript(`
export async function run(_context, sitecore) {
  await sitecore.items.get({ itemId: "item-1" });
}
`, async (scriptPath, workingDirectory) => {
        let activeSignal: AbortSignal | undefined;
        let reportStarted: (() => void) | undefined;
        const started = new Promise<void>((resolve) => {
          reportStarted = resolve;
        });
        const authoringClient = {
          loadItem: async (
            _connection: unknown,
            _secret: string,
            _locator: unknown,
            _language: string,
            _version: number | undefined,
            signal: AbortSignal,
          ): Promise<never> => {
            activeSignal = signal;
            reportStarted?.();
            return await new Promise<never>((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
          },
        } as unknown as AuthoringContentClient;
        const output = new TaskOutput();
        const source = new vscode.CancellationTokenSource();
        try {
          const outcomePromise = new JavaScriptTaskHost(authoringClient).run({
            workerPath: workerPath(),
            scriptPath,
            workingDirectory,
            context: {},
            connection: connection(),
            clientSecret: "client-secret",
            defaultLanguage: "en",
            cancellationToken: source.token,
            output: output as unknown as vscode.OutputChannel,
          });
          await withTimeout(started, "JavaScript task did not start its Authoring request.");
          source.cancel();
          const outcome = await withTimeout(
            outcomePromise,
            "JavaScript task worker did not stop after cancellation.",
          );

          strictEqual(outcome.cancelled, true);
          strictEqual(activeSignal?.aborted, true);
        } finally {
          source.dispose();
        }
      });
    },
  },
];

function authoringClientFor(calls: AuthoringCall[]): AuthoringContentClient {
  return {
    loadItem: async (
      _connection: unknown,
      _secret: string,
      locator: unknown,
      language: string,
      version: number | undefined,
    ) => {
      calls.push({ operation: "items.get", input: locator, language, version });
      return { itemId: "item-1" };
    },
    loadTreeLevel: async (
      _connection: unknown,
      _secret: string,
      locator: unknown,
      language: string,
    ) => {
      calls.push({ operation: "items.getChildren", input: locator, language });
      return { count: 0 };
    },
    createItem: async (
      _connection: unknown,
      _secret: string,
      input: unknown,
    ) => {
      calls.push({ operation: "items.create", input });
      return { itemId: "created-item" };
    },
    updateItemFields: async (
      _connection: unknown,
      _secret: string,
      input: unknown,
    ) => {
      calls.push({ operation: "items.update", input });
      return { itemId: "item-1" };
    },
    deleteItem: async (
      _connection: unknown,
      _secret: string,
      input: unknown,
    ) => {
      const candidate = input as { readonly permanently?: boolean };
      calls.push({
        operation: "items.delete",
        input: withoutProperty(input, "permanently"),
        permanently: candidate.permanently,
      });
    },
  } as unknown as AuthoringContentClient;
}

function withoutProperty(value: unknown, property: string): unknown {
  const candidate = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(candidate).filter(([key]) => key !== property));
}

function connection(): XmCloudConnection {
  return {
    id: "connection-1",
    name: "Integration",
    serverUrl: "https://authoring.example.com",
    clientId: "client-id",
    createdAt: "2026-09-04T00:00:00.000Z",
  };
}

function workerPath(): string {
  return vscode.Uri.joinPath(
    extensionUri(),
    "out",
    "javascriptTaskWorker.js",
  ).fsPath;
}

function extensionUri(): vscode.Uri {
  const extension = vscode.extensions.getExtension(extensionId);
  if (!extension) {
    throw new Error(`Extension ${extensionId} was not discovered by the test host.`);
  }
  return extension.extensionUri;
}

async function withTaskScript(
  contents: string,
  execute: (scriptPath: string, workingDirectory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(
    extensionUri().fsPath,
    ".test-out",
    "xm-cloud-sync-js-task-",
  ));
  const scriptPath = join(directory, "task.mjs");
  try {
    await writeFile(scriptPath, contents, "utf8");
    await execute(scriptPath, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), 5_000);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
