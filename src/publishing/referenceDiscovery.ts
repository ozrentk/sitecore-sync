import type { AuthoringItemField } from "../sitecore/authoringClient";

export type ObservedReferenceKind =
  | "content"
  | "media"
  | "externalLink"
  | "configuration"
  | "unsupported";

export interface ParsedItemReference {
  readonly target: string;
  readonly fieldName: string;
  readonly fieldType: string;
  readonly relationKind: "layoutDatasource" | "itemLink" | "media";
}

export interface ParsedReferenceField {
  readonly itemReferences: readonly ParsedItemReference[];
  readonly externalLinks: readonly string[];
  readonly unresolved: readonly string[];
}

const itemIdPattern = /\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?/giu;

export function parseReferenceField(field: AuthoringItemField): ParsedReferenceField {
  const type = `${field.type} ${field.typeKey}`.toLocaleLowerCase();
  if (includesAny(type, ["layout"])) {
    return parseLayoutField(field);
  }
  if (includesAny(type, ["general link", "general-link"])) {
    return parseGeneralLinkField(field);
  }
  if (includesAny(type, ["image", "file"])) {
    return parseMediaField(field);
  }
  if (
    includesAny(type, [
      "droplink",
      "droptree",
      "multilist",
      "treelist",
      "tree list",
      "checklist",
    ])
  ) {
    return {
      itemReferences: uniqueTargets(extractItemIds(field.value)).map((target) =>
        itemReference(field, target, "itemLink")
      ),
      externalLinks: [],
      unresolved: [],
    };
  }
  return emptyResult();
}

export function isSupportedReferenceField(field: AuthoringItemField): boolean {
  const parsed = parseReferenceField(field);
  return parsed.itemReferences.length > 0 ||
    parsed.externalLinks.length > 0 ||
    parsed.unresolved.length > 0;
}

export function classifyReferencePath(path: string): ObservedReferenceKind {
  const normalized = normalizePath(path);
  if (isAtOrBelow(normalized, "/sitecore/content")) {
    return "content";
  }
  if (isAtOrBelow(normalized, "/sitecore/media library")) {
    return "media";
  }
  if (
    isAtOrBelow(normalized, "/sitecore/layout") ||
    isAtOrBelow(normalized, "/sitecore/templates") ||
    isAtOrBelow(normalized, "/sitecore/system")
  ) {
    return "configuration";
  }
  return "unsupported";
}

export function isPathInsideScope(path: string, scopeRootPath: string): boolean {
  return isAtOrBelow(normalizePath(path), normalizePath(scopeRootPath));
}

function parseLayoutField(field: AuthoringItemField): ParsedReferenceField {
  const decoded = decodeXmlEntities(field.value);
  const values = attributeValues(decoded, ["ds", "datasource"]);
  const itemReferences: ParsedItemReference[] = [];
  const unresolved: string[] = [];
  for (const raw of values) {
    for (const candidate of splitDatasourceValue(raw)) {
      const target = itemTarget(candidate);
      if (target) {
        itemReferences.push(itemReference(field, target, "layoutDatasource"));
      } else if (candidate) {
        unresolved.push(`${field.name}: unsupported datasource ${JSON.stringify(candidate)}`);
      }
    }
  }
  return {
    itemReferences: uniqueReferences(itemReferences),
    externalLinks: [],
    unresolved: uniqueTargets(unresolved),
  };
}

function parseGeneralLinkField(field: AuthoringItemField): ParsedReferenceField {
  const decoded = decodeXmlEntities(field.value);
  const linkType = attributeValues(decoded, ["linktype"])[0]?.toLocaleLowerCase();
  const urls = attributeValues(decoded, ["url"]);
  const itemTargets = [
    ...attributeValues(decoded, ["id", "mediaid"]),
    ...extractItemIds(decoded),
  ]
    .map(itemTarget)
    .filter((target): target is string => Boolean(target));
  const externalLinks = linkType === "external" || linkType === "mailto" ||
      linkType === "anchor" || linkType === "javascript"
    ? urls.filter(Boolean)
    : [];
  return {
    itemReferences: uniqueTargets(itemTargets).map((target) =>
      itemReference(field, target, "itemLink")
    ),
    externalLinks: uniqueTargets(externalLinks),
    unresolved: [],
  };
}

function parseMediaField(field: AuthoringItemField): ParsedReferenceField {
  const decoded = decodeXmlEntities(field.value);
  const targets = [
    ...attributeValues(decoded, ["mediaid", "id"]),
    ...extractItemIds(decoded),
  ]
    .map(itemTarget)
    .filter((target): target is string => Boolean(target));
  return {
    itemReferences: uniqueTargets(targets).map((target) =>
      itemReference(field, target, "media")
    ),
    externalLinks: [],
    unresolved: [],
  };
}

function attributeValues(value: string, names: readonly string[]): readonly string[] {
  const wanted = new Set(names.map((name) => name.toLocaleLowerCase()));
  const values: string[] = [];
  const pattern = /(?:^|[\s<])(?:[a-z][\w.-]*:)?([\w.-]+)\s*=\s*(["'])(.*?)\2/giu;
  for (const match of value.matchAll(pattern)) {
    if (wanted.has((match[1] ?? "").toLocaleLowerCase())) {
      values.push(match[3] ?? "");
    }
  }
  return values;
}

function splitDatasourceValue(value: string): readonly string[] {
  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }
  // Sitecore layout datasource fields occasionally contain a pipe-separated list.
  return trimmed.split("|").map((candidate) => candidate.trim()).filter(Boolean);
}

function itemTarget(value: string): string | undefined {
  const trimmed = value.trim();
  const id = trimmed.match(itemIdPattern)?.[0];
  if (id && id.length === trimmed.length) {
    return id;
  }
  const lowered = trimmed.toLocaleLowerCase();
  return lowered.startsWith("/sitecore/") ||
      lowered.startsWith("local:/") ||
      lowered.startsWith("./")
    ? trimmed
    : undefined;
}

function extractItemIds(value: string): readonly string[] {
  return value.match(itemIdPattern) ?? [];
}

function itemReference(
  field: AuthoringItemField,
  target: string,
  relationKind: ParsedItemReference["relationKind"],
): ParsedItemReference {
  return {
    target,
    fieldName: field.name,
    fieldType: field.type || field.typeKey,
    relationKind,
  };
}

function uniqueReferences(
  references: readonly ParsedItemReference[],
): readonly ParsedItemReference[] {
  const seen = new Set<string>();
  return references.filter((reference) => {
    const key = reference.target.toLocaleLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function uniqueTargets(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLocaleLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function emptyResult(): ParsedReferenceField {
  return { itemReferences: [], externalLinks: [], unresolved: [] };
}

function includesAny(value: string, tokens: readonly string[]): boolean {
  return tokens.some((token) => value.includes(token));
}

function decodeXmlEntities(value: string): string {
  return value
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function normalizePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/\/+/gu, "/").replace(/\/$/u, "");
  return normalized.toLocaleLowerCase();
}

function isAtOrBelow(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}
