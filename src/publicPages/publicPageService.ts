import * as vscode from "vscode";
import type { ConnectionStore } from "../connections/connectionStore";
import type { AuthoringContentClient, AuthoringItemDetails } from "../sitecore/authoringClient";
import { parsePublicPageConnectionValues, resolvePublicPage, resolvePublicPageUrl, type PublicPageTarget } from "./publicPageUrl";

export class PublicPageService {
  constructor(private readonly connections: ConnectionStore, private readonly authoring: AuthoringContentClient) {}
  get configured(): boolean { return Boolean(vscode.workspace.getConfiguration("xmCloudSync").get<string>("publicPageUrlTemplate", "").trim()); }

  async resolve(connectionId: string, itemId: string, language: string, signal: AbortSignal, item?: AuthoringItemDetails, preferredSite?: string): Promise<PublicPageTarget | undefined> {
    const settings = vscode.workspace.getConfiguration("xmCloudSync");
    const template = settings.get<string>("publicPageUrlTemplate", "");
    if (!template.trim()) { return undefined; }
    const connection = this.connections.get(connectionId);
    const secret = await this.connections.getClientSecret(connectionId);
    if (!connection || !secret) { throw new Error("The connection or its client secret is unavailable."); }
    let sites = this.connections.listVerifiedSites(connectionId);
    if (!sites.length) { sites = (await this.authoring.testConnection(connection, secret, signal)).sites; }
    const raw = settings.get<Record<string, unknown>>("publicPageValues", {});
    const configuration = parsePublicPageConnectionValues(raw[connectionId]);
    const root = item ?? await this.authoring.loadItemDetails(connection, secret, itemId, language, signal);
    return resolvePublicPage(template, configuration, sites, root, language,
      path => this.authoring.loadItem(connection, secret, { path }, language, undefined, signal), signal, preferredSite);
  }

  async configure(): Promise<void> {
    const settings = vscode.workspace.getConfiguration("xmCloudSync");
    const template = await vscode.window.showInputBox({ title: "Shared public-page URL template (all connections)", value: settings.get<string>("publicPageUrlTemplate", ""), prompt: "Optional tokens: {publicBaseUrl}, {deploymentBaseUrl}, {language}, {country}, {route}. Empty disables public-page links." });
    if (template === undefined) { return; }
    if (!template.trim()) { await settings.update("publicPageUrlTemplate", "", vscode.ConfigurationTarget.Global); return; }
    const chosen = await vscode.window.showQuickPick(this.connections.list().map(connection => ({ label: connection.name, description: connection.serverUrl, connection })), { title: "Connection-specific public-page values" });
    if (!chosen) { return; }
    const connection = chosen.connection;
    const secret = await this.connections.getClientSecret(connection.id);
    if (!secret) { throw new Error("The connection's client secret is missing."); }
    const sites = this.connections.listVerifiedSites(connection.id);
    const available = sites.length ? sites : (await this.authoring.testConnection(connection, secret, AbortSignal.timeout(30_000))).sites;
    const site = await vscode.window.showQuickPick(available.map(value => ({ label: value.name, description: value.rootPath, value })), { title: "Site for these values" });
    if (!site) { return; }
    const all = settings.get<Record<string, unknown>>("publicPageValues", {});
    const previous = parsePublicPageConnectionValues(all[connection.id]);
    const values = { ...previous.sites?.[site.value.name] };
    for (const name of ["publicBaseUrl", "deploymentBaseUrl"] as const) {
      if (!template.includes(`{${name}}`)) { continue; }
      const value = await vscode.window.showInputBox({ title: `${connection.name} / ${site.value.name}: ${name}`, value: values[name], prompt: "HTTP(S) origin; deploymentBaseUrl is your configured Vercel deployment origin.", validateInput: value => {
        try { resolvePublicPageUrl(`{${name}}`, { [name]: value }, "en", "/"); return undefined; } catch (error) { return String(error); }
      } });
      if (value === undefined) { return; }
      values[name] = value;
    }
    if (template.includes("{language}") || template.includes("{country}")) {
      const mappings = await vscode.window.showInputBox({ title: "Language and country mappings (JSON)", value: JSON.stringify(values.languages ?? {}), prompt: 'Example: {"en-CA":{"language":"en","country":"ca"}}. No country is inferred.', validateInput: value => {
        try { const parsed: unknown = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? undefined : "Enter a JSON object."; } catch { return "Enter a valid JSON object."; }
      } });
      if (mappings === undefined) { return; }
      values.languages = parsePublicPageConnectionValues({ sites: { current: { languages: JSON.parse(mappings) as unknown } } }).sites?.current.languages;
    }
    const language = await vscode.window.showInputBox({ title: "Preview language", value: Object.keys(values.languages ?? {})[0] ?? "en" });
    if (language === undefined) { return; }
    const preview = resolvePublicPageUrl(template, values, language, "/example-page");
    const save = await vscode.window.showQuickPick([{ label: "Save configuration", description: preview }], { title: "Preview public-page URL (example route)", placeHolder: preview });
    if (!save) { return; }
    await settings.update("publicPageValues", { ...all, [connection.id]: { ...previous, defaultSite: previous.defaultSite ?? site.value.name, sites: { ...previous.sites, [site.value.name]: values } } }, vscode.ConfigurationTarget.Global);
    await settings.update("publicPageUrlTemplate", template, vscode.ConfigurationTarget.Global);
  }
}
