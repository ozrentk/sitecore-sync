import { AssertionError } from "node:assert";

export const b31TestName = "structured field webview supports name/value rows and safe General Link forms with pinned item picker";

// Remove with B31. Opt-in never applies to another release, test, or assertion.
export function isAcceptedB31(version: string, optIn: string | undefined, testName: string, error: unknown): boolean {
  const expected = new AssertionError({ actual: undefined, expected: true, operator: "strictEqual",
    message: "Error: Destination focus must expand inline" });
  return version === "0.45.0" && optIn === "0.45.0" && testName === b31TestName
    && error instanceof AssertionError && error.code === "ERR_ASSERTION"
    && error.actual === undefined && error.expected === true && error.operator === "strictEqual"
    && error.message === expected.message;
}
