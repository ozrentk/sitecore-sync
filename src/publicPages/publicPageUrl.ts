import type { AuthoringItemDetails, AuthoringSite } from "../sitecore/authoringClient";
import { isWithinPath } from "../comparison/itemNavigation";
import { suggestRoute } from "./route";

export interface PublicPageValues {
  readonly publicBaseUrl?: string;
  readonly deploymentBaseUrl?: string;
  readonly languages?: Readonly<Record<string, { readonly language?: string; readonly country?: string }>>;
}
export interface PublicPageConnectionValues {
  readonly defaultSite?: string;
  readonly sites?: Readonly<Record<string, PublicPageValues>>;
}
export interface PublicPageTarget { readonly url: string; readonly route: string; readonly page: AuthoringItemDetails; readonly site: AuthoringSite; }

export function resolvePublicPageUrl(template: string, values: PublicPageValues, language: string, route: string): string {
  if (!template.trim()) { throw new Error("Configure the shared public-page URL template first."); }
  const names = [...template.matchAll(/\{([^{}]+)\}/gu)].map(match => match[1]);
  const allowed = ["publicBaseUrl", "deploymentBaseUrl", "language", "country", "route"];
  if (names.some(name => !allowed.includes(name))) { throw new Error("The public-page template contains an unknown placeholder."); }
  const bases = names.filter(name => name.endsWith("BaseUrl"));
  if (bases.length > 1) { throw new Error("Use one base URL placeholder as the origin."); }
  const mapping = Object.entries(values.languages ?? {}).find(([key]) => key.toLowerCase() === language.toLowerCase())?.[1];
  const resolved = template.trim().replace(/\{([^{}]+)\}/gu, (_match, name: string) => {
    if (name.endsWith("BaseUrl")) {
      const base = values[name as "publicBaseUrl" | "deploymentBaseUrl"];
      if (!base) { throw new Error(`Configure ${name} for this connection and site.`); }
      const url = safeUrl(base);
      if (url.pathname !== "/" || url.search || url.hash || !template.trim().startsWith(`{${name}}`)) {
        throw new Error("Base URL placeholders must be origins at the start of the template.");
      }
      const after = template.trim().slice(name.length + 2);
      if (after && !after.startsWith("/") && !after.startsWith("{route}")) { throw new Error("Separate the base URL and following path with /."); }
      return url.origin;
    }
    if (name === "route") { return route.split("/").map(encodeURIComponent).join("/"); }
    const override = name === "language" ? mapping?.language : mapping?.country;
    const inferred = override === undefined ? inferLanguageParts(language) : undefined;
    const value = override ?? (name === "language" ? inferred?.language : inferred?.country);
    if (!value) { throw new Error(`Language ${language} has no region. Omit {country} or set an optional country override.`); }
    return encodeURIComponent(value);
  });
  if (/[{}]/u.test(resolved)) { throw new Error("The public-page URL contains unresolved placeholders."); }
  const url = safeUrl(resolved);
  url.pathname = url.pathname.replace(/\/{2,}/gu, "/");
  return url.toString();
}

export function inferLanguageParts(value: string): { readonly language: string; readonly country?: string } {
  try {
    const locale = new Intl.Locale(value);
    return { language: locale.language, country: locale.region };
  } catch { throw new Error(`Invalid language tag: ${value}. Use a language tag such as en-US.`); }
}

export function validatePublicPageTemplate(template: string): string | undefined {
  if (!template.trim()) { return undefined; }
  try {
    resolvePublicPageUrl(template, { publicBaseUrl: "https://preview.invalid", deploymentBaseUrl: "https://preview.invalid" }, "en-US", "/");
    return undefined;
  } catch (error: unknown) { return error instanceof Error ? error.message : String(error); }
}

export function resolveHomepageUrl(
  template: string, configuration: PublicPageConnectionValues, sites: readonly AuthoringSite[],
  language: string, itemPath?: string,
): string {
  const needsBaseUrl = /\{(?:publicBaseUrl|deploymentBaseUrl)\}/u.test(template);
  let matches = itemPath ? sites.filter(site => isWithinPath(itemPath, site.rootPath)) : [...sites];
  if (itemPath) {
    const longest = Math.max(...matches.map(site => site.rootPath.length));
    matches = matches.filter(site => site.rootPath.length === longest);
  }
  if (matches.length > 1 && matches.some(site => site.name === configuration.defaultSite)) {
    matches = matches.filter(site => site.name === configuration.defaultSite);
  }
  if (matches.length !== 1) {
    if (!needsBaseUrl) { return resolvePublicPageUrl(template, {}, language, "/"); }
    throw new Error("Select an item from the intended site in the comparison before previewing its homepage.");
  }
  return resolvePublicPageUrl(template, configuration.sites?.[matches[0].name] ?? {}, language, "/");
}

function safeUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("The resolved public-page URL must be an absolute HTTP or HTTPS URL."); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) { throw new Error("Public-page URLs must use HTTP(S) without credentials."); }
  return url;
}

export function hasPagePresentation(item: AuthoringItemDetails): boolean {
  // Authoring can return a final-layout delta without the layout assignment inherited
  // from Standard Values. A rendering assignment is also presentation evidence;
  // device IDs and rendering UIDs alone (including deletion patches) are not.
  return item.fields.some(field => {
    if (!["__renderings", "__final renderings"].includes(field.name.toLowerCase())) { return false; }
    const layout = /<d\b[^>]*\s(?:s:)?l\s*=\s*["']\{?[a-f0-9]{8}(?:-?[a-f0-9]{4}){3}-?[a-f0-9]{12}\}?["']/iu;
    const rendering = /<r\b[^>]*\s(?:s:)?id\s*=\s*["']\{?[a-f0-9]{8}(?:-?[a-f0-9]{4}){3}-?[a-f0-9]{12}\}?["']/iu;
    return layout.test(field.value) || [...field.value.matchAll(/<d\b[^>]*>([\s\S]*?)<\/d\s*>/giu)]
      .some(device => rendering.test(device[1]));
  });
}

export async function resolvePublicPage(
  template: string, configuration: PublicPageConnectionValues, sites: readonly AuthoringSite[],
  item: AuthoringItemDetails, language: string,
  loadPath: (path: string) => Promise<AuthoringItemDetails>, signal: AbortSignal, preferredSite?: string,
): Promise<PublicPageTarget> {
  let matches = sites.filter(site => isWithinPath(item.path, site.rootPath));
  if (preferredSite) { matches = matches.filter(site => site.name === preferredSite); }
  const longest = Math.max(...matches.map(site => site.rootPath.length));
  matches = matches.filter(site => site.rootPath.length === longest);
  if (matches.length > 1 && matches.some(site => site.name === configuration.defaultSite)) {
    matches = matches.filter(site => site.name === configuration.defaultSite);
  }
  if (matches.length !== 1) { throw new Error(matches.length ? "Several sites own this path. Configure a default site for this connection." : "This item is outside the configured Sitecore sites."); }
  const site = matches[0];
  let page = item;
  for (let depth = 0; depth < 100; depth += 1) {
    signal.throwIfAborted();
    if (hasPagePresentation(page)) {
      const route = suggestRoute(page.path, site.rootPath);
      return { page, site, route, url: resolvePublicPageUrl(template, configuration.sites?.[site.name] ?? {}, language, route) };
    }
    const parent = page.path.slice(0, page.path.lastIndexOf("/")) || "/";
    if (parent === page.path || !isWithinPath(parent, site.rootPath)) { break; }
    page = await loadPath(parent);
  }
  throw new Error("No page presentation was detected on this item or its ancestors within the site. Presentation inherited from Standard Values may not be returned by Authoring. Shared datasources outside page ancestry are unsupported.");
}

export function parsePublicPageConnectionValues(value: unknown): PublicPageConnectionValues {
  if (!value || typeof value !== "object" || Array.isArray(value)) { return {}; }
  const raw = value as Record<string, unknown>;
  const sites: Record<string, PublicPageValues> = {};
  if (raw.sites && typeof raw.sites === "object" && !Array.isArray(raw.sites)) {
    for (const [name, site] of Object.entries(raw.sites)) {
      if (!site || typeof site !== "object" || Array.isArray(site)) { continue; }
      const fields = site as Record<string, unknown>;
      const languages: Record<string, { language?: string; country?: string }> = {};
      if (fields.languages && typeof fields.languages === "object" && !Array.isArray(fields.languages)) {
        for (const [language, mapping] of Object.entries(fields.languages)) {
          if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) { continue; }
          const parts = mapping as Record<string, unknown>;
          languages[language] = { language: typeof parts.language === "string" ? parts.language : undefined, country: typeof parts.country === "string" ? parts.country : undefined };
        }
      }
      sites[name] = { publicBaseUrl: typeof fields.publicBaseUrl === "string" ? fields.publicBaseUrl : undefined, deploymentBaseUrl: typeof fields.deploymentBaseUrl === "string" ? fields.deploymentBaseUrl : undefined, languages };
    }
  }
  return { defaultSite: typeof raw.defaultSite === "string" ? raw.defaultSite : undefined, sites };
}
