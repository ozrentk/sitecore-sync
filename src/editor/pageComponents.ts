import type { AuthoringSite } from "../sitecore/authoringClient";

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const guid = (value: unknown): value is string => typeof value === "string" && /^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}|\{[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}\})$/iu.test(value);
const normalized = (value: string): string => value.replace(/[{}-]/gu, "").toLowerCase();
export interface ComponentOccurrence {
  readonly key: string;
  readonly uid?: string;
  readonly name: string;
  readonly datasource: string;
  readonly datasourceKind: "none" | "item" | "unresolved";
  readonly parameters: Readonly<Record<string, string>>;
  readonly issues: readonly string[];
  readonly placeholders: readonly ComponentPlaceholder[];
}
export interface ComponentPlaceholder { readonly name: string; readonly components: readonly ComponentOccurrence[]; }
export interface PageComponents {
  readonly name: string;
  readonly requestedLanguage: string;
  readonly returnedLanguage: string;
  readonly returnedVersion: number;
  readonly device: string;
  readonly placeholders: readonly ComponentPlaceholder[];
  readonly count: number;
}
export interface ComponentSelection { readonly itemId: string; readonly language: string; readonly site: string; }
/** Verified in Dev at /sitecore/layout/Devices/Default; never infer Default from a missing ID. */
export function componentDeviceName(device: string): string {
  return normalized(device) === "fe5d7fdf89c04d999aa3b5fbd009c9f3" ? "Default" : device;
}
function fail(): never { throw Error("Preview did not return a complete layout for the selected page, site and language."); }

/** Preserve occurrences, not a UID-keyed map: repeated UIDs must never silently overwrite nodes. */
export function parsePageComponents(report: unknown, selected: ComponentSelection, signal?: AbortSignal): PageComponents {
  signal?.throwIfAborted();
  if (!record(report) || report.status !== "collected" || !record(report.rendered) || !record(report.rendered.sitecore)) fail();
  const { context, route } = report.rendered.sitecore;
  if (!record(context) || !record(context.site) || context.site.name !== selected.site || context.language !== selected.language
    || !record(route) || !guid(route.itemId) || normalized(route.itemId) !== normalized(selected.itemId)
    || route.databaseName !== "master" || route.itemLanguage !== selected.language
    || !Number.isSafeInteger(route.itemVersion) || Number(route.itemVersion) < 1 || typeof route.name !== "string") fail();
  let count = 0;
  const seen = new Set<string>();
  const text = (value: unknown): string => {
    if (typeof value !== "string" || value.length > 8192) fail();
    return value;
  };
  const walk = (value: unknown, path: readonly (number | string)[], depth: number): ComponentPlaceholder[] => {
    signal?.throwIfAborted();
    if (depth > 20 || !record(value) || Object.keys(value).length > 100) fail();
    return Object.entries(value).map(([name, children]) => {
      if (!Array.isArray(children)) fail();
      return { name: text(name), components: children.map((child: unknown, index): ComponentOccurrence => {
        signal?.throwIfAborted();
        if (++count > 500 || !record(child)) fail();
        const uid = guid(child.uid) ? child.uid : undefined;
        const issues: string[] = [];
        if (!uid) issues.push("Instance identity unavailable");
        else {
          if (seen.has(normalized(uid))) issues.push("Repeated instance identity; kept as a separate occurrence");
          seen.add(normalized(uid));
        }
        if (child.isContentResolved !== true) issues.push("Content resolution unverified");
        const datasource = child.dataSource === undefined ? "" : text(child.dataSource);
        const datasourceKind = !datasource ? "none" : Boolean(guid(datasource)) || /^\/sitecore(?:\/[^/\r\n]+)+$/iu.test(datasource)
          && !datasource.split("/").some(segment => segment === "." || segment === "..") ? "item" : "unresolved";
        const parameters: Record<string, string> = Object.create(null) as Record<string, string>;
        if (child.params !== undefined) {
          if (!record(child.params) || Object.keys(child.params).length > 200) fail();
          for (const [key, entry] of Object.entries(child.params)) parameters[text(key)] = text(entry);
        }
        const location = [...path, name, index];
        return { key: JSON.stringify(location), uid, name: typeof child.componentName === "string" ? text(child.componentName) : "Unnamed component",
          datasource, datasourceKind, parameters, issues,
          placeholders: child.placeholders === undefined ? [] : walk(child.placeholders, location, depth + 1) };
      }) };
    });
  };
  const placeholders = walk(route.placeholders, [], 0);
  return { name: text(route.name), requestedLanguage: selected.language, returnedLanguage: text(route.itemLanguage),
    returnedVersion: Number(route.itemVersion), device: guid(route.deviceId) ? route.deviceId : "Unknown", placeholders, count };
}

/** Candidate only. Preview item identity validation is mandatory before displaying a result. */
export function componentRoute(path: string, site: AuthoringSite): string {
  const segments = path.split("/").filter(Boolean), root = site.rootPath.split("/").filter(Boolean);
  if (!root.length || !root.every((part, index) => part.toLowerCase() === segments[index]?.toLowerCase())) throw Error("The page is outside the selected site.");
  const remainder = segments.slice(root.length);
  const home = remainder.findIndex(part => part.toLowerCase() === "home");
  if (home < 0) throw Error("Cannot determine this site's page route. Select the site-relative route explicitly.");
  return "/" + remainder.slice(home + 1).join("/");
}

export const escapeComponentHtml = (value: string): string => value.replace(/[&<>"']/gu, character =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);

export interface ComponentDatasource {
  readonly itemId?: string;
  readonly label: string;
  readonly path?: string;
}

/** Deduplicate only lookups, never component occurrences. Four readers bound server pressure. */
export async function resolveComponentDatasources(tree: PageComponents,
  read: (reference: string) => Promise<ComponentDatasource>, signal: AbortSignal): Promise<ReadonlyMap<string, ComponentDatasource>> {
  const references = new Set<string>();
  const walk = (placeholders: readonly ComponentPlaceholder[]): void => {
    for (const placeholder of placeholders) for (const component of placeholder.components) {
      if (component.datasourceKind === "item") references.add(component.datasource);
      walk(component.placeholders);
    }
  };
  walk(tree.placeholders);
  const pending = [...references], result = new Map<string, ComponentDatasource>();
  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
    while (pending.length) {
      signal.throwIfAborted();
      const reference = pending.shift()!;
      try { result.set(reference, await read(reference)); }
      catch { signal.throwIfAborted(); result.set(reference, { label: "Missing or unavailable in the requested language" }); }
    }
  }));
  signal.throwIfAborted();
  return result;
}

export function renderComponentTree(tree: PageComponents, datasources: ReadonlyMap<string, ComponentDatasource> = new Map()): string {
  const esc = escapeComponentHtml;
  const datasource = (component: ComponentOccurrence): string => {
    const resolved = datasources.get(component.datasource);
    if (resolved?.itemId) return `<button data-datasource="${esc(component.key)}">${esc(resolved.label)}</button>`;
    if (resolved) return esc(resolved.label);
    return component.datasource ? `${esc(component.datasource.startsWith("/sitecore/") ? component.datasource.split("/").at(-1)! : component.datasource)} — ${component.datasourceKind === "unresolved" ? "resolution unknown" : "reference only"}` : "None declared";
  };
  const render = (placeholders: readonly ComponentPlaceholder[]): string => placeholders.map(placeholder =>
    `<li class="placeholder"><details open><summary>${esc(placeholder.name)} <span>(${placeholder.components.length})</span></summary><ul>${placeholder.components.map(component =>
      `<li class="component"><details open><summary><button data-component="${esc(component.key)}">${esc(component.name)}</button></summary>
      <div class="datasource">Datasource: ${datasource(component)}</div>
      ${component.issues.map(issue => `<p class="muted">${esc(issue)}</p>`).join("")}
      <ul>${render(component.placeholders)}</ul></details></li>`).join("")}</ul></details></li>`).join("");
  return tree.count ? `<ul class="tree">${render(tree.placeholders)}</ul>` : "<p>No components were returned for this page.</p>";
}
