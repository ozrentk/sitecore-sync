import type { BrowserDomVerificationResult } from "./browserDomVerifier";
import type { TraceStageStatus } from "./publishingTypes";
import { formatFieldValue } from "./publishingVerification";

export interface BrowserDomVerificationOutcome {
  readonly status: Extract<TraceStageStatus, "matched" | "inconclusive" | "diverged">;
  readonly summary: string;
  readonly evidence: readonly string[];
}

export function evaluateBrowserDomResult(
  result: BrowserDomVerificationResult,
): BrowserDomVerificationOutcome {
  const differentCount = result.assertions.filter((assertion) =>
    assertion.status === "different"
  ).length;
  const uncertainCount = result.assertions.filter((assertion) =>
    assertion.status === "missing" || assertion.status === "invalid"
  ).length;
  const status: BrowserDomVerificationOutcome["status"] = differentCount
    ? "diverged"
    : uncertainCount
      ? "inconclusive"
      : "matched";
  return {
    status,
    summary: status === "matched"
      ? `${result.assertions.length} selected field value(s) matched in the browser-rendered DOM.`
      : status === "diverged"
        ? `${differentCount} selector assertion(s) found elements with different rendered text.`
        : `${uncertainCount} selector assertion(s) could not identify a browser-rendered value conclusively.`,
    evidence: [
      `Browser: ${result.browserChannel}`,
      `Requested URL: ${result.requestedUrl}`,
      `Final URL: ${result.finalUrl}`,
      ...result.assertions.map((assertion) => {
        const observed = assertion.observedTexts.length
          ? assertion.observedTexts.map(formatFieldValue).join(", ")
          : "none";
        return `${assertion.itemPath} › ${assertion.fieldName}: ${assertion.status}; selector ${JSON.stringify(assertion.selector)}; matches=${assertion.matchCount}; expected=${formatFieldValue(assertion.expected)}; observed=${observed}`;
      }),
    ],
  };
}
