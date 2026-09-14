import { randomUUID } from "node:crypto";
import type { ConnectionStore } from "../connections/connectionStore";
import type { PublishingManager } from "../publishing/publishingManager";
import type {
  AuthoringContentClient,
  AuthoringItemField,
} from "../sitecore/authoringClient";
import type { TransferQueueStore } from "../transfers/transferQueueStore";
import {
  fieldStateFingerprint,
  normalizeTransferId,
  type OperationRecord,
} from "../transfers/transferTypes";
import {
  type OperationIntent,
  type PublishingIntent,
  type SequenceOperationContext,
} from "./operationTypes";

export class OperationIntentService {
  constructor(
    private readonly connections: ConnectionStore,
    private readonly authoring: AuthoringContentClient,
    private readonly operations: TransferQueueStore,
    private readonly publishing: PublishingManager,
  ) {}

  intentForRecord(record: OperationRecord): OperationIntent | undefined {
    if (record.intent) {
      return record.intent;
    }
    if (record.kind === "fieldValue") {
      return {
        kind: "fieldValue",
        source: persistentFieldEndpoint(record.source),
        destination: persistentFieldEndpoint(record.target),
      };
    }
    if (record.kind === "subtree") {
      return {
        kind: "subtree",
        source: {
          connectionId: record.sourceConnectionId,
          rootItemId: record.sourceItemId,
          rootPath: record.sourcePath,
        },
        destination: { connectionId: record.targetConnectionId },
        mode: record.mode ?? "synchronize",
      };
    }
    return this.publishing.intentForRun(record.publishRunId);
  }

  async validate(intent: OperationIntent): Promise<string | undefined> {
    const connectionIds = intent.kind === "publishing"
      ? [intent.connectionId]
      : [intent.source.connectionId, intent.destination.connectionId];
    for (const connectionId of connectionIds) {
      const connection = this.connections.get(connectionId);
      if (!connection) {
        return `Connection ${connectionId} no longer exists.`;
      }
      if (!await this.connections.getClientSecret(connectionId)) {
        return `Credentials for ${connection.name} are unavailable.`;
      }
    }
    if (
      intent.kind === "publishing" &&
      intent.publishKind !== "standard" &&
      !await this.connections.getEdgeToken(intent.connectionId)
    ) {
      return "The Experience Edge token required by this publishing operation is unavailable.";
    }
    if (
      intent.kind === "publishing" &&
      intent.publishKind !== "standard" &&
      !this.publishing.hasSavedProfile(intent.connectionId)
    ) {
      return "The Experience Edge profile required by this publishing operation is unavailable.";
    }
    if (intent.kind === "publishing" && intent.publishKind !== "standard") {
      if (!intent.siteName || !intent.route) {
        return "The diagnostic publishing operation has no saved Sitecore site or route.";
      }
    }
    return undefined;
  }

  async enqueue(
    intent: OperationIntent,
    context?: SequenceOperationContext,
  ): Promise<OperationRecord> {
    if (intent.kind === "publishing") {
      return this.publishing.enqueueIntent(intent, context);
    }
    if (intent.kind === "fieldValue") {
      return this.enqueueFieldTransfer(intent, context);
    }
    return this.enqueueSubtreeTransfer(intent, context);
  }

  async replay(record: OperationRecord): Promise<OperationRecord | undefined> {
    const intent = this.intentForRecord(record);
    if (!intent) {
      return undefined;
    }
    return this.enqueue(intent);
  }

  async discardPrepared(record: OperationRecord): Promise<void> {
    if (record.kind === "publishing") {
      await this.publishing.abandonQueuedRun(record.publishRunId);
    }
    await this.operations.archive(record.id);
  }

  private async enqueueFieldTransfer(
    intent: Extract<OperationIntent, { readonly kind: "fieldValue" }>,
    context?: SequenceOperationContext,
  ): Promise<OperationRecord> {
    const sourceConnection = this.connections.get(intent.source.connectionId);
    const destinationConnection = this.connections.get(intent.destination.connectionId);
    const sourceSecret = sourceConnection &&
      await this.connections.getClientSecret(sourceConnection.id);
    const destinationSecret = destinationConnection &&
      await this.connections.getClientSecret(destinationConnection.id);
    if (!sourceConnection || !destinationConnection || !sourceSecret || !destinationSecret) {
      throw new Error("A field-transfer connection or its credentials are unavailable.");
    }
    const controller = new AbortController();
    const [sourceDetails, destinationDetails] = await Promise.all([
      this.authoring.loadItemDetails(
        sourceConnection,
        sourceSecret,
        intent.source.itemId,
        intent.source.language,
        controller.signal,
      ),
      this.authoring.loadItemDetails(
        destinationConnection,
        destinationSecret,
        intent.destination.itemId,
        intent.destination.language,
        controller.signal,
      ),
    ]);
    const sourceField = findField(sourceDetails.fields, intent.source.fieldId);
    const destinationField = findField(destinationDetails.fields, intent.destination.fieldId);
    if (!sourceField || !destinationField) {
      throw new Error("A saved field-transfer field no longer exists.");
    }
    const duplicateKey = executionKey("field-replay", context);
    const result = await this.operations.enqueue({
      kind: "fieldValue",
      duplicateKey,
      direction: "leftToRight",
      intent,
      ...context,
      source: {
        connectionId: sourceConnection.id,
        connectionName: sourceConnection.name,
        itemId: sourceDetails.itemId,
        itemPath: sourceDetails.path,
        language: sourceDetails.language,
        version: sourceDetails.version,
        fieldId: sourceField.fieldId,
        fieldName: sourceField.name,
        fieldLabel: intent.source.fieldLabel || sourceField.label || sourceField.name,
        fingerprint: fieldStateFingerprint(sourceDetails, sourceField),
      },
      target: {
        connectionId: destinationConnection.id,
        connectionName: destinationConnection.name,
        itemId: destinationDetails.itemId,
        itemPath: destinationDetails.path,
        language: destinationDetails.language,
        version: destinationDetails.version,
        fieldId: destinationField.fieldId,
        fieldName: destinationField.name,
        fieldLabel: intent.destination.fieldLabel || destinationField.label || destinationField.name,
        fingerprint: fieldStateFingerprint(destinationDetails, destinationField),
      },
    });
    return result.record;
  }

  private async enqueueSubtreeTransfer(
    intent: Extract<OperationIntent, { readonly kind: "subtree" }>,
    context?: SequenceOperationContext,
  ): Promise<OperationRecord> {
    const sourceConnection = this.connections.get(intent.source.connectionId);
    const destinationConnection = this.connections.get(intent.destination.connectionId);
    const sourceSecret = sourceConnection &&
      await this.connections.getClientSecret(sourceConnection.id);
    const destinationSecret = destinationConnection &&
      await this.connections.getClientSecret(destinationConnection.id);
    if (!sourceConnection || !destinationConnection || !sourceSecret || !destinationSecret) {
      throw new Error("A subtree-transfer connection or its credentials are unavailable.");
    }
    const controller = new AbortController();
    const [sourceLanguages, destinationLanguages] = await Promise.all([
      this.authoring.loadLanguages(sourceConnection, sourceSecret, controller.signal),
      this.authoring.loadLanguages(destinationConnection, destinationSecret, controller.signal),
    ]);
    const inspectionLanguage = commonInspectionLanguage(
      sourceLanguages.map((language) => language.name),
      destinationLanguages.map((language) => language.name),
    );
    if (!inspectionLanguage) {
      throw new Error("The transfer connections have no common language for runtime inspection.");
    }
    const currentRoot = await this.authoring.loadItemDetails(
      sourceConnection,
      sourceSecret,
      intent.source.rootItemId,
      inspectionLanguage,
      controller.signal,
    );
    const result = await this.operations.enqueue({
      kind: "subtree",
      duplicateKey: executionKey("subtree-replay", context),
      intent,
      ...context,
      mode: intent.mode,
      direction: "leftToRight",
      sourceConnectionId: sourceConnection.id,
      sourceConnectionName: sourceConnection.name,
      targetConnectionId: destinationConnection.id,
      targetConnectionName: destinationConnection.name,
      sourceItemId: currentRoot.itemId,
      sourcePath: currentRoot.path,
      sourceLanguage: inspectionLanguage,
      targetLanguage: inspectionLanguage,
      comparisonRowKey: "",
      targetSide: "right",
      targetRefreshPlan: [],
    });
    return result.record;
  }
}

function persistentFieldEndpoint(endpoint: {
  readonly connectionId: string;
  readonly itemId: string;
  readonly itemPath: string;
  readonly language: string;
  readonly fieldId: string;
  readonly fieldName: string;
  readonly fieldLabel: string;
}): Extract<OperationIntent, { readonly kind: "fieldValue" }>["source"] {
  return {
    connectionId: endpoint.connectionId,
    itemId: endpoint.itemId,
    itemPath: endpoint.itemPath,
    language: endpoint.language,
    fieldId: endpoint.fieldId,
    fieldName: endpoint.fieldName,
    fieldLabel: endpoint.fieldLabel,
  };
}

function findField(
  fields: readonly AuthoringItemField[],
  fieldId: string,
): AuthoringItemField | undefined {
  const normalized = normalizeTransferId(fieldId);
  return fields.find((field) => normalizeTransferId(field.fieldId) === normalized);
}

function commonInspectionLanguage(
  sourceLanguages: readonly string[],
  destinationLanguages: readonly string[],
): string | undefined {
  const destination = new Map(destinationLanguages.map((language) => [language.toLowerCase(), language]));
  const common = sourceLanguages.filter((language) => destination.has(language.toLowerCase()));
  return common.find((language) => language.toLowerCase() === "en") ??
    common.find((language) => language.toLowerCase().startsWith("en-")) ??
    common[0];
}

function executionKey(prefix: string, context?: SequenceOperationContext): string {
  return context
    ? `${prefix}:${context.sequenceRunId}:${context.sequenceOperationIndex}`
    : `${prefix}:${randomUUID()}`;
}

export type { PublishingIntent };
