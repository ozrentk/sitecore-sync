import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import type { AuthoringItemField } from "../../src/sitecore/authoringClient";
import {
  classifyReferencePath,
  isPathInsideScope,
  isSupportedReferenceField,
  parseReferenceField,
} from "../../src/publishing/referenceDiscovery";

const firstId = "{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}";
const secondId = "{BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB}";

test("parseReferenceField extracts and deduplicates layout datasources", () => {
  const parsed = parseReferenceField(authoringField(
    "Layout",
    `<r><d><r ds=&quot;${firstId}|${firstId.toLowerCase()}|/sitecore/content/Tenant/Home/Hero|./Local|https://example.com&quot; /></d></r>`,
    "__Renderings",
  ));

  deepStrictEqual(
    parsed.itemReferences.map((reference) => ({
      target: reference.target,
      relationKind: reference.relationKind,
    })),
    [
      { target: firstId, relationKind: "layoutDatasource" },
      {
        target: "/sitecore/content/Tenant/Home/Hero",
        relationKind: "layoutDatasource",
      },
      { target: "./Local", relationKind: "layoutDatasource" },
    ],
  );
  deepStrictEqual(parsed.externalLinks, []);
  deepStrictEqual(parsed.unresolved, [
    '__Renderings: unsupported datasource "https://example.com"',
  ]);
});

test("parseReferenceField records external general links", () => {
  const parsed = parseReferenceField(authoringField(
    "General Link",
    '<link linktype="external" url="https://example.com/article" />',
    "Link",
  ));

  deepStrictEqual(parsed.itemReferences, []);
  deepStrictEqual(parsed.externalLinks, ["https://example.com/article"]);
  deepStrictEqual(parsed.unresolved, []);
});

test("parseReferenceField records internal general-link targets", () => {
  const parsed = parseReferenceField(authoringField(
    "General-Link",
    `<link linktype="internal" id="${firstId}" />`,
    "Link",
  ));

  deepStrictEqual(parsed.itemReferences, [{
    target: firstId,
    fieldName: "Link",
    fieldType: "General-Link",
    relationKind: "itemLink",
  }]);
  deepStrictEqual(parsed.externalLinks, []);
});

test("parseReferenceField extracts one media target from repeated markup", () => {
  const parsed = parseReferenceField(authoringField(
    "Image",
    `<image mediaid="${firstId}" src="-/media/${firstId}.ashx" />`,
    "Image",
  ));

  deepStrictEqual(parsed.itemReferences, [{
    target: firstId,
    fieldName: "Image",
    fieldType: "Image",
    relationKind: "media",
  }]);
});

test("parseReferenceField extracts unique IDs from multiselect fields", () => {
  const parsed = parseReferenceField(authoringField(
    "Multilist",
    `${firstId}|${secondId}|${firstId.toLowerCase()}`,
    "Related Items",
  ));

  deepStrictEqual(
    parsed.itemReferences.map((reference) => reference.target),
    [firstId, secondId],
  );
});

test("unsupported fields return an empty result", () => {
  const unsupported = authoringField("Single-Line Text", firstId, "Title");

  deepStrictEqual(parseReferenceField(unsupported), {
    itemReferences: [],
    externalLinks: [],
    unresolved: [],
  });
  strictEqual(isSupportedReferenceField(unsupported), false);
});

test("unresolved layout values still identify a supported reference field", () => {
  const layout = authoringField(
    "Layout",
    '<r><d><r ds="query:./ancestor::*" /></d></r>',
    "__Final Renderings",
  );

  strictEqual(isSupportedReferenceField(layout), true);
  deepStrictEqual(parseReferenceField(layout).unresolved, [
    '__Final Renderings: unsupported datasource "query:./ancestor::*"',
  ]);
});

const pathClassifications: readonly {
  readonly path: string;
  readonly expected: ReturnType<typeof classifyReferencePath>;
}[] = [
  { path: "/sitecore/content", expected: "content" },
  { path: "\\SITECORE\\CONTENT\\Tenant\\Home\\", expected: "content" },
  { path: "/sitecore/media library/Images/Hero", expected: "media" },
  { path: "/sitecore/layout/Renderings/Hero", expected: "configuration" },
  { path: "/sitecore/templates/Feature/Hero", expected: "configuration" },
  { path: "/sitecore/system/Languages/en", expected: "configuration" },
  { path: "/sitecore/contentious/Not Content", expected: "unsupported" },
  { path: "/custom/content", expected: "unsupported" },
];

for (const classification of pathClassifications) {
  test(`classifyReferencePath classifies ${classification.path}`, () => {
    strictEqual(
      classifyReferencePath(classification.path),
      classification.expected,
    );
  });
}

test("isPathInsideScope accepts the root and its descendants", () => {
  strictEqual(
    isPathInsideScope(
      "/SITECORE/content/Tenant/Home/Hero",
      "/sitecore/content/tenant/home/",
    ),
    true,
  );
  strictEqual(
    isPathInsideScope(
      "/sitecore/content/Tenant/Home",
      "/sitecore/content/Tenant/Home",
    ),
    true,
  );
});

test("isPathInsideScope rejects sibling paths with the same prefix", () => {
  strictEqual(
    isPathInsideScope(
      "/sitecore/content/Tenant/Homepage",
      "/sitecore/content/Tenant/Home",
    ),
    false,
  );
});

function authoringField(
  type: string,
  value: string,
  name: string,
): AuthoringItemField {
  return {
    fieldId: "{00000000-0000-0000-0000-000000000000}",
    name,
    label: name,
    value,
    type,
    typeKey: type,
    scope: "VERSIONED",
    sortOrder: 0,
    sectionName: "Content",
    sectionSortOrder: 0,
    isStandardTemplate: false,
    containsFallbackValue: false,
    containsInheritedValue: false,
    containsStandardValue: false,
    textual: true,
  };
}
