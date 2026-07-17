const maximumRetryCount = 3;
const initialRetryDelayMilliseconds = 500;
const retryableStatusCodes = new Set([408, 429, 500, 502, 503, 504]);

export interface SitecoreHttpLogger {
  trace(message: string): void;
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
}

export interface SitecoreRequestOptions {
  readonly name: string;
  readonly signal: AbortSignal;
  readonly retryable: boolean;
}

export class SitecoreHttpClient {
  private readonly blockedUntilByOrigin = new Map<string, number>();

  constructor(private readonly log: SitecoreHttpLogger) {}

  async request(
    input: string | URL,
    init: RequestInit,
    options: SitecoreRequestOptions,
  ): Promise<Response> {
    const url = new URL(input);
    const retryable = options.retryable;

    for (let attempt = 0; attempt <= maximumRetryCount; attempt += 1) {
      await this.waitForOrigin(url.origin, options.name, options.signal);
      throwIfAborted(options.signal);

      try {
        this.log.trace(
          `${options.name}: HTTP attempt ${attempt + 1}/${maximumRetryCount + 1}.`,
        );
        const response = await fetch(url, { ...init, signal: options.signal });
        const retryAfter = retryAfterMilliseconds(response);
        if (
          !retryable ||
          !retryableStatusCodes.has(response.status) ||
          attempt === maximumRetryCount
        ) {
          if (retryAfter !== undefined && retryableStatusCodes.has(response.status)) {
            this.blockOrigin(url.origin, retryAfter);
          }
          if (retryableStatusCodes.has(response.status) && attempt === maximumRetryCount) {
            this.log.warn(
              `${options.name}: stopped retrying after ${maximumRetryCount + 1} attempts (HTTP ${response.status}).`,
            );
          }
          return response;
        }

        const delay = retryDelayMilliseconds(response, attempt);
        void response.body?.cancel().catch(() => undefined);
        this.blockOrigin(url.origin, delay);
        this.log.warn(
          `${options.name}: HTTP ${response.status}; retrying attempt ${attempt + 2}/${maximumRetryCount + 1} in ${formatDelay(delay)}.`,
        );
        await wait(delay, options.signal);
      } catch (error: unknown) {
        if (options.signal.aborted) {
          throw abortReason(options.signal);
        }
        if (!retryable || attempt === maximumRetryCount) {
          if (retryable && attempt === maximumRetryCount) {
            this.log.warn(
              `${options.name}: stopped retrying after ${maximumRetryCount + 1} attempts because of a network failure.`,
            );
          }
          throw error;
        }

        const delay = exponentialDelayMilliseconds(attempt);
        this.blockOrigin(url.origin, delay);
        this.log.warn(
          `${options.name}: network failure; retrying attempt ${attempt + 2}/${maximumRetryCount + 1} in ${formatDelay(delay)}.`,
        );
        await wait(delay, options.signal);
      }
    }

    throw new Error(`${options.name}: request retry loop ended unexpectedly.`);
  }

  clear(): void {
    this.blockedUntilByOrigin.clear();
  }

  private blockOrigin(origin: string, delayMilliseconds: number): void {
    const blockedUntil = Date.now() + delayMilliseconds;
    const current = this.blockedUntilByOrigin.get(origin) ?? 0;
    if (blockedUntil > current) {
      this.blockedUntilByOrigin.set(origin, blockedUntil);
    }
  }

  private async waitForOrigin(
    origin: string,
    requestName: string,
    signal: AbortSignal,
  ): Promise<void> {
    const blockedUntil = this.blockedUntilByOrigin.get(origin);
    if (!blockedUntil) {
      return;
    }

    const delay = blockedUntil - Date.now();
    if (delay <= 0) {
      this.blockedUntilByOrigin.delete(origin);
      return;
    }

    this.log.debug(`${requestName}: waiting ${formatDelay(delay)} for the Sitecore endpoint cooldown.`);
    await wait(delay, signal);
  }
}

function retryDelayMilliseconds(response: Response, retryIndex: number): number {
  const retryAfter = retryAfterMilliseconds(response);
  return retryAfter ?? exponentialDelayMilliseconds(retryIndex);
}

function retryAfterMilliseconds(response: Response): number | undefined {
  return parseRetryAfterMilliseconds(response.headers.get("retry-after"));
}

function parseRetryAfterMilliseconds(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1_000);
  }

  const date = Date.parse(value);
  if (Number.isNaN(date)) {
    return undefined;
  }
  return Math.max(0, date - Date.now());
}

function exponentialDelayMilliseconds(retryIndex: number): number {
  const baseDelay = initialRetryDelayMilliseconds * 2 ** retryIndex;
  const jitter = Math.floor(Math.random() * Math.max(1, baseDelay * 0.25));
  return baseDelay + jitter;
}

function wait(delayMilliseconds: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", handleAbort);
      resolve();
    }, delayMilliseconds);
    const handleAbort = (): void => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", handleAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", handleAbort, { once: true });
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw abortReason(signal);
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function formatDelay(delayMilliseconds: number): string {
  return `${(delayMilliseconds / 1_000).toFixed(delayMilliseconds < 10_000 ? 1 : 0)} s`;
}
