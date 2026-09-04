export type BrowserDomObservationStatus = "matched" | "different";
export type BrowserDomSelectorFailureStatus = "missing" | "invalid";

export interface BrowserDomSelectorFailure {
  readonly status: BrowserDomSelectorFailureStatus;
  readonly detail: string;
}

export function normalizeBrowserDomText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

export function evaluateBrowserDomObservation(
  expected: string,
  observedTexts: readonly string[],
): BrowserDomObservationStatus {
  const comparableExpected = comparableBrowserDomText(expected);
  return observedTexts.some((text) =>
    comparableExpected
      ? comparableBrowserDomText(text).includes(comparableExpected)
      : normalizeBrowserDomText(text) === ""
  )
    ? "matched"
    : "different";
}

export function classifyBrowserDomSelectorFailure(
  error: unknown,
): BrowserDomSelectorFailure {
  const detail = error instanceof Error ? error.message : "Unknown browser error";
  return {
    status: /invalid|unexpected token|not a valid selector|failed to parse/iu.test(detail)
      ? "invalid"
      : "missing",
    detail,
  };
}

function comparableBrowserDomText(value: string): string {
  return normalizeBrowserDomText(value).toLowerCase();
}
