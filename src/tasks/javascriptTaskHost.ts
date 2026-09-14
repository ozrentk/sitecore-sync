import { fork, type ChildProcess, type Serializable } from "node:child_process";
import * as vscode from "vscode";
import type { XmCloudConnection } from "../connections/connection";
import {
  type AuthoringContentClient,
  type AuthoringItemLocator,
} from "../sitecore/authoringClient";

export interface JavaScriptTaskResult {
  readonly status?: unknown;
  readonly message?: unknown;
}

export interface JavaScriptTaskOutcome {
  readonly cancelled: boolean;
  readonly exitCode: number | null;
  readonly result?: JavaScriptTaskResult;
}

export interface JavaScriptTaskOptions {
  readonly workerPath: string;
  readonly scriptPath: string;
  readonly workingDirectory: string;
  readonly context: unknown;
  readonly connection: XmCloudConnection;
  readonly clientSecret: string;
  readonly defaultLanguage: string;
  readonly cancellationToken: vscode.CancellationToken;
  readonly output: vscode.OutputChannel;
}

interface AuthoringRequestMessage {
  readonly type: "authoringRequest";
  readonly requestId: number;
  readonly operation: string;
  readonly input: unknown;
}

interface CompletionMessage {
  readonly type: "complete";
  readonly result?: JavaScriptTaskResult;
}

interface FailureMessage {
  readonly type: "failed";
  readonly error: string;
}

export class JavaScriptTaskHost {
  constructor(private readonly authoringClient: AuthoringContentClient) {}

  async run(options: JavaScriptTaskOptions): Promise<JavaScriptTaskOutcome> {
    const controller = new AbortController();
    let child: ChildProcess;
    try {
      child = fork(options.workerPath, [], {
        cwd: options.workingDirectory,
        execArgv: [],
        silent: true,
      });
    } catch (error: unknown) {
      throw new Error(`Unable to start the JavaScript task worker: ${errorMessage(error)}`);
    }

    child.stdout?.on("data", (chunk: Buffer | string) => options.output.append(String(chunk)));
    child.stderr?.on("data", (chunk: Buffer | string) => options.output.append(String(chunk)));

    return await new Promise<JavaScriptTaskOutcome>((resolve, reject) => {
      let settled = false;
      let cancelled = false;
      let declaredResult: JavaScriptTaskResult | undefined;
      let declaredFailure: string | undefined;
      let cancellation: vscode.Disposable | undefined;

      const settle = (outcome: JavaScriptTaskOutcome): void => {
        if (settled) {
          return;
        }
        settled = true;
        cancellation?.dispose();
        resolve(outcome);
      };
      cancellation = options.cancellationToken.onCancellationRequested(() => {
        cancelled = true;
        controller.abort(new DOMException("Task cancelled.", "AbortError"));
        child.kill();
      });

      child.on("error", (error) => {
        cancellation.dispose();
        if (!settled) {
          settled = true;
          reject(new Error(`JavaScript task worker failed: ${error.message}`));
        }
      });
      child.on("message", (message: unknown) => {
        if (isAuthoringRequest(message)) {
          void this.handleAuthoringRequest(message, options, controller.signal)
            .then((result) => sendToChild(child, {
              type: "authoringResponse",
              requestId: message.requestId,
              result,
            }))
            .catch((error: unknown) => sendToChild(child, {
              type: "authoringResponse",
              requestId: message.requestId,
              error: errorMessage(error),
            }));
        } else if (isCompletion(message)) {
          declaredResult = message.result;
        } else if (isFailure(message)) {
          declaredFailure = message.error;
        }
      });
      child.on("close", (code) => {
        cancellation.dispose();
        if (declaredFailure) {
          settle({
            cancelled,
            exitCode: code && code !== 0 ? code : 1,
            result: { status: "error", message: declaredFailure },
          });
          return;
        }
        settle({
          cancelled,
          exitCode: code,
          ...(declaredResult ? { result: declaredResult } : {}),
        });
      });

      sendToChild(child, {
        type: "start",
        scriptPath: options.scriptPath,
        context: options.context,
      });
    });
  }

  private async handleAuthoringRequest(
    message: AuthoringRequestMessage,
    options: JavaScriptTaskOptions,
    signal: AbortSignal,
  ): Promise<unknown> {
    const input = objectInput(message.input, message.operation);
    switch (message.operation) {
      case "items.get": {
        const locator = itemLocator(input);
        const language = optionalText(input.language, "language") ?? options.defaultLanguage;
        const version = optionalPositiveInteger(input.version, "version");
        return await this.authoringClient.loadItem(
          options.connection,
          options.clientSecret,
          locator,
          language,
          version,
          signal,
        );
      }
      case "items.getChildren": {
        const locator = itemLocator(input);
        const language = optionalText(input.language, "language") ?? options.defaultLanguage;
        return await this.authoringClient.loadTreeLevel(
          options.connection,
          options.clientSecret,
          locator,
          language,
          signal,
        );
      }
      case "items.create": {
        const fields = optionalFields(input.fields);
        return await this.authoringClient.createItem(
          options.connection,
          options.clientSecret,
          {
            name: requiredText(input.name, "name"),
            templateId: requiredText(input.templateId, "templateId"),
            parent: requiredText(input.parent, "parent"),
            language: optionalText(input.language, "language") ?? options.defaultLanguage,
            ...(fields ? { fields } : {}),
          },
          signal,
        );
      }
      case "items.update": {
        return await this.authoringClient.updateItemFields(
          options.connection,
          options.clientSecret,
          {
            itemId: requiredText(input.itemId, "itemId"),
            language: optionalText(input.language, "language") ?? options.defaultLanguage,
            version: requiredPositiveInteger(input.version, "version"),
            fields: requiredFields(input.fields),
          },
          signal,
        );
      }
      case "items.delete": {
        const locator = itemLocator(input);
        const permanently = optionalBoolean(input.permanently, "permanently") ?? false;
        await this.authoringClient.deleteItem(
          options.connection,
          options.clientSecret,
          { ...locator, permanently },
          signal,
        );
        return { successful: true };
      }
      default:
        throw new Error(`Unsupported Authoring task operation “${message.operation}”.`);
    }
  }
}

function isAuthoringRequest(value: unknown): value is AuthoringRequestMessage {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<AuthoringRequestMessage>;
  return candidate.type === "authoringRequest" &&
    typeof candidate.requestId === "number" &&
    typeof candidate.operation === "string";
}

function isCompletion(value: unknown): value is CompletionMessage {
  return Boolean(value) && typeof value === "object" &&
    (value as Partial<CompletionMessage>).type === "complete";
}

function isFailure(value: unknown): value is FailureMessage {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<FailureMessage>;
  return candidate.type === "failed" && typeof candidate.error === "string";
}

function objectInput(value: unknown, operation: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${operation} requires an input object.`);
  }
  return value as Record<string, unknown>;
}

function itemLocator(input: Record<string, unknown>): AuthoringItemLocator {
  const itemId = optionalText(input.itemId, "itemId");
  const path = optionalText(input.path, "path");
  if (Boolean(itemId) === Boolean(path)) {
    throw new Error("Specify exactly one of itemId or path.");
  }
  return itemId ? { itemId } : { path: path as string };
}

function requiredText(value: unknown, name: string): string {
  const text = optionalText(value, name);
  if (!text) {
    throw new Error(`${name} is required.`);
  }
  return text;
}

function optionalText(value: unknown, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function requiredPositiveInteger(value: unknown, name: string): number {
  const result = optionalPositiveInteger(value, name);
  if (result === undefined) {
    throw new Error(`${name} is required.`);
  }
  return result;
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean.`);
  }
  return value;
}

function optionalFields(value: unknown): Readonly<Record<string, string>> | undefined {
  if (value === undefined) {
    return undefined;
  }
  return fields(value);
}

function requiredFields(value: unknown): Readonly<Record<string, string>> {
  const result = fields(value);
  if (Object.keys(result).length === 0) {
    throw new Error("fields must contain at least one field value.");
  }
  return result;
}

function fields(value: unknown): Readonly<Record<string, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("fields must be an object containing string values.");
  }
  const result: Record<string, string> = {};
  for (const [name, fieldValue] of Object.entries(value)) {
    if (!name.trim() || typeof fieldValue !== "string") {
      throw new Error("fields must contain non-empty names and string values.");
    }
    result[name] = fieldValue;
  }
  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sendToChild(child: ChildProcess, message: Serializable): void {
  if (child.connected) {
    child.send(message, () => undefined);
  }
}
