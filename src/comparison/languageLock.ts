export interface ComparisonLanguage {
  readonly name: string;
}

export interface LockedLanguagePair {
  readonly leftLanguage: string;
  readonly rightLanguage: string;
}

export interface LanguageLockCandidate extends LockedLanguagePair {
  readonly language: string;
  readonly source: "left" | "right";
}

export function availableLanguage(
  languages: readonly ComparisonLanguage[],
  requestedLanguage: string,
): string | undefined {
  const normalized = requestedLanguage.trim().toLowerCase();
  return languages.find((language) => language.name.trim().toLowerCase() === normalized)?.name;
}

export function lockedLanguagePair(
  requestedLanguage: string,
  leftLanguages: readonly ComparisonLanguage[],
  rightLanguages: readonly ComparisonLanguage[],
): LockedLanguagePair | undefined {
  const leftLanguage = availableLanguage(leftLanguages, requestedLanguage);
  const rightLanguage = availableLanguage(rightLanguages, requestedLanguage);
  return leftLanguage && rightLanguage ? { leftLanguage, rightLanguage } : undefined;
}

export function languageLockCandidates(
  leftLanguage: string,
  rightLanguage: string,
  leftLanguages: readonly ComparisonLanguage[],
  rightLanguages: readonly ComparisonLanguage[],
): readonly LanguageLockCandidate[] {
  const candidates: LanguageLockCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of [
    { language: leftLanguage, source: "left" as const },
    { language: rightLanguage, source: "right" as const },
  ]) {
    const normalized = candidate.language.trim().toLowerCase();
    const pair = lockedLanguagePair(candidate.language, leftLanguages, rightLanguages);
    if (!normalized || !pair || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    candidates.push({ ...candidate, ...pair });
  }
  return candidates;
}

export function preferredLanguage(
  languages: readonly ComparisonLanguage[],
): string | undefined {
  return availableLanguage(languages, "en") ?? languages[0]?.name;
}

export function sameLanguage(leftLanguage: string, rightLanguage: string): boolean {
  return leftLanguage.trim().toLowerCase() === rightLanguage.trim().toLowerCase();
}
