import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import {
  classifyBrowserDomSelectorFailure,
  evaluateBrowserDomObservation,
  normalizeBrowserDomText,
} from "../../src/publishing/browserDomObservation";

test("Browser DOM text normalization collapses and trims Unicode whitespace", () => {
  strictEqual(
    normalizeBrowserDomText(" \n Welcome\tto\u00a0XM   Cloud \r\n"),
    "Welcome to XM Cloud",
  );
  strictEqual(normalizeBrowserDomText("\t\n"), "");
});

test("Browser DOM observation uses normalized case-insensitive containment", () => {
  strictEqual(
    evaluateBrowserDomObservation(
      "  Welcome\nto XM Cloud ",
      ["Prefix WELCOME   TO xm cloud suffix"],
    ),
    "matched",
  );
  strictEqual(
    evaluateBrowserDomObservation("Welcome!", ["Welcome"]),
    "different",
  );
});

test("Browser DOM observation matches when any selected element contains the value", () => {
  strictEqual(
    evaluateBrowserDomObservation(
      "Expected value",
      ["First element", "contains expected VALUE here", "Third element"],
    ),
    "matched",
  );
  strictEqual(
    evaluateBrowserDomObservation("Expected value", ["First", "Second"]),
    "different",
  );
  strictEqual(evaluateBrowserDomObservation("Expected value", []), "different");
});

test("empty Browser DOM expectations match only an empty normalized element", () => {
  strictEqual(
    evaluateBrowserDomObservation(" \n", ["Visible", " \t "]),
    "matched",
  );
  strictEqual(
    evaluateBrowserDomObservation("", ["Visible", "Also visible"]),
    "different",
  );
});

test("selector failures recognize every invalid-selector error form", () => {
  for (const message of [
    "Invalid selector supplied",
    "Unexpected token ]",
    "This is not a valid selector",
    "Failed to parse selector",
  ]) {
    deepStrictEqual(
      classifyBrowserDomSelectorFailure(new Error(message)),
      { status: "invalid", detail: message },
    );
  }
});

test("selector failures distinguish missing elements and unknown errors", () => {
  deepStrictEqual(
    classifyBrowserDomSelectorFailure(new Error("Timeout waiting for locator")),
    { status: "missing", detail: "Timeout waiting for locator" },
  );
  deepStrictEqual(
    classifyBrowserDomSelectorFailure("browser closed"),
    { status: "missing", detail: "Unknown browser error" },
  );
});
