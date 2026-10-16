import { AssertionError, strictEqual } from "node:assert";
import { test } from "node:test";
import { b31TestName, isAcceptedB31 } from "../releaseExceptions";

const known = () => new AssertionError({ actual: undefined, expected: true, operator: "strictEqual",
  message: "Error: Destination focus must expand inline" });

test("B31 exception requires explicit opt-in, exact version, test and assertion", () => {
  strictEqual(isAcceptedB31("0.45.0", "0.45.0", b31TestName, known()), true);
  for (const version of ["0.45.1", "0.46.0", ""]) strictEqual(isAcceptedB31(version, "0.45.0", b31TestName, known()), false);
  for (const optIn of [undefined, "true", "0.45.1"]) strictEqual(isAcceptedB31("0.45.0", optIn, b31TestName, known()), false);
  strictEqual(isAcceptedB31("0.45.0", "0.45.0", "other test", known()), false);
});

test("B31 exception rejects unrelated, extended and lookalike failures", () => {
  for (const error of [new Error("Error: Destination focus must expand inline"), {}, null,
    new AssertionError({ actual: false, expected: true, operator: "strictEqual", message: "Error: Destination focus must expand inline" }),
    new AssertionError({ actual: undefined, expected: true, operator: "strictEqual", message: "Error: Destination focus must expand inline; another failure" }),
    new AssertionError({ actual: undefined, expected: true, operator: "strictEqual", message: "Error: Property focus must not collapse" })]) {
    strictEqual(isAcceptedB31("0.45.0", "0.45.0", b31TestName, error), false);
  }
});
