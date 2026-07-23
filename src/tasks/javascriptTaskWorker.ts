import { pathToFileURL } from "node:url";

interface StartMessage {
  readonly type: "start";
  readonly scriptPath: string;
  readonly context: unknown;
}

interface AuthoringResponseMessage {
  readonly type: "authoringResponse";
  readonly requestId: number;
  readonly result?: unknown;
  readonly error?: string;
}

interface TaskResult {
  readonly status?: string;
  readonly message?: string;
}

let nextRequestId = 1;
const pendingRequests = new Map<
  number,
  { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }
>();

process.on("message", (message: unknown) => {
  if (isStartMessage(message)) {
    void run(message);
    return;
  }
  if (isAuthoringResponse(message)) {
    const pending = pendingRequests.get(message.requestId);
    if (!pending) {
      return;
    }
    pendingRequests.delete(message.requestId);
    if (message.error) {
      pending.reject(new Error(message.error));
    } else {
      pending.resolve(message.result);
    }
  }
});

async function run(message: StartMessage): Promise<void> {
  try {
    const moduleUrl = `${pathToFileURL(message.scriptPath).href}?run=${Date.now()}`;
    const loaded = await import(moduleUrl) as {
      readonly default?: unknown;
      readonly run?: unknown;
    };
    const defaultExport = loaded.default as { readonly run?: unknown } | undefined;
    const runTask = typeof loaded.run === "function"
      ? loaded.run
      : typeof defaultExport?.run === "function"
        ? defaultExport.run
        : typeof loaded.default === "function"
          ? loaded.default
          : undefined;
    if (!runTask) {
      throw new Error(
        "JavaScript task must export an async run(context, sitecore, log) function.",
      );
    }

    const sitecore = {
      items: {
        get: async (input: unknown): Promise<unknown> =>
          await authoringRequest("items.get", input),
        getChildren: async (input: unknown): Promise<unknown> =>
          await authoringRequest("items.getChildren", input),
        create: async (input: unknown): Promise<unknown> =>
          await authoringRequest("items.create", input),
        update: async (input: unknown): Promise<unknown> =>
          await authoringRequest("items.update", input),
        delete: async (input: unknown): Promise<unknown> =>
          await authoringRequest("items.delete", input),
      },
    };
    const log = {
      info: (...values: readonly unknown[]): void => console.log(...values),
      warn: (...values: readonly unknown[]): void => console.warn(...values),
      error: (...values: readonly unknown[]): void => console.error(...values),
    };
    const rawResult = await runTask(message.context, sitecore, log) as unknown;
    await finish({ type: "complete", result: normalizeTaskResult(rawResult) }, 0);
  } catch (error: unknown) {
    const messageText = errorMessage(error);
    console.error(error instanceof Error && error.stack ? error.stack : messageText);
    await finish({ type: "failed", error: messageText }, 1);
  }
}

async function authoringRequest(operation: string, input: unknown): Promise<unknown> {
  const requestId = nextRequestId;
  nextRequestId += 1;
  return await new Promise((resolve, reject) => {
    pendingRequests.set(requestId, { resolve, reject });
    send({ type: "authoringRequest", requestId, operation, input });
  });
}

function normalizeTaskResult(value: unknown): TaskResult | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    return { status: "ok", message: value };
  }
  if (!value || typeof value !== "object") {
    throw new Error("JavaScript task result must be an object, string, or undefined.");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.status !== undefined && typeof candidate.status !== "string") {
    throw new Error("JavaScript task result status must be a string.");
  }
  if (candidate.message !== undefined && typeof candidate.message !== "string") {
    throw new Error("JavaScript task result message must be a string.");
  }
  return {
    ...(typeof candidate.status === "string" ? { status: candidate.status } : {}),
    ...(typeof candidate.message === "string" ? { message: candidate.message } : {}),
  };
}

function isStartMessage(value: unknown): value is StartMessage {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<StartMessage>;
  return candidate.type === "start" && typeof candidate.scriptPath === "string";
}

function isAuthoringResponse(value: unknown): value is AuthoringResponseMessage {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<AuthoringResponseMessage>;
  return candidate.type === "authoringResponse" && typeof candidate.requestId === "number";
}

function send(message: unknown): void {
  if (!process.send) {
    throw new Error("JavaScript task IPC channel is unavailable.");
  }
  process.send(message);
}

async function finish(message: unknown, exitCode: number): Promise<void> {
  await Promise.all([
    new Promise<void>((resolve) => {
      if (!process.send) {
        resolve();
        return;
      }
      process.send(message, () => resolve());
    }),
    flush(process.stdout),
    flush(process.stderr),
  ]);
  process.exit(exitCode);
}

async function flush(stream: NodeJS.WriteStream): Promise<void> {
  await new Promise<void>((resolve) => stream.write("", () => resolve()));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
