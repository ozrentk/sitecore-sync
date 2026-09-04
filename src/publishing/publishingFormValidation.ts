import type { PublishMode } from "./publishingTypes";

export interface TracedPublishFieldCandidate {
  readonly key: string;
  readonly itemId: string;
  readonly itemName: string;
  readonly itemPath: string;
  readonly fieldName: string;
  readonly value: string;
  readonly descendant: boolean;
}

export interface TracedPublishSiteCandidate {
  readonly name: string;
  readonly rootPath: string;
  readonly suggestedRoute: string;
}

export interface TracedPublishFormResult {
  readonly mode: PublishMode;
  readonly publishSubItems: boolean;
  readonly publishRelatedItems: boolean;
  readonly siteName?: string;
  readonly route?: string;
  readonly applicationUrl?: string;
  readonly fields: readonly {
    readonly itemId: string;
    readonly fieldName: string;
    readonly browserSelector?: string;
  }[];
}

export type TracedPublishFormMessageType =
  | "ready"
  | "cancel"
  | "loadDescendants"
  | "submit";

export type PowerScopeFormMessageType = "ready" | "cancel" | "scan" | "submit";

export function readTracedPublishFormMessageType(
  value: unknown,
): TracedPublishFormMessageType | undefined {
  const type = messageType(value);
  return type === "ready" || type === "cancel" || type === "loadDescendants" || type === "submit"
    ? type
    : undefined;
}

export function readPowerScopeFormMessageType(
  value: unknown,
): PowerScopeFormMessageType | undefined {
  const type = messageType(value);
  return type === "ready" || type === "cancel" || type === "scan" || type === "submit"
    ? type
    : undefined;
}

export function readPowerScopeId(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.scopeId !== "string") {
    return undefined;
  }
  const scopeId = value.scopeId.trim();
  return scopeId || undefined;
}

export function readPowerScopeSelection(value: unknown): readonly string[] | string {
  if (
    !isRecord(value) ||
    !Array.isArray(value.selectedScopeIds) ||
    !value.selectedScopeIds.every((id) => typeof id === "string")
  ) {
    return "The selected Power Publish scopes are invalid.";
  }
  const selectedScopeIds = value.selectedScopeIds.map((id) => id.trim());
  if (
    selectedScopeIds.some((id) => !id) ||
    new Set(selectedScopeIds.map((id) => id.toLocaleLowerCase())).size !==
      selectedScopeIds.length
  ) {
    return "The selected Power Publish scopes are invalid.";
  }
  return selectedScopeIds;
}

export function validateTracedPublishSubmission(
  value: unknown,
  availableFields: readonly TracedPublishFieldCandidate[],
  sites: readonly TracedPublishSiteCandidate[],
  kind: "traced" | "power",
): TracedPublishFormResult | string {
  if (!isRecord(value)) {
    return "The publish configuration is invalid.";
  }
  if (value.mode !== "SMART" && value.mode !== "FULL") {
    return "Select Smart publish or Full publish.";
  }
  if (
    typeof value.publishSubItems !== "boolean" ||
    typeof value.publishRelatedItems !== "boolean"
  ) {
    return "The publish scope is invalid.";
  }
  const siteName = optionalString(value.siteName);
  if (sites.length > 0 && !siteName) {
    return "Select the Sitecore site used for route verification.";
  }
  if (
    siteName &&
    sites.length > 0 &&
    !sites.some((site) =>
      site.name.localeCompare(siteName, undefined, { sensitivity: "base" }) === 0
    )
  ) {
    return "Select a Sitecore site from the verified connection catalog.";
  }
  const route = optionalString(value.route);
  const applicationUrl = optionalString(value.applicationUrl);
  if (applicationUrl) {
    const validation = validateHttpsUrl(applicationUrl);
    if (validation) {
      return validation;
    }
  }
  if (!Array.isArray(value.fields)) {
    return "The selected field assertions are invalid.";
  }
  const available = new Map(availableFields.map((field) => [field.key, field]));
  const selections: TracedPublishFormResult["fields"][number][] = [];
  const seen = new Set<string>();
  for (const raw of value.fields) {
    if (!isRecord(raw)) {
      return "A selected field assertion is invalid.";
    }
    if (typeof raw.key !== "string" || seen.has(raw.key)) {
      return "A selected field assertion is invalid or duplicated.";
    }
    const field = available.get(raw.key);
    if (!field) {
      return "A selected field is no longer available.";
    }
    if (field.descendant && !value.publishSubItems && kind !== "power") {
      return "Enable Descendants before selecting fields owned by descendant items.";
    }
    if (!siteName || !route) {
      return "Select a Sitecore site and enter its route before selecting field assertions.";
    }
    const browserSelector = optionalString(raw.browserSelector);
    if (browserSelector && !applicationUrl) {
      return "Enter the exact application URL before publishing Browser DOM selectors.";
    }
    seen.add(raw.key);
    selections.push({
      itemId: field.itemId,
      fieldName: field.fieldName,
      browserSelector,
    });
  }
  return {
    mode: value.mode,
    publishSubItems: value.publishSubItems,
    publishRelatedItems: kind === "power" ? false : value.publishRelatedItems,
    siteName,
    route,
    applicationUrl,
    fields: selections,
  };
}

function messageType(value: unknown): unknown {
  return isRecord(value) ? value.type : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function validateHttpsUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? undefined : "Application URL must use HTTPS.";
  } catch {
    return "Enter a valid HTTPS application URL.";
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
