export interface SearchInput { query: string; matchCase: boolean; direction: "next" | "previous" }
export interface ReplaceInput extends SearchInput { replacement: string; all: boolean; preserveCase?: boolean }
export interface SearchResult { count: number; index: number; replaced: number }
export interface Part { from: number; to: number }
export function validSearchInput(value: unknown): value is SearchInput {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  return typeof input.query === "string" && input.query.length > 0 && input.query.length <= 1024 && typeof input.matchCase === "boolean" && (input.direction === "next" || input.direction === "previous");
}
export function validReplaceInput(value: unknown): value is ReplaceInput {
  return validSearchInput(value) && typeof (value as ReplaceInput).replacement === "string" && (value as ReplaceInput).replacement.length <= 8192 && typeof (value as ReplaceInput).all === "boolean" && ((value as ReplaceInput).preserveCase === undefined || typeof (value as ReplaceInput).preserveCase === "boolean");
}
export function validSearchResult(value: unknown): value is SearchResult {
  if (!value || typeof value !== "object") return false;
  const item = value as SearchResult;
  return [item.count, item.index, item.replaced].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 1000) && item.index <= item.count;
}
/** Literal matching with original UTF-16 offsets, including case-insensitive Unicode. */
export function literalMatches(text: string, input: SearchInput): Part[] {
  if (!validSearchInput(input)) throw new Error("Enter 1–1,024 characters to find.");
  const expression = new RegExp(input.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), input.matchCase ? "gu" : "giu");
  const matches: Part[] = [];
  for (const match of text.matchAll(expression)) {
    if (matches.length >= 1000) throw new Error("More than 1,000 matches. Narrow the search before continuing.");
    matches.push({ from: match.index, to: match.index + match[0].length });
  }
  return matches;
}

/** Match clear Unicode lower/upper/initial-capital patterns; mixed casing stays as entered. */
export function replacementText(matched: string, replacement: string, preserveCase = false): string {
  if (!preserveCase) return replacement;
  const letters = Array.from(matched).filter(char => char.toLowerCase() !== char.toUpperCase());
  if (!letters.length) return replacement;
  if (letters.every(char => char === char.toUpperCase())) return replacement.toUpperCase();
  if (letters.every(char => char === char.toLowerCase())) return replacement.toLowerCase();
  if (letters[0] === letters[0].toUpperCase() && letters.slice(1).every(char => char === char.toLowerCase())) {
    let capitalized = false;
    return Array.from(replacement.toLowerCase()).map(char => {
      if (capitalized || char.toLowerCase() === char.toUpperCase()) return char;
      capitalized = true; return char.toUpperCase();
    }).join("");
  }
  return replacement;
}
