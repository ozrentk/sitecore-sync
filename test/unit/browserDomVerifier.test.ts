import {
  deepStrictEqual,
  rejects,
  strictEqual,
} from "node:assert/strict";
import { test } from "node:test";
import type { Browser } from "playwright-core";
import {
  verifyBrowserDom,
  type BrowserDomAssertion,
  type BrowserDomRuntime,
} from "../../src/publishing/browserDomVerifier";

interface LocatorPlan {
  readonly texts?: readonly string[];
  readonly attachError?: Error;
  readonly expectedWaitError?: Error;
}

test("Browser DOM verification falls back browsers and records bounded observations", async () => {
  const assertions: readonly BrowserDomAssertion[] = [
    assertion("Matched", ".matched", "Expected value"),
    assertion("Different", ".different", "Expected value"),
    assertion("Missing", ".missing", "Expected value"),
    assertion("Invalid", "[", "Expected value"),
  ];
  const harness = browserHarness(new Map([
    ["css=.matched", {
      texts: ["First", "Second", "contains EXPECTED value", "Fourth", "Fifth", "Sixth"],
      expectedWaitError: new Error("Expected text was initially unavailable"),
    }],
    ["css=.different", { texts: ["Other value"] }],
    ["css=.missing", { attachError: new Error("Timeout waiting for locator") }],
    ["css=[", { attachError: new Error("Unexpected token ]") }],
  ]));
  const launchedChannels: string[] = [];
  const runtime: BrowserDomRuntime = {
    launch: async (channel) => {
      launchedChannels.push(channel);
      if (channel === "chrome") {
        throw new Error("Chrome unavailable");
      }
      return harness.browser;
    },
  };

  const result = await verifyBrowserDom(
    "https://www.example.com/requested",
    assertions,
    new AbortController().signal,
    runtime,
  );

  deepStrictEqual(launchedChannels, ["chrome", "msedge"]);
  strictEqual(harness.defaultTimeout, 15_000);
  deepStrictEqual(harness.navigation, {
    url: "https://www.example.com/requested",
    options: { waitUntil: "domcontentloaded", timeout: 30_000 },
  });
  strictEqual(harness.closeCalls, 1);
  deepStrictEqual(result, {
    browserChannel: "msedge",
    requestedUrl: "https://www.example.com/requested",
    finalUrl: "https://www.example.com/final",
    assertions: [
      {
        ...assertions[0],
        status: "matched",
        matchCount: 6,
        observedTexts: [
          "First",
          "Second",
          "contains EXPECTED value",
          "Fourth",
          "Fifth",
        ],
      },
      {
        ...assertions[1],
        status: "different",
        matchCount: 1,
        observedTexts: ["Other value"],
      },
      {
        ...assertions[2],
        status: "missing",
        matchCount: 0,
        observedTexts: [],
        detail: "Timeout waiting for locator",
      },
      {
        ...assertions[3],
        status: "invalid",
        matchCount: 0,
        observedTexts: [],
        detail: "Unexpected token ]",
      },
    ],
  });
});

test("Browser DOM verification rejects pre-cancellation without launching a browser", async () => {
  const controller = new AbortController();
  const reason = new DOMException("Cancelled before launch", "AbortError");
  controller.abort(reason);
  let launchCalls = 0;
  const runtime: BrowserDomRuntime = {
    launch: async () => {
      launchCalls += 1;
      throw new Error("Browser should not launch");
    },
  };

  await rejects(
    verifyBrowserDom(
      "https://www.example.com/",
      [assertion("Title", "h1", "Welcome")],
      controller.signal,
      runtime,
    ),
    (error: unknown) => error === reason,
  );
  strictEqual(launchCalls, 0);
});

test("Browser DOM verification propagates active cancellation and closes once", async () => {
  const controller = new AbortController();
  const reason = new DOMException("Cancelled during navigation", "AbortError");
  const harness = browserHarness(new Map([
    ["css=h1", { texts: ["Welcome"] }],
  ]), undefined, () => controller.abort(reason));
  const runtime: BrowserDomRuntime = {
    launch: async () => harness.browser,
  };

  await rejects(
    verifyBrowserDom(
      "https://www.example.com/",
      [assertion("Title", "h1", "Welcome")],
      controller.signal,
      runtime,
    ),
    (error: unknown) => error === reason,
  );
  strictEqual(harness.closeCalls, 1);
});

test("Browser DOM verification closes the browser after navigation failure", async () => {
  const harness = browserHarness(new Map(), new Error("Navigation failed"));
  const runtime: BrowserDomRuntime = {
    launch: async () => harness.browser,
  };

  await rejects(
    verifyBrowserDom(
      "https://www.example.com/",
      [assertion("Title", "h1", "Welcome")],
      new AbortController().signal,
      runtime,
    ),
    /Navigation failed/u,
  );
  strictEqual(harness.closeCalls, 1);
});

function assertion(
  fieldName: string,
  selector: string,
  expected: string,
): BrowserDomAssertion {
  return {
    itemPath: "/sitecore/content/Home",
    fieldName,
    selector,
    expected,
  };
}

function browserHarness(
  plans: ReadonlyMap<string, LocatorPlan>,
  navigationError?: Error,
  onNavigate?: () => void,
): {
  readonly browser: Browser;
  defaultTimeout: number | undefined;
  navigation: { readonly url: string; readonly options: unknown } | undefined;
  closeCalls: number;
} {
  const harness = {
    browser: undefined as unknown as Browser,
    defaultTimeout: undefined as number | undefined,
    navigation: undefined as { readonly url: string; readonly options: unknown } | undefined,
    closeCalls: 0,
  };
  const page = {
    setDefaultTimeout: (timeout: number): void => {
      harness.defaultTimeout = timeout;
    },
    goto: async (url: string, options: unknown): Promise<void> => {
      harness.navigation = { url, options };
      onNavigate?.();
      if (navigationError) {
        throw navigationError;
      }
    },
    locator: (selector: string): unknown => fakeLocator(plans.get(selector) ?? { texts: [] }),
    url: (): string => "https://www.example.com/final",
  };
  harness.browser = {
    newPage: async () => page,
    close: async () => {
      harness.closeCalls += 1;
    },
  } as unknown as Browser;
  return harness;
}

function fakeLocator(plan: LocatorPlan): unknown {
  const texts = plan.texts ?? [];
  const locator = {
    first: (): unknown => locator,
    waitFor: async (): Promise<void> => {
      if (plan.attachError) {
        throw plan.attachError;
      }
    },
    filter: (): unknown => {
      const filtered = {
        first: (): unknown => filtered,
        waitFor: async (): Promise<void> => {
          if (plan.expectedWaitError) {
            throw plan.expectedWaitError;
          }
        },
      };
      return filtered;
    },
    count: async (): Promise<number> => texts.length,
    nth: (index: number): unknown => ({
      textContent: async (): Promise<string | null> => texts[index] ?? null,
    }),
  };
  return locator;
}
