import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import {
  readPowerScopeFormMessageType,
  readPowerScopeId,
  readPowerScopeSelection,
  readTracedPublishFormMessageType,
  validateTracedPublishSubmission,
  type TracedPublishFieldCandidate,
  type TracedPublishSiteCandidate,
} from "../../src/publishing/publishingFormValidation";

const fields: readonly TracedPublishFieldCandidate[] = [
  {
    key: "root:title",
    itemId: "root-item",
    itemName: "Home",
    itemPath: "/sitecore/content/Home",
    fieldName: "Title",
    value: "Welcome",
    descendant: false,
  },
  {
    key: "child:title",
    itemId: "child-item",
    itemName: "Child",
    itemPath: "/sitecore/content/Home/Child",
    fieldName: "Title",
    value: "Child title",
    descendant: true,
  },
];

const sites: readonly TracedPublishSiteCandidate[] = [{
  name: "website",
  rootPath: "/sitecore/content/Tenant/Site",
  suggestedRoute: "/",
}];

test("publishing form message readers accept only known object messages", () => {
  for (const type of ["ready", "cancel", "loadDescendants", "submit"] as const) {
    strictEqual(readTracedPublishFormMessageType({ type }), type);
  }
  for (const type of ["ready", "cancel", "scan", "submit"] as const) {
    strictEqual(readPowerScopeFormMessageType({ type }), type);
  }
  for (const value of [undefined, null, [], "ready", {}, { type: "unknown" }]) {
    strictEqual(readTracedPublishFormMessageType(value), undefined);
    strictEqual(readPowerScopeFormMessageType(value), undefined);
  }
});

test("Power Publish scope messages validate IDs before reaching the graph", () => {
  strictEqual(readPowerScopeId({ scopeId: "scope-a" }), "scope-a");
  strictEqual(readPowerScopeId({ scopeId: 42 }), undefined);
  strictEqual(readPowerScopeId(null), undefined);
  deepStrictEqual(
    readPowerScopeSelection({ selectedScopeIds: ["scope-a", "scope-b"] }),
    ["scope-a", "scope-b"],
  );
  match(String(readPowerScopeSelection({ selectedScopeIds: ["scope-a", 42] })), /invalid/u);
  match(String(readPowerScopeSelection({ selectedScopeIds: "scope-a" })), /invalid/u);
});

test("Traced Publish submission normalizes trusted selections", () => {
  deepStrictEqual(
    validateTracedPublishSubmission({
      type: "submit",
      mode: "FULL",
      publishSubItems: true,
      publishRelatedItems: true,
      siteName: " WEBSITE ",
      route: " /news ",
      applicationUrl: " https://www.example.com/news ",
      fields: [
        { key: "root:title", browserSelector: " h1 " },
        { key: "child:title", browserSelector: " " },
      ],
    }, fields, sites, "traced"),
    {
      mode: "FULL",
      publishSubItems: true,
      publishRelatedItems: true,
      siteName: "WEBSITE",
      route: "/news",
      applicationUrl: "https://www.example.com/news",
      fields: [
        { itemId: "root-item", fieldName: "Title", browserSelector: "h1" },
        { itemId: "child-item", fieldName: "Title", browserSelector: undefined },
      ],
    },
  );
});

test("Power Publish submission accepts descendant assertions but disables related items", () => {
  deepStrictEqual(
    validateTracedPublishSubmission({
      type: "submit",
      mode: "SMART",
      publishSubItems: false,
      publishRelatedItems: true,
      siteName: "website",
      route: "/",
      fields: [{ key: "child:title" }],
    }, fields, sites, "power"),
    {
      mode: "SMART",
      publishSubItems: false,
      publishRelatedItems: false,
      siteName: "website",
      route: "/",
      applicationUrl: undefined,
      fields: [{
        itemId: "child-item",
        fieldName: "Title",
        browserSelector: undefined,
      }],
    },
  );
});

test("publishing submission rejects malformed or stale external data", () => {
  const base = {
    type: "submit",
    mode: "SMART",
    publishSubItems: true,
    publishRelatedItems: false,
    siteName: "website",
    route: "/",
    fields: [] as unknown[],
  };
  const invalid: readonly [unknown, RegExp][] = [
    [null, /configuration is invalid/u],
    [{ ...base, mode: "FAST" }, /Smart publish or Full publish/u],
    [{ ...base, publishSubItems: "yes" }, /scope is invalid/u],
    [{ ...base, siteName: "" }, /Select the Sitecore site/u],
    [{ ...base, siteName: "unverified" }, /verified connection catalog/u],
    [{ ...base, applicationUrl: "http://www.example.com" }, /must use HTTPS/u],
    [{ ...base, applicationUrl: "not a URL" }, /valid HTTPS application URL/u],
    [{ ...base, fields: {} }, /field assertions are invalid/u],
    [{ ...base, fields: [null] }, /field assertion is invalid/u],
    [{ ...base, fields: [{ key: "missing" }] }, /no longer available/u],
    [{
      ...base,
      fields: [{ key: "root:title" }, { key: "root:title" }],
    }, /invalid or duplicated/u],
    [{
      ...base,
      publishSubItems: false,
      fields: [{ key: "child:title" }],
    }, /Enable Descendants/u],
    [{ ...base, route: "", fields: [{ key: "root:title" }] }, /enter its route/u],
    [{
      ...base,
      fields: [{ key: "root:title", browserSelector: "h1" }],
    }, /exact application URL/u],
  ];

  for (const [value, expected] of invalid) {
    const result = validateTracedPublishSubmission(value, fields, sites, "traced");
    strictEqual(typeof result, "string");
    match(String(result), expected);
  }
});
