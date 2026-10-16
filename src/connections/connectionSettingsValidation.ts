import { normalizeServerUrl } from "./connection";
import { validatePublicPageTemplate } from "../publicPages/publicPageUrl";

export interface SecretEdit { action: "keep" | "replace" | "remove"; value: string; }
export interface ConnectionSettingsInput {
  name: string; serverUrl: string; clientId: string; clientSecret: SecretEdit;
  deploymentEnabled: boolean; deploymentClientId: string; deploymentSecret: SecretEdit;
  deploymentEnvironmentId: string;
  publishingEnabled: boolean; edgeEndpoint: string; edgeToken: SecretEdit; siteName: string;
  applicationBaseUrl: string; publicTemplate: string; defaultSite: string;
  sites: { name: string; publicBaseUrl: string; deploymentBaseUrl: string }[];
}
export class SettingsValidationError extends Error {
  constructor(readonly errors: Record<string, string>) { super("Check the highlighted fields."); }
}
export function parseConnectionSettings(value: unknown, section = "save"): ConnectionSettingsInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) { throw new SettingsValidationError({ form: "Invalid settings." }); }
  const raw = value as Record<string, unknown>;
  const errors: Record<string, string> = {};
  const string = (key: string): string => {
    if (typeof raw[key] !== "string" || raw[key].length > 16000) { errors[key] = "Enter a valid value."; return ""; }
    return raw[key].trim();
  };
  const secret = (key: string): SecretEdit => {
    const edit = raw[key] as Partial<SecretEdit> | undefined;
    if (!edit || !["keep", "replace", "remove"].includes(edit.action ?? "") || typeof edit.value !== "string" || edit.value.length > 16000) {
      errors[key] = "Choose how to update this secret."; return { action: "keep", value: "" };
    }
    if (edit.action === "replace" && !edit.value.trim()) { errors[key] = "Enter a replacement secret."; }
    return { action: edit.action as SecretEdit["action"], value: edit.action === "replace" ? edit.value : "" };
  };
  const input: ConnectionSettingsInput = {
    name: string("name"), serverUrl: string("serverUrl"), clientId: string("clientId"), clientSecret: secret("clientSecret"),
    deploymentEnabled: raw.deploymentEnabled === true, deploymentClientId: string("deploymentClientId"), deploymentSecret: secret("deploymentSecret"), deploymentEnvironmentId: string("deploymentEnvironmentId"),
    publishingEnabled: raw.publishingEnabled === true, edgeEndpoint: string("edgeEndpoint"), edgeToken: secret("edgeToken"), siteName: string("siteName"),
    applicationBaseUrl: string("applicationBaseUrl"), publicTemplate: string("publicTemplate"), defaultSite: string("defaultSite"), sites: [],
  };
  if (typeof raw.deploymentEnabled !== "boolean" || typeof raw.publishingEnabled !== "boolean") { errors.form = "Invalid settings switches."; }
  if (!input.name) { errors.name = "Connection name is required."; }
  if (!input.clientId) { errors.clientId = "Client ID is required."; }
  try { input.serverUrl = normalizeServerUrl(input.serverUrl); } catch { errors.serverUrl = "Enter an HTTPS CM origin without credentials, path, query or fragment."; }
  if (section === "save" || section === "deployment") {
    if (input.deploymentEnabled && !input.deploymentClientId) { errors.deploymentClientId = "Organization client ID is required."; }
    if (input.deploymentEnvironmentId && !/^[a-zA-Z0-9_-]+$/u.test(input.deploymentEnvironmentId)) { errors.deploymentEnvironmentId = "Enter a valid environment ID."; }
  }
  if ((section === "save" || section === "publishing") && input.publishingEnabled) {
    try {
      const url = new URL(input.edgeEndpoint);
      if (url.protocol !== "https:" || url.username || url.password || url.hash) { throw new Error(); }
    } catch { errors.edgeEndpoint = "Enter an HTTPS endpoint without credentials or fragment."; }
  }
  if (section === "save" && input.applicationBaseUrl) {
    try { const url = new URL(input.applicationBaseUrl); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) { throw new Error(); } }
    catch { errors.applicationBaseUrl = "Enter an HTTP(S) application URL without credentials."; }
  }
  if (section === "save") {
    const templateError = validatePublicPageTemplate(input.publicTemplate);
    if (templateError) { errors.publicTemplate = templateError; }
    if (!Array.isArray(raw.sites) || raw.sites.length > 500) { errors.sites = "Invalid site list."; }
    else {
      const names = new Set<string>();
      input.sites = raw.sites.flatMap((site: unknown) => {
        if (!site || typeof site !== "object") { errors.sites = "Invalid site entry."; return []; }
        const row = site as Record<string, unknown>;
        if (["name", "publicBaseUrl", "deploymentBaseUrl"].some(key => typeof row[key] !== "string" || (row[key] as string).length > 2048)) { errors.sites = "Invalid site values."; return []; }
        const name = (row.name as string).trim();
        if (!name || ["__proto__", "constructor", "prototype"].includes(name) || names.has(name)) { errors.sites = "Site names must be non-empty and unique."; }
        names.add(name);
        const result = { name, publicBaseUrl: (row.publicBaseUrl as string).trim(), deploymentBaseUrl: (row.deploymentBaseUrl as string).trim() };
        for (const key of ["publicBaseUrl", "deploymentBaseUrl"] as const) {
          if (!result[key]) { continue; }
          try {
            const url = new URL(result[key]);
            if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) { throw new Error(); }
            result[key] = url.origin;
          } catch { errors.sites = `${name}: base URLs must be HTTP(S) origins without credentials, paths, queries or fragments.`; }
        }
        return [result];
      });
      if (input.defaultSite && !names.has(input.defaultSite)) { errors.defaultSite = "Choose a site from the list."; }
    }
  }
  // Tests for one section must not be blocked by unfinished secret edits elsewhere.
  if (section === "connection") { delete errors.deploymentSecret; delete errors.edgeToken; }
  if (section === "deployment") { delete errors.edgeToken; }
  if (section === "publishing") { delete errors.deploymentSecret; }
  if (Object.keys(errors).length) { throw new SettingsValidationError(errors); }
  return input;
}
