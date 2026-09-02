import { strictEqual, throws } from "node:assert/strict";
import { test } from "node:test";
import { normalizeServerUrl } from "../../src/connections/connection";

test("normalizeServerUrl trims and canonicalizes an HTTPS origin", () => {
  strictEqual(
    normalizeServerUrl("  https://CM.Example.COM/  "),
    "https://cm.example.com",
  );
});

test("normalizeServerUrl preserves a non-default port", () => {
  strictEqual(
    normalizeServerUrl("https://cm.example.com:8443"),
    "https://cm.example.com:8443",
  );
});

test("normalizeServerUrl rejects malformed URLs", () => {
  throws(() => normalizeServerUrl("not a URL"), TypeError);
});

const rejectedServerUrls: readonly {
  readonly name: string;
  readonly value: string;
  readonly message: RegExp;
}[] = [
  {
    name: "non-HTTPS URLs",
    value: "http://cm.example.com",
    message: /must use HTTPS/u,
  },
  {
    name: "embedded usernames",
    value: "https://user@cm.example.com",
    message: /Do not include credentials/u,
  },
  {
    name: "embedded passwords",
    value: "https://user:secret@cm.example.com",
    message: /Do not include credentials/u,
  },
  {
    name: "API paths",
    value: "https://cm.example.com/sitecore/api",
    message: /without an API path/u,
  },
  {
    name: "query strings",
    value: "https://cm.example.com?tenant=example",
    message: /query string or fragment/u,
  },
  {
    name: "fragments",
    value: "https://cm.example.com#authoring",
    message: /query string or fragment/u,
  },
];

for (const rejected of rejectedServerUrls) {
  test(`normalizeServerUrl rejects ${rejected.name}`, () => {
    throws(() => normalizeServerUrl(rejected.value), rejected.message);
  });
}
