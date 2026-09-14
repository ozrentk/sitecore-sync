import * as vscode from "vscode";
import type { ConnectionStore } from "../connections/connectionStore";
import type { AuthoringContentClient, AuthoringItemDetails } from "../sitecore/authoringClient";
import { parsePublicPageConnectionValues, resolvePublicPage, resolvePublicPageUrl, resolveHomepageUrl, validatePublicPageTemplate, type PublicPageTarget } from "./publicPageUrl";

import { configureSharedTemplate } from "./sharedTemplateSetup";

export interface PublicPagePreviewContext {
  readonly connectionId?: string;
  readonly language: string;
  readonly itemPath?: string;
}

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

  async configure(context?: PublicPagePreviewContext): Promise<void> {
    const settings = vscode.workspace.getConfiguration("xmCloudSync");
    await configureSharedTemplate({
      askTemplate: async () => vscode.window.showInputBox({
        title: "Shared public-page URL template (all connections and sites)",
        value: settings.get<string>("publicPageUrlTemplate", ""),
        prompt: "Tokens: {publicBaseUrl}, {deploymentBaseUrl}, {language}, {country}, {route}. Language and region are inferred, e.g. en-US → en / US. Empty disables links.",
        validateInput: validatePublicPageTemplate,
      }),
      saveTemplate: async template => settings.update("publicPageUrlTemplate", template, vscode.ConfigurationTarget.Global),
      offerHomepage: async () => await vscode.window.showInformationMessage("Template saved for all connections and sites. Open the homepage using the current comparison?", "Open homepage") === "Open homepage",
      openHomepage: async template => {
        try {
          const connectionId = context?.connectionId;
          const all = settings.get<Record<string, unknown>>("publicPageValues", {});
          const configuration = parsePublicPageConnectionValues(connectionId ? all[connectionId] : undefined);
          let sites = connectionId ? this.connections.listVerifiedSites(connectionId) : [];
          if (!sites.length && connectionId && /\{(?:publicBaseUrl|deploymentBaseUrl)\}/u.test(template)) {
            const connection = this.connections.get(connectionId);
            const secret = await this.connections.getClientSecret(connectionId);
            if (connection && secret) {
              sites = (await this.authoring.testConnection(connection, secret, AbortSignal.timeout(30_000))).sites;
            }
          }
          const url = resolveHomepageUrl(template, configuration, sites, context?.language ?? "en", context?.itemPath);
          await vscode.env.openExternal(vscode.Uri.parse(url));
        } catch (error: unknown) {
          await vscode.window.showInformationMessage(`Template saved; homepage preview is unavailable: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    });
  }

  async configureValues(connectionId?: string): Promise<void> {
    const settings = vscode.workspace.getConfiguration("xmCloudSync");
    const template = settings.get<string>("publicPageUrlTemplate", "");
    if (!/\{(?:publicBaseUrl|deploymentBaseUrl)\}/u.test(template)) {
      await vscode.window.showInformationMessage("The shared template does not use a base URL placeholder, so no connection/site URL values are needed.");
      return;
    }
    let connection = connectionId ? this.connections.get(connectionId) : undefined;
    if (connectionId && !connection) { throw new Error("The selected connection is no longer available."); }
    if (!connection) {
      const chosen = await vscode.window.showQuickPick(this.connections.list().map(value => ({ label: value.name, description: value.serverUrl, connection: value })), { title: "Connection-specific public-page values" });
      if (!chosen) { return; }
      connection = chosen.connection;
    }
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
    await settings.update("publicPageValues", { ...all, [connection.id]: { ...previous, defaultSite: previous.defaultSite ?? site.value.name, sites: { ...previous.sites, [site.value.name]: values } } }, vscode.ConfigurationTarget.Global);
    await vscode.window.showInformationMessage("Connection/site URL values saved. The shared template is unchanged.");
  }
}
