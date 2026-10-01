import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { ConnectionStore } from "./connectionStore";
import type { XmCloudConnection } from "./connection";
import type { AuthoringContentClient, AuthoringSite } from "../sitecore/authoringClient";
import type { DeploymentClient } from "../sitecore/deploymentClient";
import type { ExperienceEdgeClient } from "../sitecore/experienceEdgeClient";
import { publishingProfilesKey, readPublishingProfiles } from "../publishing/publishingRunState";
import { parsePublicPageConnectionValues } from "../publicPages/publicPageUrl";
import { parseConnectionSettings, SettingsValidationError, type ConnectionSettingsInput, type SecretEdit } from "./connectionSettingsValidation";

export class ConnectionSettingsPanel implements vscode.Disposable {
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  private saving = false;
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly globalState: vscode.Memento,
    private readonly store: ConnectionStore,
    private readonly authoring: AuthoringContentClient,
    private readonly deployment: DeploymentClient,
    private readonly edge: ExperienceEdgeClient,
    private readonly inUse: (id: string) => boolean,
  ) {}

  async choose(section = "connection", connectionId?: string): Promise<void> {
    const id = connectionId ?? (await vscode.window.showQuickPick(this.store.list().map(value => ({ label: value.name, description: value.serverUrl, id: value.id })), { title: "Connection Settings" }))?.id;
    if (id) { await this.open(id, section); }
  }

  async open(connectionId?: string, section = "connection", initialServerUrl = ""): Promise<void> {
    const key = connectionId ?? "new";
    const existing = this.panels.get(key);
    if (existing) { existing.reveal(); await existing.webview.postMessage({ type: "focus", section }); return; }
    const media = vscode.Uri.joinPath(this.extensionUri, "media", "connectionSettings");
    const panel = vscode.window.createWebviewPanel("xmCloudSync.connectionSettings", "Connection Settings", vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] });
    this.panels.set(key, panel);
    let id = connectionId;
    let disposed = false;
    let busy = false;
    let controller: AbortController | undefined;
    let baseline = "";
    let verifiedSites: readonly AuthoringSite[] | undefined;
    let verifiedIdentity = "";
    const settings = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration("xmCloudSync");
    const profiles = () => readPublishingProfiles(this.globalState.get(publishingProfilesKey, []));
    const revision = (): string => JSON.stringify([id ? this.store.get(id) : null, profiles(), settings().get("publicPageValues", {}), settings().get("publicPageUrlTemplate", "")]);
    const send = async (message: unknown): Promise<void> => {
      if (!disposed) {
        try { await panel.webview.postMessage(message); }
        catch { controller?.abort(); panel.dispose(); }
      }
    };
    const initialize = async (): Promise<void> => {
      const connection = id ? this.store.get(id) : undefined;
      if (id && !connection) { throw new Error("This connection no longer exists."); }
      const profile = profiles().find(value => value.connectionId === id);
      const values = parsePublicPageConnectionValues(settings().get<Record<string, unknown>>("publicPageValues", {})[id ?? ""]);
      const sites = id ? this.store.listVerifiedSites(id) : [];
      baseline = revision();
      panel.title = connection ? `Settings: ${connection.name}` : "Add Connection";
      await send({ type: "initialize", section, isNew: !id,
        values: { name: connection?.name ?? "", serverUrl: connection?.serverUrl ?? initialServerUrl, clientId: connection?.clientId ?? "",
          deploymentEnabled: Boolean(connection?.deploymentClientId), deploymentClientId: connection?.deploymentClientId ?? "", deploymentEnvironmentId: connection?.deploymentEnvironmentId ?? "",
          publishingEnabled: Boolean(profile), edgeEndpoint: profile?.edgeEndpoint ?? "https://edge.sitecorecloud.io/api/graphql/v1", siteName: profile?.siteName ?? "",
          applicationBaseUrl: profile?.applicationBaseUrl ?? "", publicTemplate: settings().get("publicPageUrlTemplate", ""), defaultSite: values.defaultSite ?? "",
          sites: [...new Set([...sites.map(site => site.name), ...Object.keys(values.sites ?? {})])].map(name => ({ name, publicBaseUrl: values.sites?.[name]?.publicBaseUrl ?? "", deploymentBaseUrl: values.sites?.[name]?.deploymentBaseUrl ?? "" })),
        }, stored: { clientSecret: Boolean(id && await this.store.getClientSecret(id)), deploymentSecret: Boolean(id && await this.store.getDeploymentClientSecret(id)), edgeToken: Boolean(id && await this.store.getEdgeToken(id)) },
      });
    };
    const effective = async (edit: SecretEdit, kind: "clientSecret" | "deploymentSecret" | "edgeToken"): Promise<string | undefined> => {
      if (edit.action === "replace") { return edit.value; }
      if (edit.action === "remove" || !id) { return undefined; }
      return kind === "clientSecret" ? this.store.getClientSecret(id) : kind === "deploymentSecret" ? this.store.getDeploymentClientSecret(id) : this.store.getEdgeToken(id);
    };
    const subscriptions: vscode.Disposable[] = [];
    subscriptions.push(panel.onDidDispose(() => { disposed = true; controller?.abort(); if (this.panels.get(id ?? key) === panel) { this.panels.delete(id ?? key); } if (this.panels.get(key) === panel) { this.panels.delete(key); } subscriptions.forEach(value => value.dispose()); }));
    subscriptions.push(panel.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!message || typeof message !== "object") { return; }
      const request = message as { type?: unknown; values?: unknown };
      if (request.type === "cancelOperation") { controller?.abort(); return; }
      if (busy || typeof request.type !== "string") { return; }
      if (request.type === "cancel") { panel.dispose(); return; }
      if (!["ready", "reload", "save", "connection", "deployment", "publishing"].includes(request.type)) { return; }
      const saving = request.type === "save";
      if (saving && this.saving) {
        await send({ type: "errors", errors: { form: "Another connection is being saved. Wait for it to finish, then retry." } });
        await send({ type: "idle" });
        return;
      }
      if (saving) { this.saving = true; }
      busy = true;
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 60_000);
      try {
        if (request.type === "ready" || request.type === "reload") { await initialize(); return; }
        const input = parseConnectionSettings(request.values, request.type);
        if (this.store.list().some(value => value.id !== id && value.name.toLowerCase() === input.name.toLowerCase())) { throw new SettingsValidationError({ name: "A connection with this name already exists." }); }
        const old = id ? this.store.get(id) : undefined;
        const connection: XmCloudConnection = { ...old, id: id ?? randomUUID(), createdAt: old?.createdAt ?? new Date().toISOString(), name: input.name, serverUrl: input.serverUrl, clientId: input.clientId,
          deploymentClientId: input.deploymentEnabled ? input.deploymentClientId : undefined,
          deploymentEnvironmentId: input.deploymentEnabled ? input.deploymentEnvironmentId || undefined : undefined };
        const authoringSecret = await effective(input.clientSecret, "clientSecret");
        const deploymentSecret = await effective(input.deploymentSecret, "deploymentSecret");
        const edgeToken = await effective(input.edgeToken, "edgeToken");
        const identity = JSON.stringify([input.serverUrl, input.clientId, authoringSecret]);
        const testConnection = async (): Promise<readonly AuthoringSite[]> => {
          if (!authoringSecret) { throw new SettingsValidationError({ clientSecret: "Enter a client secret to test the connection." }); }
          this.authoring.clear();
          const result = await this.authoring.testConnection(connection, authoringSecret, controller!.signal);
          verifiedSites = result.sites; verifiedIdentity = identity;
          await send({ type: "sites", sites: result.sites.map(site => site.name) });
          return result.sites;
        };
        const testDeployment = async (): Promise<string> => {
          if (!input.deploymentEnabled || !input.deploymentClientId || !deploymentSecret) { throw new SettingsValidationError({ deploymentSecret: "Enable monitoring and provide organization credentials." }); }
          this.deployment.clear();
          const result = await this.deployment.resolveEnvironment(connection, { clientId: input.deploymentClientId, clientSecret: deploymentSecret }, controller!.signal);
          return result.environmentId;
        };
        const testPublishing = async (): Promise<void> => {
          if (!input.publishingEnabled || !edgeToken) { throw new SettingsValidationError({ edgeToken: "Enable traced publishing and provide an Edge token." }); }
          const sites = verifiedIdentity === identity && verifiedSites ? verifiedSites : await testConnection();
          const edgeSites = await this.edge.listSites(input.edgeEndpoint, edgeToken, controller!.signal);
          const matches = sites.filter(site => edgeSites.some(edgeSite => edgeSite.name.toLowerCase() === site.name.toLowerCase() && (!edgeSite.rootPath || edgeSite.rootPath.toLowerCase() === site.rootPath.toLowerCase())));
          if (!sites.length || matches.length !== sites.length) { throw new SettingsValidationError({ edgeToken: "The token's accessible sites do not match this connection. Check its environment and scope." }); }
          if (input.siteName && !matches.some(site => site.name === input.siteName)) { throw new SettingsValidationError({ siteName: "Choose a site accessible to this connection and token." }); }
          await send({ type: "edgeSites", sites: edgeSites.map(site => site.name) });
        };
        if (request.type === "connection") { const sites = await testConnection(); await send({ type: "status", text: `Connected. Found ${sites.length} site(s). Nothing saved yet.` }); }
        else if (request.type === "deployment") { await send({ type: "environment", environmentId: await testDeployment() }); }
        else if (request.type === "publishing") { await testPublishing(); await send({ type: "status", text: "Edge token matches this connection. Nothing saved yet." }); }
        else {
          if (revision() !== baseline) { throw new SettingsValidationError({ form: "Settings changed elsewhere. Reload saved values before saving." }); }
          if (!id && !authoringSecret) { throw new SettingsValidationError({ clientSecret: "A client secret is required for a new connection." }); }
          const identityChanged = !old || old.serverUrl !== input.serverUrl || old.clientId !== input.clientId || input.clientSecret.action !== "keep";
          if (old && identityChanged && this.inUse(old.id)) { throw new SettingsValidationError({ form: "Close comparisons and finish or remove queued operations referencing this connection before changing its credentials or server." }); }
          if (old && (old.serverUrl !== input.serverUrl || old.clientId !== input.clientId) && input.clientSecret.action !== "replace") { throw new SettingsValidationError({ clientSecret: "Replace the secret when changing the server or client ID." }); }
          if (input.deploymentEnabled && (identityChanged || old?.deploymentClientId !== input.deploymentClientId || (old?.deploymentEnvironmentId ?? "") !== input.deploymentEnvironmentId || input.deploymentSecret.action !== "keep")) {
            const environmentId = await testDeployment();
            if (input.deploymentEnvironmentId && input.deploymentEnvironmentId !== environmentId) { throw new SettingsValidationError({ deploymentEnvironmentId: "This environment does not match the CM hostname. Use Test monitoring to resolve it." }); }
            Object.assign(connection, { deploymentEnvironmentId: environmentId });
          }
          const previousProfile = profiles().find(value => value.connectionId === id);
          if (input.publishingEnabled && (identityChanged || previousProfile?.edgeEndpoint !== input.edgeEndpoint || (previousProfile?.siteName ?? "") !== input.siteName || input.edgeToken.action !== "keep")) { await testPublishing(); }
          if (input.deploymentEnabled && !deploymentSecret) { throw new SettingsValidationError({ deploymentSecret: "A deployment secret is required when monitoring is enabled." }); }
          if (input.publishingEnabled && !edgeToken) { throw new SettingsValidationError({ edgeToken: "An Edge token is required when traced publishing is enabled." }); }
          controller.signal.throwIfAborted();
          if (revision() !== baseline || disposed) { throw new SettingsValidationError({ form: "Settings changed while validating. Reload saved values." }); }
          await this.save(input, connection, previousProfile);
          if (!id) { this.panels.delete(key); id = connection.id; this.panels.set(id, panel); }
          this.authoring.clear(); this.deployment.clear(); this.edge.clear();
          // Catalog is derived data; failure must not imply that the settings save failed.
          if (verifiedSites && verifiedIdentity === identity) { try { await this.store.storeVerifiedSites(connection.id, verifiedSites); } catch { /* The next test can rediscover sites. */ } }
          await initialize();
          await send({ type: "status", text: "Connection settings saved." });
        }
      } catch (error: unknown) {
        await send({ type: "errors", errors: error instanceof SettingsValidationError ? error.errors : { form: controller.signal.aborted ? "Operation cancelled or timed out. Changes were not saved." : "Operation failed. Check the connection, credentials and settings, then retry. If saving failed, reload saved values to review the current state." } });
      } finally { clearTimeout(timeout); busy = false; if (saving) { this.saving = false; } await send({ type: "idle" }); }
    }));
    try {
      const nonce = randomUUID().replaceAll("-", "");
      panel.webview.html = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(media, "settings.html"))).toString("utf8")
        .replaceAll("{{cspSource}}", panel.webview.cspSource).replaceAll("{{nonce}}", nonce)
        .replaceAll("{{scriptUri}}", panel.webview.asWebviewUri(vscode.Uri.joinPath(media, "settings.js")).toString())
        .replaceAll("{{styleUri}}", panel.webview.asWebviewUri(vscode.Uri.joinPath(media, "settings.css")).toString());
    } catch { panel.dispose(); await vscode.window.showErrorMessage("Unable to open Connection Settings."); }
  }

  private async save(input: ConnectionSettingsInput, connection: XmCloudConnection, previousProfile: ReturnType<typeof readPublishingProfiles>[number] | undefined): Promise<void> {
    const settings = vscode.workspace.getConfiguration("xmCloudSync");
    const all = settings.get<Record<string, unknown>>("publicPageValues", {});
    const previous = parsePublicPageConnectionValues(all[connection.id]);
    const sites = Object.fromEntries(input.sites.map(site => [site.name, { ...previous.sites?.[site.name], publicBaseUrl: site.publicBaseUrl || undefined, deploymentBaseUrl: site.deploymentBaseUrl || undefined }]));
    const oldTemplate = settings.inspect<string>("publicPageUrlTemplate")?.globalValue;
    const oldValues = settings.inspect<Record<string, unknown>>("publicPageValues")?.globalValue;
    const remove: SecretEdit = { action: "remove", value: "" };
    await this.store.saveSettings(connection, { clientSecret: input.clientSecret, deploymentSecret: input.deploymentEnabled ? input.deploymentSecret : remove, edgeToken: input.publishingEnabled ? input.edgeToken : remove },
      input.publishingEnabled ? { ...previousProfile, connectionId: connection.id, edgeEndpoint: input.edgeEndpoint, siteName: input.siteName || undefined, applicationBaseUrl: input.applicationBaseUrl || undefined } : undefined,
      async () => {
        try {
          await settings.update("publicPageUrlTemplate", input.publicTemplate, vscode.ConfigurationTarget.Global);
          await settings.update("publicPageValues", { ...all, [connection.id]: { ...previous, defaultSite: input.defaultSite || undefined, sites } }, vscode.ConfigurationTarget.Global);
        } catch {
          await Promise.allSettled([settings.update("publicPageUrlTemplate", oldTemplate, vscode.ConfigurationTarget.Global), settings.update("publicPageValues", oldValues, vscode.ConfigurationTarget.Global)]);
          throw new Error("Public URL settings could not be saved.");
        }
      });
  }
  dispose(): void { for (const panel of [...this.panels.values()]) { panel.dispose(); } this.panels.clear(); }
}
