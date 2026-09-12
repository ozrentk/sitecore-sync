import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import {
  availableLanguage,
  languageLockCandidates,
  lockedLanguagePair,
  preferredLanguage,
  sameLanguage,
} from "../../src/comparison/languageLock";

const languages = (...names: readonly string[]): readonly { readonly name: string }[] =>
  names.map((name) => ({ name }));

test("comparison language matching is case-insensitive and returns canonical names", () => {
  strictEqual(availableLanguage(languages("EN", "fr-CA"), " en "), "EN");
  strictEqual(availableLanguage(languages("EN", "fr-CA"), "fr-ca"), "fr-CA");
  strictEqual(availableLanguage(languages("EN"), "da"), undefined);
  strictEqual(sameLanguage(" EN ", "en"), true);
  strictEqual(sameLanguage("en", "en-GB"), false);
});

test("locked language pairs preserve each connection's canonical casing", () => {
  deepStrictEqual(
    lockedLanguagePair("EN", languages("en", "da"), languages("EN", "fr")),
    { leftLanguage: "en", rightLanguage: "EN" },
  );
  strictEqual(
    lockedLanguagePair("da", languages("en", "da"), languages("en", "fr")),
    undefined,
  );
});

test("lock candidates contain only current languages shared by both connections", () => {
  deepStrictEqual(
    languageLockCandidates(
      "da",
      "fr",
      languages("en", "da", "fr"),
      languages("EN", "DA", "fr"),
    ),
    [
      { language: "da", source: "left", leftLanguage: "da", rightLanguage: "DA" },
      { language: "fr", source: "right", leftLanguage: "fr", rightLanguage: "fr" },
    ],
  );
  deepStrictEqual(
    languageLockCandidates("en", "EN", languages("en"), languages("EN")),
    [{ language: "en", source: "left", leftLanguage: "en", rightLanguage: "EN" }],
  );
  deepStrictEqual(
    languageLockCandidates("da", "nl", languages("da"), languages("en")),
    [],
  );
});

test("fallback selection prefers English and otherwise uses the first returned language", () => {
  strictEqual(preferredLanguage(languages("da", "en", "fr")), "en");
  strictEqual(preferredLanguage(languages("DA", "EN", "fr")), "EN");
  strictEqual(preferredLanguage(languages("da", "fr")), "da");
  strictEqual(preferredLanguage([]), undefined);
});
