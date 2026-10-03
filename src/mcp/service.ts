import { randomUUID } from "node:crypto";
import * as z from "zod";
import type { ConnectionStore } from "../connections/connectionStore";
import type { XmCloudConnection } from "../connections/connection";
import type { AuthoringContentClient, AuthoringItemDetails, AuthoringItemField } from "../sitecore/authoringClient";
import { createFallbackFixtures, fixtureGuid, planFallbackFixtures, type FallbackFixture } from "../sitecore/fallbackFixtures";
import { serializeFallbackDiagnostic } from "../sitecore/fallbackDiagnostics";
import { fieldStateFingerprint } from "../transfers/transferTypes";
import { isMcpToolName, McpAccessError, toolSchemas } from "./tools";

type Connections = Pick<ConnectionStore, "get" | "listVerifiedSites" | "getClientSecret">;
type Client = Pick<AuthoringContentClient, "loadItem" | "loadLanguages" | "searchItemsByName" | "collectFallbackDiagnostic" | "createItem" | "updateItemFields">;
const operationSchema = z.object({ id: z.string().uuid(), connectionId: z.string(), serverUrl: z.string(),
  kind: z.enum(["create-fixtures", "update-field"]), startedAt: z.string(),
  status: z.enum(["prepared", "outcome-unknown", "completed", "stopped"]),
  targets: z.array(z.object({ path: z.string(), itemId: z.string().optional(), language: z.string(),
    status: z.enum(["planned", "outcome-unknown", "created", "updated"]), fieldId: z.string().optional() }).strict()).max(4),
}).strict();
export type McpOperation = z.infer<typeof operationSchema>;
export interface McpServiceHost {
  confirm(preview: unknown, signal: AbortSignal): Promise<boolean>;
  loadJournal(): unknown;
  saveJournal(records: readonly McpOperation[]): Promise<void>;
}
interface Plan {
  readonly id: string;
  readonly connectionId: string;
  readonly expiresAt: number;
  readonly preview: unknown;
  readonly mutation: { kind: "create-fixtures"; fixtures: FallbackFixture[] }
    | { kind: "update-field"; itemId: string; path: string; language: string; version: number; fieldId: string; value: string; fingerprint: string };
}
const normalized = (value: string): string => value.replace(/[{}-]/gu, "").toLowerCase();
const locate = (value: string): { path: string } | { itemId: string } => value.startsWith("/") ? { path: value } : { itemId: fixtureGuid(value) };

export class McpService {
  private readonly plans = new Map<string, Plan>();
  private readonly mutationConnections = new Set<string>();
  private readonly lifetime = new AbortController();
  private executing = false;
  constructor(private readonly connections: Connections, private readonly client: Client,
    private readonly allowed: readonly XmCloudConnection[], private readonly host: McpServiceHost) {}

  dispose(): void { this.lifetime.abort(); this.plans.clear(); this.mutationConnections.clear(); }
  enableMutations(connectionId: string): void { this.connection(connectionId); this.mutationConnections.add(connectionId); }

  async call(name: string, input: unknown, requestSignal: AbortSignal): Promise<unknown> {
    const signal = AbortSignal.any([requestSignal, this.lifetime.signal]); signal.throwIfAborted();
    if (!isMcpToolName(name)) { throw new McpAccessError("Unknown MCP tool."); }
    const parsed = toolSchemas[name].safeParse(input);
    if (!parsed.success) { throw new McpAccessError("Invalid MCP tool arguments."); }
    if (name === "list_connections") {
      return this.allowed.flatMap(saved => {
        const current = this.connections.get(saved.id);
        return current?.serverUrl === saved.serverUrl && current.clientId === saved.clientId
          ? [{ id: saved.id, name: current.name, serverUrl: saved.serverUrl, mutationsEnabled: this.mutationConnections.has(saved.id) }] : [];
      });
    }
    if (name === "list_operations") {
      return this.journal().filter(record => this.allowed.some(connection => connection.id === record.connectionId && connection.serverUrl === record.serverUrl));
    }
    if (name === "execute_plan") { return this.execute(toolSchemas.execute_plan.parse(input).planId, signal); }
    const args = parsed.data;
    if (!("connectionId" in args)) { throw new McpAccessError("Missing connection."); }
    const connection = this.connection(args.connectionId);
    if (name === "list_sites") { return { source: "saved discovery", sites: this.connections.listVerifiedSites(connection.id) }; }
    const secret = await this.secret(connection.id);
    let result: unknown;
    switch (name) {
      case "list_languages": result = await this.client.loadLanguages(connection, secret, signal); break;
      case "search_items": {
        const value = toolSchemas.search_items.parse(input);
        result = await this.client.searchItemsByName(connection, secret, value.text, value.language, value.page, signal); break;
      }
      case "read_item": {
        const value = toolSchemas.read_item.parse(input);
        result = await this.client.loadItem(connection, secret, locate(value.item), value.language, undefined, signal); break;
      }
      case "collect_fallback_diagnostic": {
        const value = toolSchemas.collect_fallback_diagnostic.parse(input);
        // Resolve paths with exact reads; all diagnostic probes retain the original requested locale.
        const item = value.item.startsWith("/")
          ? await this.client.loadItem(connection, secret, locate(value.item), value.languages[0]!, undefined, signal) : undefined;
        result = JSON.parse(await this.client.collectFallbackDiagnostic(connection, secret,
          { itemId: fixtureGuid(item?.itemId ?? value.item), languages: value.languages }, signal)) as unknown; break;
      }
      case "preview_fallback_test_items": {
        const value = toolSchemas.preview_fallback_test_items.parse(input);
        const [parent, example] = await Promise.all([
          this.client.loadItem(connection, secret, locate(value.parent), value.languages.at(-1)!, undefined, signal),
          this.client.loadItem(connection, secret, locate(value.example), value.languages.at(-1)!, undefined, signal),
        ]);
        const field = this.editableField(example, value.fieldId);
        const fixtures = planFallbackFixtures(parent.itemId, parent.path, example.template.templateId, field.name,
          value.languages, randomUUID().replace(/-/gu, "").slice(0, 12));
        result = this.addPlan(connection.id, { kind: "create-fixtures", fixtures },
          { connection: connection.name, serverUrl: connection.serverUrl, parent: parent.path, template: example.template,
            field: field.name, languages: value.languages, fixtures,
            notice: "Creates four new children, preserving template defaults. No publishing. Controls do not cover mixed versions or reset semantics." }); break;
      }
      case "preview_field_update": {
        const value = toolSchemas.preview_field_update.parse(input);
        const item = await this.client.loadItem(connection, secret, locate(value.item), value.language, undefined, signal);
        const field = this.editableField(item, value.fieldId);
        if (item.version !== value.version) { throw new McpAccessError("Requested version is not the latest existing version. Read the item again."); }
        result = this.addPlan(connection.id, { kind: "update-field", itemId: item.itemId, path: item.path,
          language: value.language, version: value.version, fieldId: field.fieldId, value: value.value,
          fingerprint: fieldStateFingerprint(item, field) },
        { connection: connection.name, serverUrl: connection.serverUrl, path: item.path, language: value.language,
          version: value.version, field: field.name, previousValue: field.value, newValue: value.value,
          notice: "Writes a literal local value (including empty); it does not reset to Standard Values or create a version." }); break;
      }
    }
    signal.throwIfAborted(); this.connection(connection.id);
    return JSON.parse(serializeFallbackDiagnostic(result, [secret])) as unknown;
  }

  private connection(id: string): XmCloudConnection {
    this.lifetime.signal.throwIfAborted();
    const allowed = this.allowed.find(connection => connection.id === id);
    const current = this.connections.get(id);
    if (!allowed || !current || current.serverUrl !== allowed.serverUrl || current.clientId !== allowed.clientId) {
      throw new McpAccessError("Connection is not exposed or has changed. Restart MCP access in VS Code.");
    }
    return current;
  }
  private async secret(id: string): Promise<string> {
    const secret = await this.connections.getClientSecret(id);
    if (!secret) { throw new McpAccessError("Connection has no stored client secret."); }
    return secret;
  }
  private editableField(item: AuthoringItemDetails, id: string): AuthoringItemField {
    const field = item.fields.find(candidate => normalized(candidate.fieldId) === normalized(id));
    if (!/^\/sitecore\/content\//iu.test(item.path) || item.version < 1 || !field || field.name.startsWith("__")
      || field.isStandardTemplate || field.scope !== "VERSIONED" || field.containsFallbackValue
      || item.fields.filter(candidate => candidate.name.toLowerCase() === field.name.toLowerCase()).length !== 1
      || !["single-line text", "multi-line text", "rich text"].includes(field.type.toLowerCase())) {
      throw new McpAccessError("Choose an existing local version and a versioned content text field. System, shared and fallback-derived fields cannot be changed.");
    }
    return field;
  }
  private addPlan(connectionId: string, mutation: Plan["mutation"], preview: unknown): unknown {
    for (const [id, plan] of this.plans) { if (plan.expiresAt < Date.now()) { this.plans.delete(id); } }
    if (this.plans.size >= 20) { throw new McpAccessError("Too many pending plans. Execute a plan or wait for expiry."); }
    const plan: Plan = { id: randomUUID(), connectionId, expiresAt: Date.now() + 10 * 60_000, preview, mutation };
    this.plans.set(plan.id, plan);
    return { planId: plan.id, expiresAt: new Date(plan.expiresAt).toISOString(), preview };
  }
  private journal(): McpOperation[] {
    const parsed = z.array(operationSchema).max(100).safeParse(this.host.loadJournal());
    if (!parsed.success) { throw new McpAccessError("MCP operation journal is invalid; no mutations will run."); }
    return parsed.data;
  }
  private async execute(id: string, signal: AbortSignal): Promise<unknown> {
    const plan = this.plans.get(id);
    if (!plan || plan.expiresAt < Date.now()) { throw new McpAccessError("Plan is missing, expired or already used. Inspect operations before preparing another mutation."); }
    const connection = this.connection(plan.connectionId);
    if (!this.mutationConnections.has(connection.id)) { throw new McpAccessError("Enable MCP Mutations for this connection in VS Code first."); }
    if (this.executing) { throw new McpAccessError("Another MCP mutation is awaiting confirmation or running."); }
    this.executing = true;
    try {
      const confirmed = await this.host.confirm(plan.preview, signal);
      signal.throwIfAborted(); this.connection(connection.id);
      if (!confirmed) { throw new McpAccessError("Mutation cancelled in VS Code."); }
      if (plan.expiresAt < Date.now()) { throw new McpAccessError("Plan expired during confirmation. Prepare a new preview."); }
      this.plans.delete(id);
      const records = this.journal();
      if (records.length >= 100) { throw new McpAccessError("MCP journal reached 100 records. Preserve and review it before starting a new workspace session."); }
      const secret = await this.secret(connection.id);
      const mutation = plan.mutation;
      const record: McpOperation = { id, connectionId: connection.id, serverUrl: connection.serverUrl,
        kind: mutation.kind, startedAt: new Date().toISOString(), status: "prepared",
        targets: mutation.kind === "create-fixtures" ? mutation.fixtures.map(fixture => ({ path: fixture.expectedPath,
          language: fixture.input.language, status: "planned" })) : [{ path: mutation.path, itemId: mutation.itemId,
          language: mutation.language, fieldId: mutation.fieldId, status: "planned" }] };
      records.push(record);
      const checkpoint = (): Promise<void> => this.host.saveJournal(records);
      await checkpoint();
      try {
        if (mutation.kind === "create-fixtures") {
          await createFallbackFixtures(mutation.fixtures, input => {
            this.connection(connection.id); signal.throwIfAborted();
            return this.client.createItem(connection, secret, input, signal);
          }, async () => {
            record.status = "outcome-unknown";
            record.targets = mutation.fixtures.map(fixture => ({ path: fixture.expectedPath, language: fixture.input.language,
              status: fixture.status, itemId: fixture.itemId }));
            await checkpoint();
          }, signal);
        } else {
          const current = await this.client.loadItem(connection, secret, { itemId: mutation.itemId }, mutation.language, undefined, signal);
          const field = this.editableField(current, mutation.fieldId);
          if (fieldStateFingerprint(current, field) !== mutation.fingerprint || current.path !== mutation.path) {
            throw new McpAccessError("Item changed after preview. No update was sent; prepare a fresh preview.");
          }
          record.status = "outcome-unknown"; record.targets[0]!.status = "outcome-unknown"; await checkpoint();
          signal.throwIfAborted(); this.connection(connection.id);
          const result = await this.client.updateItemFields(connection, secret, { itemId: mutation.itemId,
            language: mutation.language, version: mutation.version, fields: { [field.name]: mutation.value } }, signal);
          const updated = this.editableField(result, mutation.fieldId);
          if (normalized(result.itemId) !== normalized(mutation.itemId) || result.language.toLowerCase() !== mutation.language.toLowerCase()
            || result.version !== mutation.version || updated.value !== mutation.value) { throw new Error("Write verification failed"); }
          record.targets[0]!.status = "updated";
        }
        record.status = "completed"; await checkpoint();
        return record;
      } catch (error) {
        record.status = record.targets.some(target => target.status === "outcome-unknown") ? "outcome-unknown" : "stopped";
        await checkpoint();
        if (error instanceof McpAccessError) { throw error; }
        throw new McpAccessError(`Operation ${id} stopped. Inspect list_operations and recorded paths before retrying; a remote write may have completed.`);
      }
    } finally { this.executing = false; }
  }
}
