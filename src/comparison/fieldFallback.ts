import type { AuthoringItemDetails } from "../sitecore/authoringClient";

export type FieldFallbackMode = "exact" | "fallback";
export interface ComparisonItemDetails extends AuthoringItemDetails {
  readonly comparisonEvidence?: {
    readonly exact: AuthoringItemDetails;
    readonly exactObservedAt: string;
    readonly effectiveObservedAt: string;
    readonly sourceLanguage: "unknown";
  };
}

export function comparisonFieldEvidence(
  exact: AuthoringItemDetails, effective: AuthoringItemDetails,
  exactObservedAt: string, effectiveObservedAt: string,
): ComparisonItemDetails {
  const id = (value: string) => value.replace(/[{}-]/gu, "").toLowerCase();
  if (id(exact.itemId) !== id(effective.itemId) || exact.language.toLowerCase() !== effective.language.toLowerCase()
    || exact.version !== effective.version) {
    throw new Error("Item identity, locale or version changed between exact and fallback reads. Refresh and retry.");
  }
  return { ...effective, comparisonEvidence: { exact, exactObservedAt, effectiveObservedAt, sourceLanguage: "unknown" } };
}
