import { deepStrictEqual, strictEqual, rejects } from "node:assert/strict";
import { mock } from "node:test";
import * as vscode from "vscode";
import { ConnectionStore } from "../../src/connections/connectionStore";
import { ConnectionSettingsPanel } from "../../src/connections/connectionSettingsPanel";
import { PublishingManager } from "../../src/publishing/publishingManager";
import { publishingProfilesKey } from "../../src/publishing/publishingRunState";
import type { ConnectionSettingsInput } from "../../src/connections/connectionSettingsValidation";
import type { AuthoringContentClient } from "../../src/sitecore/authoringClient";
import type { DeploymentClient } from "../../src/sitecore/deploymentClient";
import type { ExperienceEdgeClient } from "../../src/sitecore/experienceEdgeClient";
import { MemoryMemento, MemorySecretStorage, type IntegrationTest } from "./testSupport";

const keep = { action: "keep" as const, value: "" };
const remove = { action: "remove" as const, value: "" };
export const connectionSettingsTests: readonly IntegrationTest[] = [
  {
    name: "publishing without saved defaults opens the connection dashboard instead of text prompts",
    async execute() {
      const manager = Object.create(PublishingManager.prototype) as {
        ensurePublishingProfile(id: string, signal: AbortSignal): Promise<unknown>;
      };
      Object.assign(manager, { globalState: new MemoryMemento(), connections: { getEdgeToken: async () => undefined } });
      const calls: unknown[][] = [];
      const command = mock.method(vscode.commands, "executeCommand", async (...args: unknown[]) => { calls.push(args); });
      const prompt = mock.method(vscode.window, "showInputBox", async () => undefined);
      try {
        strictEqual(await manager.ensurePublishingProfile("connection", new AbortController().signal), undefined);
        deepStrictEqual(calls, [["xmCloudSync.configurePublishing", "connection"]]);
        strictEqual(prompt.mock.callCount(), 0);
        await rejects(manager.ensurePublishingProfile("connection", AbortSignal.abort()));
        strictEqual(calls.length, 1);
      } finally { command.mock.restore(); prompt.mock.restore(); }
    },
  },
  {
    name: "connection settings preserve identity, secrets and favorites and roll back failed saves",
    async execute() {
      const state = new MemoryMemento(); const secrets = new MemorySecretStorage(); const store = new ConnectionStore(state, secrets);
      try {
        const original = await store.add({ name: "Original", serverUrl: "https://cm.example.test", clientId: "client", clientSecret: "original-test-secret" });
        await store.addFavoritePath(original.id, "/sitecore/content/Example");
        await store.storeVerifiedSites(original.id, [{ name: "site", rootPath: "/sitecore/content/Example" }]);
        await store.saveSettings({ ...original, name: "Renamed" }, { clientSecret: keep, deploymentSecret: keep, edgeToken: keep }, undefined, async () => undefined);
        strictEqual(store.get(original.id)?.name, "Renamed");
        strictEqual(await store.getClientSecret(original.id), "original-test-secret");
        strictEqual(store.listFavoritePaths(original.id).length, 1);
        await rejects(store.saveSettings({ ...original, serverUrl: "https://new.example.test" }, {
          clientSecret: { action: "replace", value: "replacement-test-secret" }, deploymentSecret: keep, edgeToken: { action: "replace", value: "edge-test-secret" },
        }, { connectionId: original.id, edgeEndpoint: "https://edge.example.test/graphql" }, async () => { throw new Error("settings file failure"); }), /Previous connection settings were restored/);
        strictEqual(store.get(original.id)?.name, "Renamed");
        strictEqual(await store.getClientSecret(original.id), "original-test-secret");
        strictEqual(await store.getEdgeToken(original.id), undefined);
        strictEqual(store.listVerifiedSites(original.id).length, 1);
        await store.saveSettings({ ...original, serverUrl: "https://new.example.test" }, { clientSecret: remove, deploymentSecret: remove, edgeToken: remove }, undefined, async () => undefined);
        strictEqual(await store.getClientSecret(original.id), undefined);
        strictEqual(store.listVerifiedSites(original.id).length, 0);
        strictEqual(new ConnectionStore(state, secrets).get(original.id)?.id, original.id);
        strictEqual(JSON.stringify(state.get(publishingProfilesKey)).includes("secret"), false);
      } finally { store.dispose(); secrets.dispose(); }
    },
  },
  {
    name: "dashboard initializes without secrets, tests unsaved values, rejects stale saves and cancels",
    async execute() {
      const state = new MemoryMemento(); const secrets = new MemorySecretStorage(); const store = new ConnectionStore(state, secrets);
      const connection = await store.add({ name: "Original", serverUrl: "https://cm.example.test", clientId: "client", clientSecret: "stored-test-secret" });
      const incoming = new vscode.EventEmitter<unknown>(); const closed = new vscode.EventEmitter<void>();
      const messages: Record<string, unknown>[] = [];
      const panel = { title: "", reveal() {}, dispose() { closed.fire(); }, onDidDispose: closed.event,
        webview: { html: "", cspSource: "test-csp", asWebviewUri: (uri: vscode.Uri) => uri,
          onDidReceiveMessage: incoming.event, postMessage: async (message: Record<string, unknown>) => { messages.push(message); return true; } } };
      const create = mock.method(vscode.window, "createWebviewPanel", () => panel);
      const configured: Record<string, unknown> = { publicPageUrlTemplate: "{publicBaseUrl}{route}", publicPageValues: { [connection.id]: { sites: { site: { publicBaseUrl: "https://public.example.test", languages: { en: { country: "US" } } } } } } };
      const config = mock.method(vscode.workspace, "getConfiguration", () => ({ get: (key: string, fallback: unknown) => configured[key] ?? fallback, inspect: (key: string) => ({ globalValue: configured[key] }), update: async (key: string, value: unknown) => { configured[key] = value; } }));
      const results: { kind: string; message: string; options: vscode.MessageOptions }[] = [];
      const success = mock.method(vscode.window, "showInformationMessage", async (message: string, options: vscode.MessageOptions) => { results.push({ kind: "success", message, options }); });
      const failure = mock.method(vscode.window, "showErrorMessage", async (message: string, options: vscode.MessageOptions) => { results.push({ kind: "failure", message, options }); });
      const cancellation = mock.method(vscode.window, "showWarningMessage", async (message: string, options: vscode.MessageOptions) => { results.push({ kind: "cancel", message, options }); });
      const tested: string[] = [];
      let failConnection = false;
      let waitForCancel = false;
      const authoring = { clear() {}, testConnection: async (_connection: unknown, secret: string, signal: AbortSignal) => {
        tested.push(secret);
        if (failConnection) { throw new Error("sensitive-response-fixture"); }
        if (waitForCancel) { await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })); }
        return { sites: [{ name: "site", rootPath: "/sitecore/content/Example" }] };
      } } as unknown as AuthoringContentClient;
      const deployment = { clear() {}, resolveEnvironment: async () => ({ environmentId: "matched-environment" }) } as unknown as DeploymentClient;
      const edge = { clear() {}, listSites: async () => [{ name: "wrong-site" }] } as unknown as ExperienceEdgeClient;
      const dashboard = new ConnectionSettingsPanel(vscode.extensions.getExtension("OzrenTK.sitecore-xm-cloud-sync")!.extensionUri, state, store, authoring, deployment, edge, () => false);
      const send = async (message: unknown): Promise<void> => {
        const start = messages.filter(value => value.type === "idle").length;
        incoming.fire(message);
        for (let count = 0; count < 200; count += 1) {
          if (messages.filter(value => value.type === "idle").length > start) return;
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        throw new Error("Dashboard did not finish processing message");
      };
      try {
        await dashboard.open(connection.id); await send({ type: "ready" });
        strictEqual(JSON.stringify(messages).includes("stored-test-secret"), false);
        const initial = messages.find(value => value.type === "initialize")!;
        const values = { ...(initial.values as ConnectionSettingsInput), clientSecret: keep, deploymentSecret: keep, edgeToken: keep };
        await send({ type: "connection", values: { ...values, clientSecret: { action: "replace", value: "unsaved-test-secret" } } });
        deepStrictEqual(tested, ["unsaved-test-secret"]);
        strictEqual(results.at(-1)?.kind, "success");
        strictEqual(results.at(-1)?.options.modal, true);
        failConnection = true;
        await send({ type: "connection", values });
        strictEqual(results.at(-1)?.kind, "failure");
        strictEqual(results.at(-1)?.options.modal, true);
        strictEqual(JSON.stringify(results).includes("sensitive-response-fixture"), false);
        failConnection = false;
        strictEqual(await store.getClientSecret(connection.id), "stored-test-secret");
        await send({ type: "deployment", values: { ...values, deploymentEnabled: true, deploymentClientId: "organization-client", deploymentSecret: { action: "replace", value: "test-organization-secret" } } });
        strictEqual(messages.some(value => value.type === "environment" && value.environmentId === "matched-environment"), true);
        strictEqual(await store.getDeploymentClientSecret(connection.id), undefined);
        await send({ type: "save", values: { ...values, publishingEnabled: true, edgeToken: { action: "replace", value: "wrong-scope-test-token" } } });
        strictEqual(store.get(connection.id)?.name, "Original");
        strictEqual(await store.getEdgeToken(connection.id), undefined);
        strictEqual(JSON.stringify(messages.filter(value => value.type === "errors").at(-1)).includes("scope"), true);
        waitForCancel = true;
        const cancelled = send({ type: "connection", values });
        await new Promise(resolve => setTimeout(resolve, 10));
        incoming.fire({ type: "cancelOperation" });
        await cancelled;
        waitForCancel = false;
        strictEqual(results.at(-1)?.kind, "cancel");
        strictEqual(results.at(-1)?.options.modal, true);
        const resultCount = results.length;
        strictEqual(await store.getClientSecret(connection.id), "stored-test-secret");
        await send({ type: "save", values: { ...values, name: "Renamed" } });
        strictEqual(store.get(connection.id)?.name, "Renamed");
        strictEqual(JSON.stringify(configured).includes('"country":"US"'), true);
        configured.publicPageUrlTemplate = "https://changed.example.test{route}";
        await send({ type: "save", values: { ...values, name: "Stale" } });
        strictEqual(store.get(connection.id)?.name, "Renamed");
        const lastErrors = messages.filter(value => value.type === "errors").at(-1);
        strictEqual(JSON.stringify(lastErrors).includes("changed elsewhere"), true);
        await state.update(publishingProfilesKey, [{ connectionId: connection.id, edgeEndpoint: values.edgeEndpoint }]);
        await store.storeEdgeToken(connection.id, "existing-test-edge-token");
        await send({ type: "reload" });
        // No site is a valid existing default; an unrelated edit must not revalidate it.
        const before = tested.length;
        await send({ type: "save", values: { ...values, name: "Renamed", publishingEnabled: true } });
        strictEqual(tested.length, before);
        strictEqual(await store.getEdgeToken(connection.id), "existing-test-edge-token");
        strictEqual(results.length, resultCount);
        incoming.fire({ type: "cancel" });
        strictEqual(store.get(connection.id)?.name, "Renamed");
        await dashboard.open(); await send({ type: "ready" });
        await send({ type: "save", values: { ...values, name: "New connection", clientSecret: { action: "replace", value: "new-test-secret" } } });
        const created = store.list().find(value => value.name === "New connection")!;
        strictEqual(store.list().length, 2);
        strictEqual(await store.getClientSecret(created.id), "new-test-secret");
        strictEqual(JSON.stringify(messages).includes("new-test-secret"), false);
      } finally { dashboard.dispose(); success.mock.restore(); failure.mock.restore(); cancellation.mock.restore(); create.mock.restore(); config.mock.restore(); incoming.dispose(); closed.dispose(); store.dispose(); secrets.dispose(); }
    },
  },
];
