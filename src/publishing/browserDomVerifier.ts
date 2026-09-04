import { chromium, type Browser } from "playwright-core";
import {
  classifyBrowserDomSelectorFailure,
  evaluateBrowserDomObservation,
  normalizeBrowserDomText,
} from "./browserDomObservation";

const browserChannels = ["chrome", "msedge"] as const;
const navigationTimeoutMilliseconds = 30_000;
const selectorTimeoutMilliseconds = 15_000;

export interface BrowserDomRuntime {
  launch(channel: typeof browserChannels[number]): Promise<Browser>;
}

const defaultBrowserDomRuntime: BrowserDomRuntime = {
  launch: (channel) => chromium.launch({ channel, headless: true }),
};

export interface BrowserDomAssertion {
  readonly itemPath: string;
  readonly fieldName: string;
  readonly selector: string;
  readonly expected: string;
}

export interface BrowserDomAssertionResult extends BrowserDomAssertion {
  readonly status: "matched" | "different" | "missing" | "invalid";
  readonly matchCount: number;
  readonly observedTexts: readonly string[];
  readonly detail?: string;
}

export interface BrowserDomVerificationResult {
  readonly browserChannel: string;
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly assertions: readonly BrowserDomAssertionResult[];
}

export async function verifyBrowserDom(
  url: string,
  assertions: readonly BrowserDomAssertion[],
  signal: AbortSignal,
  runtime: BrowserDomRuntime = defaultBrowserDomRuntime,
): Promise<BrowserDomVerificationResult> {
  if (signal.aborted) {
    throw signal.reason;
  }
  const { browser, channel } = await launchInstalledBrowser(runtime);
  let closePromise: Promise<void> | undefined;
  const closeBrowser = (): Promise<void> => {
    closePromise ??= browser.close().catch(() => undefined);
    return closePromise;
  };
  const abort = (): void => {
    void closeBrowser();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(selectorTimeoutMilliseconds);
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: navigationTimeoutMilliseconds,
    });
    const results: BrowserDomAssertionResult[] = [];
    for (const assertion of assertions) {
      if (signal.aborted) {
        throw signal.reason;
      }
      const selector = `css=${assertion.selector}`;
      let locator;
      try {
        locator = page.locator(selector);
        await locator.first().waitFor({
          state: "attached",
          timeout: selectorTimeoutMilliseconds,
        });
      } catch (error: unknown) {
        const failure = classifyBrowserDomSelectorFailure(error);
        results.push({
          ...assertion,
          status: failure.status,
          matchCount: 0,
          observedTexts: [],
          detail: failure.detail,
        });
        continue;
      }
      try {
        const expected = normalizeBrowserDomText(assertion.expected);
        if (expected) {
          await locator.filter({ hasText: expected }).first().waitFor({
            state: "attached",
            timeout: selectorTimeoutMilliseconds,
          });
        }
      } catch {
        // Capture the final rendered text below even when the expected value did not appear.
      }
      const matchCount = await locator.count();
      const observedTexts = await Promise.all(
        Array.from({ length: Math.min(matchCount, 5) }, async (_value, index) =>
          normalizeBrowserDomText(await locator.nth(index).textContent() ?? "")
        ),
      );
      results.push({
        ...assertion,
        status: evaluateBrowserDomObservation(assertion.expected, observedTexts),
        matchCount,
        observedTexts,
      });
    }
    return {
      browserChannel: channel,
      requestedUrl: url,
      finalUrl: page.url(),
      assertions: results,
    };
  } catch (error: unknown) {
    if (signal.aborted) {
      throw signal.reason;
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    await closeBrowser();
  }
}

async function launchInstalledBrowser(runtime: BrowserDomRuntime): Promise<{
  readonly browser: Browser;
  readonly channel: string;
}> {
  const failures: string[] = [];
  for (const channel of browserChannels) {
    try {
      return {
        browser: await runtime.launch(channel),
        channel,
      };
    } catch (error: unknown) {
      failures.push(`${channel}: ${errorMessage(error)}`);
    }
  }
  throw new Error(
    `Browser DOM verification requires Google Chrome or Microsoft Edge. ${failures.join(" | ")}`,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown browser error";
}
