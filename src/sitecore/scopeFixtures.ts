import type { AuthoringContentClient, AuthoringItemDetails, AuthoringFieldScope } from "./authoringClient";
import type { XmCloudConnection } from "../connections/connection";
import { fixtureGuid } from "./fallbackFixtures";

export const scopeFields = [
  { name: "FixtureEnabled", scope: "VERSIONED", fallback: true },
  { name: "FixtureDisabled", scope: "VERSIONED", fallback: false },
  { name: "FixtureDefaulted", scope: "VERSIONED", fallback: true },
  { name: "FixtureShared", scope: "SHARED", fallback: false },
  { name: "FixtureUnversioned", scope: "UNVERSIONED", fallback: true },
] as const;
export const scopeSourceValues = { FixtureEnabled: "English enabled source", FixtureDisabled: "English disabled source",
  FixtureDefaulted: "English explicit defaulted source", FixtureShared: "Shared source", FixtureUnversioned: "English unversioned source" } as const;

export interface ScopeFixtureManifest {
  templateId: string;
  templatePath: string;
  itemId: string;
  path: string;
  languages: string[];
  fields: { fieldId: string; name: string; scope: AuthoringFieldScope }[];
}
export interface ScopeFixturePlan {
  name: string;
  parentId: string;
  parentPath: string;
  templateParentId: string;
  templatePath: string;
  languages: string[];
  definitions: { template: string; section: string; field: string; standard: string };
}
export interface ScopeFixtureStep {
  path: string;
  language: string;
  itemId?: string;
  version?: number;
  status: "outcome-unknown" | "created" | "updated" | "version-created";
}
type Client = Pick<AuthoringContentClient, "loadItem" | "createItem" | "updateItemFields" | "addItemVersion">;
const normalize = (value: string): string => value.replace(/[{}-]/gu, "").toLowerCase();
function sameId(left: string, right: string): boolean { return normalize(left) === normalize(right); }

export async function prepareScopeFixture(client: Client, connection: XmCloudConnection, secret: string,
  parent: { path: string } | { itemId: string }, languages: string[], runId: string, signal: AbortSignal): Promise<ScopeFixturePlan> {
  if (languages.length < 2 || languages.length > 3 || languages.at(-1) !== "en"
    || new Set(languages.map(value => value.toLowerCase())).size !== languages.length
    || languages.some(value => !/^[a-z]{2,8}(?:-[a-z\d]{1,8})*$/iu.test(value)) || !/^[a-f\d]{12}$/u.test(runId)) {
    throw new Error("Use two or three distinct locales ending in en for this fixture.");
  }
  const paths = ["/sitecore/templates/User Defined", "/sitecore/templates/System/Templates/Template",
    "/sitecore/templates/System/Templates/Template section", "/sitecore/templates/System/Templates/Template field",
    "/sitecore/templates/System/Templates/Standard template"];
  const items = await Promise.all(paths.map(path => client.loadItem(connection, secret, { path }, "en", undefined, signal)));
  for (const [index, item] of items.entries()) {
    if (item.path.toLowerCase() !== paths[index]!.toLowerCase() || !/^[a-f\d]{32}$/u.test(normalize(item.itemId))) {
      throw new Error("Template metadata identity mismatch.");
    }
    if (index > 0 && !sameId(item.template.templateId, items[1]!.itemId)) { throw new Error("Unexpected template metadata type."); }
  }
  const contentParent = await client.loadItem(connection, secret, parent, "en", undefined, signal);
  if (!/^\/sitecore\/content\/.+/iu.test(contentParent.path)) { throw new Error("Choose a content parent."); }
  const name = `xm-fallback-scope-${runId}`;
  return { name, parentId: contentParent.itemId, parentPath: contentParent.path,
    templateParentId: items[0]!.itemId, templatePath: `${paths[0]}/${name}`, languages,
    definitions: { template: items[1]!.itemId, section: items[2]!.itemId, field: items[3]!.itemId, standard: items[4]!.itemId } };
}

/** Fixed recipe: only new IDs returned during this execution can become write targets. */
export async function createScopeFixture(plan: ScopeFixturePlan, client: Client, connection: XmCloudConnection, secret: string,
  checkpoint: (steps: readonly ScopeFixtureStep[]) => Promise<void>, signal: AbortSignal): Promise<ScopeFixtureManifest> {
  const steps: ScopeFixtureStep[] = [];
  const createdIds = new Set<string>();
  const mutate = async (step: ScopeFixtureStep, action: () => Promise<AuthoringItemDetails>,
    status: ScopeFixtureStep["status"]): Promise<AuthoringItemDetails> => {
    signal.throwIfAborted(); steps.push(step); await checkpoint(steps); signal.throwIfAborted();
    const item = await action();
    if (!/^[a-f\d]{32}$/u.test(normalize(item.itemId)) || item.path !== step.path
      || item.language.toLowerCase() !== step.language.toLowerCase() || item.version !== 1
      || (step.itemId && !sameId(item.itemId, step.itemId))) { throw new Error("Fixture mutation identity mismatch."); }
    if (status === "created") {
      if (createdIds.has(normalize(item.itemId))
        || [plan.parentId, plan.templateParentId, ...Object.values(plan.definitions)].some(id => sameId(id, item.itemId))) {
        throw new Error("Fixture creation returned an existing identity.");
      }
      createdIds.add(normalize(item.itemId));
    }
    step.itemId = item.itemId; step.version = item.version; step.status = status; await checkpoint(steps);
    return item;
  };
  const create = (name: string, parentId: string, path: string, templateId: string, fields: Record<string, string> = {}) =>
    mutate({ path, language: "en", status: "outcome-unknown" }, () => client.createItem(connection, secret,
      { name, parent: fixtureGuid(parentId), templateId: fixtureGuid(templateId), language: "en", fields }, signal), "created");
  const update = (item: AuthoringItemDetails, language: string, fields: Record<string, string>) => {
    if (!createdIds.has(normalize(item.itemId))) { throw new Error("Fixture update is not owned by this run."); }
    return mutate({ path: item.path, itemId: item.itemId, language, status: "outcome-unknown" },
      () => client.updateItemFields(connection, secret, { itemId: item.itemId, language, version: 1, fields }, signal), "updated");
  };
  const version = (item: AuthoringItemDetails, language: string) => {
    if (!createdIds.has(normalize(item.itemId))) { throw new Error("Fixture version is not owned by this run."); }
    return mutate({ path: item.path, itemId: item.itemId, language, status: "outcome-unknown" },
      () => client.addItemVersion(connection, secret, { itemId: item.itemId, language }, signal), "version-created");
  };
  const template = await create(plan.name, plan.templateParentId, plan.templatePath, plan.definitions.template,
    { "__Base template": fixtureGuid(plan.definitions.standard) });
  if (!sameId(template.fields.find(field => field.name === "__Base template")?.value ?? "", plan.definitions.standard)) {
    throw new Error("Fixture base template verification failed.");
  }
  const section = await create("Fixture fields", template.itemId, `${template.path}/Fixture fields`, plan.definitions.section);
  const fields: ScopeFixtureManifest["fields"] = [];
  for (const field of scopeFields) {
    const item = await create(field.name, section.itemId, `${section.path}/${field.name}`, plan.definitions.field,
      { Type: "Single-Line Text", Shared: field.scope === "SHARED" ? "1" : "",
        Unversioned: field.scope === "UNVERSIONED" ? "1" : "",
        "Enable Shared Language Fallback": field.fallback ? "1" : "", "Enable Language Fallback": "" });
    for (const [name, expected] of Object.entries({ Type: "Single-Line Text", Shared: field.scope === "SHARED" ? "1" : "",
      Unversioned: field.scope === "UNVERSIONED" ? "1" : "", "Enable Shared Language Fallback": field.fallback ? "1" : "",
      "Enable Language Fallback": "" })) {
      if (item.fields.find(candidate => candidate.name === name)?.value !== expected) { throw new Error("Fixture field settings verification failed."); }
    }
    fields.push({ fieldId: item.itemId, name: field.name, scope: field.scope });
  }
  const defaults = await create("__Standard Values", template.itemId, `${template.path}/__Standard Values`, template.itemId,
    { FixtureDefaulted: "Source standard default" });
  const linked = await update(template, "en", { "__Standard values": fixtureGuid(defaults.itemId) });
  if (!sameId(linked.fields.find(field => field.name === "__Standard values")?.value ?? "", defaults.itemId)) {
    throw new Error("Fixture Standard Values link verification failed.");
  }
  await version(defaults, plan.languages[0]!);
  await update(defaults, plan.languages[0]!, { FixtureDefaulted: "Requested standard default" });
  const content = await create(plan.name, plan.parentId, `${plan.parentPath}/${plan.name}`, template.itemId,
    scopeSourceValues);
  for (const language of plan.languages.slice(0, -1)) { await version(content, language); }
  const manifest: ScopeFixtureManifest = { templateId: template.itemId, templatePath: template.path,
    itemId: content.itemId, path: content.path, fields, languages: [...plan.languages] };
  // Verify actual scopes, IDs and defaults before granting any subsequent scoped editing capability.
  for (const language of ["en", plan.languages[0]!]) {
    const item = await client.loadItem(connection, secret, { itemId: content.itemId }, language, 1, signal);
    assertScopeItem(manifest, item);
    const defaulted = item.fields.find(field => field.name === "FixtureDefaulted")!;
    if (defaulted.value !== (language === "en" ? "English explicit defaulted source" : "Requested standard default")
      || (language !== "en" && !defaulted.containsStandardValue)) { throw new Error("Fixture Standard Values verification failed."); }
  }
  return manifest;
}

export function assertScopeItem(fixture: ScopeFixtureManifest, item: AuthoringItemDetails): void {
  if (!sameId(item.itemId, fixture.itemId) || item.path !== fixture.path || !sameId(item.template.templateId, fixture.templateId)
    || !fixture.languages.some(language => language.toLowerCase() === item.language.toLowerCase())
    || item.version < 1 || item.version > 2) { throw new Error("Scope fixture identity changed."); }
  for (const expected of fixture.fields) {
    const matches = item.fields.filter(field => sameId(field.fieldId, expected.fieldId));
    const field = matches[0];
    if (matches.length !== 1 || !field || field.name !== expected.name || field.scope !== expected.scope
      || field.isStandardTemplate || field.type.toLowerCase() !== "single-line text" || field.containsFallbackValue
      || item.fields.filter(candidate => candidate.name.toLowerCase() === field.name.toLowerCase()).length !== 1) {
      throw new Error("Scope fixture field contract changed.");
    }
  }
}
