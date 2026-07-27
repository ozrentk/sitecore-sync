import { chromium, type Browser } from "playwright-core";

const browserChannels = ["chrome", "msedge"] as const;
const navigationTimeoutMilliseconds = 30_000;
const selectorTimeoutMilliseconds = 15_000;

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
): Promise<BrowserDomVerificationResult> {
  const { browser, channel } = await launchInstalledBrowser();
  const abort = (): void => {
    void browser.close();
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
        const message = errorMessage(error);
        results.push({
          ...assertion,
          status: isInvalidSelectorError(message) ? "invalid" : "missing",
          matchCount: 0,
          observedTexts: [],
          detail: message,
        });
        continue;
      }
      try {
        const expected = normalizeDomText(assertion.expected);
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
          normalizeDomText(await locator.nth(index).textContent() ?? "")
        ),
      );
      const expected = normalizeDomText(assertion.expected);
      results.push({
        ...assertion,
        status: observedTexts.some((text) => expected ? text.includes(expected) : text === "")
          ? "matched"
          : "different",
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
    await browser.close().catch(() => undefined);
  }
}

async function launchInstalledBrowser(): Promise<{
  readonly browser: Browser;
  readonly channel: string;
}> {
  const failures: string[] = [];
  for (const channel of browserChannels) {
    try {
      return {
        browser: await chromium.launch({ channel, headless: true }),
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

function normalizeDomText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function isInvalidSelectorError(message: string): boolean {
  return /invalid|unexpected token|not a valid selector|failed to parse/iu.test(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown browser error";
}
