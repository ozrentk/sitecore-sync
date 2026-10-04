import type { AuthoringContentClient, AuthoringItemDetails, AuthoringItemField } from "./authoringClient";
import type { XmCloudConnection } from "../connections/connection";
import type { ScopeFixtureManifest, ScopeFixtureStep } from "./scopeFixtures";
import { createHash } from "node:crypto";

const normalize = (value: string): string => value.replace(/[{}-]/gu, "").toLowerCase();
const fingerprint = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const ruleFields = [
  { name: "Enable Shared Language Fallback", id: "24cb32f0e3644f37b4000f2899097b5b", scope: "SHARED" },
  { name: "Enable Language Fallback", id: "fa6225380c134130a00145984241aa00", scope: "VERSIONED" },
] as const;
type Client = Pick<AuthoringContentClient, "loadItem" | "validateAddItemVersion" | "addItemVersion" | "updateItemFields">;
export interface ScopeRulePlan {
  fieldId: string;
  language: string;
  path: string;
  createVersion: boolean;
  sharedEnabled: boolean;
  languageEnabled: boolean;
  previousShared: string;
  previousLanguage: string | null;
  fingerprint: string;
}

function oneField(item: AuthoringItemDetails, name: string): AuthoringItemField {
  const matches = item.fields.filter(field => field.name.toLowerCase() === name.toLowerCase());
  if (matches.length !== 1 || matches[0]!.name !== name || matches[0]!.containsFallbackValue) {
    throw new Error("Fixture rule metadata is missing, ambiguous or fallback-derived.");
  }
  return matches[0]!;
}

/** The only writable metadata is the two known fallback checkboxes on recorded control fields. */
export function assertScopeRuleDefinition(fixture: ScopeFixtureManifest, fieldId: string, item: AuthoringItemDetails,
  language: string, allowMissing = false): void {
  const field = fixture.fields.find(candidate => normalize(candidate.fieldId) === normalize(fieldId));
  if (!field || !["FixtureEnabled", "FixtureDisabled"].includes(field.name) || field.scope !== "VERSIONED"
    || !fixture.languages.includes(language) || normalize(item.itemId) !== normalize(fieldId)
    || item.path !== `${fixture.templatePath}/Fixture fields/${field.name}`
    || normalize(item.template.templateId) !== "455a3e98a6274b408035e683a0331ac7"
    || item.language !== language || (item.version !== 1 && !(allowMissing && item.version === 0))) {
    throw new Error("Choose a recorded versioned control field definition and fixture locale.");
  }
  if (item.version === 0) {
    if (item.fields.length || item.availableVersions.some(version => version.language.toLowerCase() === language.toLowerCase())) {
      throw new Error("Fixture definition version state is inconsistent.");
    }
    return;
  }
  for (const rule of ruleFields) {
    const actual = oneField(item, rule.name);
    if (normalize(actual.fieldId) !== rule.id || actual.scope !== rule.scope || actual.type.toLowerCase() !== "checkbox"
      || !["", "1"].includes(actual.value) || actual.containsInheritedValue || actual.containsStandardValue) {
      throw new Error("Fixture fallback checkbox contract changed.");
    }
  }
  for (const [name, expected] of [["Type", "Single-Line Text"], ["Shared", ""], ["Unversioned", ""]] as const) {
    const actual = oneField(item, name);
    if (actual.scope !== "SHARED" || actual.value !== expected) { throw new Error("Fixture field type or scope changed."); }
  }
}

export async function prepareScopeRule(client: Client, connection: XmCloudConnection, secret: string,
  fixture: ScopeFixtureManifest, input: Pick<ScopeRulePlan, "fieldId" | "language" | "sharedEnabled" | "languageEnabled">,
  signal: AbortSignal): Promise<ScopeRulePlan> {
  const english = await client.loadItem(connection, secret, { itemId: input.fieldId }, "en", undefined, signal);
  assertScopeRuleDefinition(fixture, input.fieldId, english, "en");
  const local = input.language === "en" ? english
    : await client.loadItem(connection, secret, { itemId: input.fieldId }, input.language, undefined, signal);
  assertScopeRuleDefinition(fixture, input.fieldId, local, input.language, true);
  if (local.version === 0) {
    await client.validateAddItemVersion(connection, secret, { itemId: input.fieldId, language: input.language }, signal);
  }
  return { ...input, path: english.path, createVersion: local.version === 0,
    previousShared: oneField(english, ruleFields[0].name).value,
    previousLanguage: local.version === 0 ? null : oneField(local, ruleFields[1].name).value,
    fingerprint: fingerprint([english, local]) };
}

export async function executeScopeRule(client: Client, connection: XmCloudConnection, secret: string,
  fixture: ScopeFixtureManifest, plan: ScopeRulePlan,
  checkpoint: (steps: readonly ScopeFixtureStep[]) => Promise<void>, signal: AbortSignal): Promise<void> {
  const fresh = await prepareScopeRule(client, connection, secret, fixture, plan, signal);
  if (fresh.fingerprint !== plan.fingerprint || fresh.path !== plan.path || fresh.createVersion !== plan.createVersion) {
    throw new Error("Fixture rule definition changed after preview; no write was sent.");
  }
  const steps: ScopeFixtureStep[] = [];
  const before = async (): Promise<ScopeFixtureStep> => {
    signal.throwIfAborted();
    const step: ScopeFixtureStep = { path: plan.path, itemId: plan.fieldId, language: plan.language, status: "outcome-unknown" };
    steps.push(step); await checkpoint(steps); signal.throwIfAborted(); return step;
  };
  if (plan.createVersion) {
    const step = await before();
    const created = await client.addItemVersion(connection, secret, { itemId: plan.fieldId, language: plan.language }, signal);
    assertScopeRuleDefinition(fixture, plan.fieldId, created, plan.language);
    step.status = "version-created"; step.version = 1; await checkpoint(steps);
  }
  const step = await before();
  const updated = await client.updateItemFields(connection, secret, { itemId: plan.fieldId, language: plan.language, version: 1,
    fields: { [ruleFields[0].name]: plan.sharedEnabled ? "1" : "", [ruleFields[1].name]: plan.languageEnabled ? "1" : "" } }, signal);
  assertScopeRuleDefinition(fixture, plan.fieldId, updated, plan.language);
  if (oneField(updated, ruleFields[0].name).value !== (plan.sharedEnabled ? "1" : "")
    || oneField(updated, ruleFields[1].name).value !== (plan.languageEnabled ? "1" : "")) {
    throw new Error("Fixture rule write verification failed.");
  }
  step.status = "updated"; step.version = 1; await checkpoint(steps);
}
