import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { ConnectionStore } from "../connections/connectionStore";
import type { OperationDetailsPanel } from "../operations/operationDetailsPanel";
import type {
  PublishingIntent,
  SequenceOperationContext,
} from "../operations/operationTypes";
import type {
  AuthoringContentClient,
  AuthoringItemDetails,
  AuthoringSite,
} from "../sitecore/authoringClient";
import { ExperienceEdgeClient } from "../sitecore/experienceEdgeClient";
import { PublishingClient, type PublishingStatus } from "../sitecore/publishingClient";
import type { TransferQueueStore } from "../transfers/transferQueueStore";
import {
  verifyBrowserDom,
  type BrowserDomAssertion,
} from "./browserDomVerifier";
import {
  CollapsedScopeGraph,
  type CollapsedScopeGraphPlan,
} from "./collapsedScopeGraph";
import { powerPublishBatches, powerRepairBatches } from "./powerPublishPlanning";
import { showPowerPublishScopeForm } from "./powerPublishScopeForm";
import { parseReferenceField } from "./referenceDiscovery";
import { readPublishingProfiles, readPublishRuns } from "./publishingRunState";
import {
  diagnosticStageIds,
  finishRetryWithFailure,
  prepareDiagnosticRetry,
  prepareStatusRecheck,
} from "./publishingRunTransitions";
import {
  deduplicateIds,
  deduplicateSnapshots,
  expectedFieldsForSnapshot,
  powerExpectedFieldsForSnapshot,
  versionlessSnapshotEvidence,
} from "./publishingVerification";
import type {
  PublishKind,
  PublishBatch,
  PublishFieldSelection,
  PublishMode,
  PowerPublishEdgeVerification,
  PublishRun,
  PublishSnapshot,
  PublishTarget,
  PublishTraceAttempt,
  PublishingSiteProfile,
  ReferenceEdge,
  TraceStage,
  TraceStageStatus,
} from "./publishingTypes";
import {
  showTracedPublishForm,
  type TracedPublishFieldCandidate,
} from "./tracedPublishForm";

const runsKey = "sitecoreXmCloudSync.publishRuns.v1";
const profilesKey = "sitecoreXmCloudSync.publishingProfiles.v1";
const maximumTracedFieldItems = 200;
const maximumPowerBatchItems = 20;
const maximumPowerEdgeVerificationConcurrency = 8;
const edgePropagationTimeoutMs = 30_000;
const collapsedScopeItemBudget = 500;
const collapsedScopeReferenceBudget = 200;
const retryVerificationCommand = "xmCloudSync.retryPublishTraceVerification";
const republishTraceCommand = "xmCloudSync.republishTrace";
const repairPowerPublishCommand = "xmCloudSync.repairPowerPublish";
const recheckStatusCommand = "xmCloudSync.recheckPublishTraceStatus";

interface PublishOptions {
  readonly mode: PublishMode;
  readonly publishSubItems: boolean;
  readonly publishRelatedItems: boolean;
}

interface ProfileRunSettings {
  readonly profile: PublishingSiteProfile;
  readonly edgeToken: string;
  readonly route?: string;
  readonly routeItemId?: string;
  readonly applicationUrl?: string;
}

interface TracedFieldSelectionResult {
  readonly snapshots: readonly PublishSnapshot[];
  readonly fields: readonly PublishFieldSelection[];
}

interface DiagnosticPublishSetup {
  readonly options: PublishOptions;
  readonly profileSettings: ProfileRunSettings;
  readonly tracedFields: TracedFieldSelectionResult;
  readonly structuralDetails: readonly AuthoringItemDetails[];
}

export class PowerPublishReviewRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PowerPublishReviewRequiredError";
  }
}

export class PublishingManager implements vscode.Disposable {
  private readonly controllers = new Map<string, AbortController>();
  private readonly connectionSubscription: vscode.Disposable;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly workspaceState: vscode.Memento,
    private readonly globalState: vscode.Memento,
    private readonly globalStorageUri: vscode.Uri,
    private readonly connections: ConnectionStore,
    private readonly authoring: AuthoringContentClient,
    private readonly publishing: PublishingClient,
    private readonly edge: ExperienceEdgeClient,
    private readonly output: vscode.OutputChannel,
    private readonly operations: TransferQueueStore,
    private readonly operationDetails: OperationDetailsPanel,
  ) {
    this.connectionSubscription = connections.onDidChange(() => {
      void this.removeOrphanedProfiles();
    });
  }

  async start(kind: PublishKind, target: PublishTarget): Promise<void> {
    const connection = this.connections.get(target.connectionId);
    const clientSecret = await this.connections.getClientSecret(target.connectionId);
    if (!connection || !clientSecret) {
      await vscode.window.showErrorMessage("The selected XM Cloud connection or secret is missing.");
      return;
    }

    const controller = new AbortController();
    const preparationId = `preparation:${randomUUID()}`;
    this.controllers.set(preparationId, controller);
    let run: PublishRun | undefined;
    try {
      const rootDetails = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Preparing ${publishKindLabel(kind).toLowerCase()}`,
          cancellable: true,
        },
        async (_progress, token) => {
          const subscription = token.onCancellationRequested(() => controller.abort());
          try {
            return await this.authoring.loadItemDetails(
              connection,
              clientSecret,
              target.itemId,
              target.language,
              controller.signal,
            );
          } finally {
            subscription.dispose();
          }
        },
      );
      let profileSettings: ProfileRunSettings | undefined;
      let tracedFields: TracedFieldSelectionResult = {
        snapshots: [snapshotFromDetails(rootDetails)],
        fields: [],
      };
      let options: PublishOptions;
      let diagnosticSetup: DiagnosticPublishSetup | undefined;
      if (kind !== "standard") {
        const setup = await this.collectDiagnosticPublishSetup(
          kind,
          connection,
          clientSecret,
          rootDetails,
          target.language,
          controller.signal,
        );
        if (!setup) {
          return;
        }
        options = setup.options;
        profileSettings = setup.profileSettings;
        tracedFields = setup.tracedFields;
        diagnosticSetup = setup;
      } else {
        const collectedOptions = await this.collectPublishOptions(kind);
        if (!collectedOptions) {
          return;
        }
        options = collectedOptions;
      }

      const powerPlan = kind === "power"
        ? await this.reviewCollapsedPowerScope(
            connection,
            clientSecret,
            rootDetails,
            options.publishSubItems,
            tracedFields.fields.map((field) => field.itemId),
            diagnosticSetup?.structuralDetails ?? [rootDetails],
            controller.signal,
          )
        : undefined;
      if (kind === "power" && !powerPlan) {
        return;
      }
      const selectedIds = powerPlan?.publishItemIds ?? [rootDetails.itemId];

      if (kind !== "standard" && !profileSettings) {
        return;
      }
      if (
        profileSettings?.route &&
        profileSettings.profile.siteName
      ) {
        try {
          const baselineLayout = await this.edge.renderedLayout(
            profileSettings.profile.edgeEndpoint,
            profileSettings.edgeToken,
            profileSettings.profile.siteName,
            profileSettings.route,
            target.language,
            controller.signal,
          );
          profileSettings = { ...profileSettings, routeItemId: baselineLayout?.itemId };
        } catch (error: unknown) {
          this.output.appendLine(
            `Unable to capture the pre-publish route identity: ${errorMessage(error)}`,
          );
        }
      }
      const confirmed = kind === "traced" || await this.confirm(
        kind,
        connection.name,
        connection.serverUrl,
        rootDetails,
        target.language,
        options,
        selectedIds.length,
      );
      if (!confirmed) {
        return;
      }

      const batches = kind === "power"
        ? powerPublishBatches(
            selectedIds,
            rootDetails.itemId,
            powerPlan?.planningEdges ?? [],
            maximumPowerBatchItems,
          )
        : [{ itemIds: [rootDetails.itemId], label: publishKindLabel(kind) }];
      const scopeEvidence = kind === "traced"
        ? externalScopeReferenceEvidence(
            diagnosticSetup?.structuralDetails ?? [rootDetails],
          )
        : powerPlan?.evidence ?? [];
      run = {
        id: randomUUID(),
        kind,
        connectionId: connection.id,
        connectionName: connection.name,
        targetHost: new URL(connection.serverUrl).hostname,
        rootItemId: rootDetails.itemId,
        rootPath: rootDetails.path,
        language: target.language,
        publishMode: options.mode,
        publishSubItems: options.publishSubItems,
        publishRelatedItems: kind === "power" ? false : options.publishRelatedItems,
        createdAt: new Date().toISOString(),
        snapshots: kind === "traced"
          ? tracedFields.snapshots
          : powerPlan?.snapshots ?? [snapshotFromDetails(rootDetails)],
        fieldSelections: tracedFields.fields.length ? tracedFields.fields : undefined,
        referenceEdges: powerPlan?.concreteEdges ?? [],
        batches,
        stages: initialStages(kind, profileSettings, tracedFields, scopeEvidence),
        route: profileSettings?.route,
        routeItemId: profileSettings?.routeItemId,
        siteName: profileSettings?.profile.siteName,
        applicationUrl: profileSettings?.applicationUrl,
        intent: {
          kind: "publishing",
          publishKind: kind,
          connectionId: connection.id,
          rootItemId: rootDetails.itemId,
          rootPath: rootDetails.path,
          language: target.language,
          publishMode: options.mode,
          publishSubItems: options.publishSubItems,
          publishRelatedItems: kind === "power" ? false : options.publishRelatedItems,
          siteName: profileSettings?.profile.siteName,
          route: profileSettings?.route,
          applicationUrl: profileSettings?.applicationUrl,
          fieldAssertions: tracedFields.fields.length ? tracedFields.fields : undefined,
          selectedCollapsedScopeIds: powerPlan?.selectedScopeIds,
          observedCollapsedScopeIds: powerPlan?.observedScopeIds,
        },
      };
      await this.saveRun(run);
      this.controllers.delete(preparationId);
      const queued = await this.operations.enqueuePublishing({
        kind: "publishing",
        duplicateKey: `publishing:${run.id}`,
        publishRunId: run.id,
        publishKind: kind,
        connectionId: connection.id,
        connectionName: connection.name,
        itemId: rootDetails.itemId,
        itemPath: rootDetails.path,
        language: target.language,
        intent: run.intent,
      });
      await vscode.window.showInformationMessage(
        `${publishKindLabel(kind)} added to Operations${
          queued.added ? "." : " (already queued)."
        }`,
      );
    } catch (error: unknown) {
      if (isAbort(error)) {
        this.output.appendLine("Publish preparation or execution was cancelled.");
        return;
      }
      const message = errorMessage(error);
      this.output.appendLine(`Publish failed: ${message}`);
      if (run) {
        const failed = this.finishWithFailure(run, message);
        await this.saveRun(failed);
        this.openTrace(failed);
      }
      await vscode.window.showErrorMessage(`XM Cloud publish failed: ${message}`);
    } finally {
      this.controllers.delete(preparationId);
      if (run) {
        this.controllers.delete(run.id);
      }
    }
  }

  intentForRun(runId: string): PublishingIntent | undefined {
    const run = this.listRuns().find((candidate) => candidate.id === runId);
    if (!run) {
      return undefined;
    }
    if (run.intent) {
      return run.intent;
    }
    if (run.kind === "power") {
      return undefined;
    }
    return {
      kind: "publishing",
      publishKind: run.kind,
      connectionId: run.connectionId,
      rootItemId: run.rootItemId,
      rootPath: run.rootPath,
      language: run.language,
      publishMode: run.publishMode,
      publishSubItems: run.publishSubItems,
      publishRelatedItems: run.publishRelatedItems,
      siteName: run.siteName,
      route: run.route,
      applicationUrl: run.applicationUrl,
      fieldAssertions: run.fieldSelections,
    };
  }

  hasSavedProfile(connectionId: string): boolean {
    return this.listProfiles().some((profile) => profile.connectionId === connectionId);
  }

  async enqueueIntent(
    intent: PublishingIntent,
    context?: SequenceOperationContext,
  ): Promise<Extract<ReturnType<TransferQueueStore["get"]>, { readonly kind: "publishing" }>> {
    const run = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Preparing replay of ${publishKindLabel(intent.publishKind).toLowerCase()}`,
        cancellable: false,
      },
      () => this.prepareIntentRun(intent, !context),
    );
    await this.saveRun(run);
    const queued = await this.operations.enqueuePublishing({
      kind: "publishing",
      duplicateKey: context
        ? `publishing-sequence:${context.sequenceRunId}:${context.sequenceOperationIndex}`
        : `publishing:${run.id}`,
      publishRunId: run.id,
      publishKind: run.kind,
      connectionId: run.connectionId,
      connectionName: run.connectionName,
      itemId: run.rootItemId,
      itemPath: run.rootPath,
      language: run.language,
      intent,
      ...context,
    });
    if (queued.record.kind !== "publishing") {
      throw new Error("The prepared publishing operation has an invalid queue record.");
    }
    return queued.record;
  }

  private async prepareIntentRun(
    intent: PublishingIntent,
    allowPowerReview: boolean,
  ): Promise<PublishRun> {
    const connection = this.connections.get(intent.connectionId);
    const clientSecret = await this.connections.getClientSecret(intent.connectionId);
    if (!connection || !clientSecret) {
      throw new Error("The publishing connection or its credentials are unavailable.");
    }
    const controller = new AbortController();
    const root = await this.authoring.loadItemDetails(
      connection,
      clientSecret,
      intent.rootItemId,
      intent.language,
      controller.signal,
    );
    const options: PublishOptions = {
      mode: intent.publishMode,
      publishSubItems: intent.publishSubItems,
      publishRelatedItems: intent.publishKind === "power" ? false : intent.publishRelatedItems,
    };
    let profileSettings: ProfileRunSettings | undefined;
    let tracedFields: TracedFieldSelectionResult = {
      snapshots: [snapshotFromDetails(root)],
      fields: [],
    };
    let structuralDetails: readonly AuthoringItemDetails[] = [root];
    if (intent.publishKind !== "standard") {
      const profile = this.listProfiles().find((candidate) =>
        candidate.connectionId === intent.connectionId
      );
      const edgeToken = await this.connections.getEdgeToken(intent.connectionId);
      if (!profile || !edgeToken) {
        throw new Error("Saved Experience Edge settings are unavailable.");
      }
      if (!intent.siteName || !intent.route) {
        throw new Error("The saved diagnostic publish has no Sitecore site or route.");
      }
      if (intent.publishSubItems || intent.publishKind === "power") {
        structuralDetails = (await this.loadStructuralDescendants(
          connection,
          clientSecret,
          root,
          controller.signal,
        )).details;
      }
      const assertionDetails = new Map<string, AuthoringItemDetails>(
        structuralDetails.map((details) => [normalizeId(details.itemId), details]),
      );
      const selections = intent.fieldAssertions ?? [];
      for (const selection of selections) {
        const key = normalizeId(selection.itemId);
        if (!assertionDetails.has(key)) {
          try {
            assertionDetails.set(key, await this.authoring.loadItemDetails(
              connection,
              clientSecret,
              selection.itemId,
              intent.language,
              controller.signal,
            ));
          } catch (error: unknown) {
            throw new Error(
              `Saved field assertion item ${selection.itemId} requires review: ${errorMessage(error)}`,
            );
          }
        }
      }
      for (const selection of selections) {
        const owner = assertionDetails.get(normalizeId(selection.itemId));
        if (!owner || !Object.prototype.hasOwnProperty.call(
          snapshotFromDetails(owner).fields,
          selection.fieldName,
        )) {
          throw new Error(
            `Saved field assertion ${selection.itemId} › ${selection.fieldName} requires review.`,
          );
        }
      }
      tracedFields = {
        fields: selections,
        snapshots: deduplicateSnapshots([
          snapshotFromDetails(root),
          ...selections.map((selection) =>
            snapshotFromDetails(assertionDetails.get(normalizeId(selection.itemId))!)
          ),
        ]),
      };
      profileSettings = {
        profile: { ...profile, siteName: intent.siteName },
        edgeToken,
        route: normalizeRoute(intent.route),
        applicationUrl: intent.applicationUrl,
      };
      try {
        const baseline = await this.edge.renderedLayout(
          profile.edgeEndpoint,
          edgeToken,
          intent.siteName,
          normalizeRoute(intent.route),
          intent.language,
          controller.signal,
        );
        profileSettings = { ...profileSettings, routeItemId: baseline?.itemId };
      } catch (error: unknown) {
        this.output.appendLine(
          `Unable to recapture the replay route identity: ${errorMessage(error)}`,
        );
      }
    }

    const powerPlan = intent.publishKind === "power"
      ? await this.prepareSavedPowerPlan(
          connection,
          clientSecret,
          root,
          intent,
          tracedFields.fields.map((field) => field.itemId),
          structuralDetails,
          controller.signal,
          allowPowerReview,
        )
      : undefined;
    const selectedIds = powerPlan?.publishItemIds ?? [root.itemId];
    const batches = intent.publishKind === "power"
      ? powerPublishBatches(
          selectedIds,
          root.itemId,
          powerPlan?.planningEdges ?? [],
          maximumPowerBatchItems,
        )
      : [{ itemIds: [root.itemId], label: publishKindLabel(intent.publishKind) }];
    const scopeEvidence = intent.publishKind === "traced"
      ? externalScopeReferenceEvidence(structuralDetails)
      : powerPlan?.evidence ?? [];
    const refreshedIntent: PublishingIntent = {
      ...intent,
      rootPath: root.path,
      selectedCollapsedScopeIds: powerPlan?.selectedScopeIds ?? intent.selectedCollapsedScopeIds,
      observedCollapsedScopeIds: powerPlan?.observedScopeIds ?? intent.observedCollapsedScopeIds,
    };
    return {
      id: randomUUID(),
      kind: intent.publishKind,
      connectionId: connection.id,
      connectionName: connection.name,
      targetHost: new URL(connection.serverUrl).hostname,
      rootItemId: root.itemId,
      rootPath: root.path,
      language: intent.language,
      publishMode: options.mode,
      publishSubItems: options.publishSubItems,
      publishRelatedItems: options.publishRelatedItems,
      createdAt: new Date().toISOString(),
      snapshots: intent.publishKind === "power"
        ? powerPlan?.snapshots ?? [snapshotFromDetails(root)]
        : tracedFields.snapshots,
      fieldSelections: tracedFields.fields.length ? tracedFields.fields : undefined,
      referenceEdges: powerPlan?.concreteEdges ?? [],
      batches,
      stages: initialStages(intent.publishKind, profileSettings, tracedFields, scopeEvidence),
      route: profileSettings?.route,
      routeItemId: profileSettings?.routeItemId,
      siteName: profileSettings?.profile.siteName,
      applicationUrl: profileSettings?.applicationUrl,
      intent: refreshedIntent,
    };
  }

  async executeQueued(runId: string): Promise<void> {
    const run = this.listRuns().find((candidate) => candidate.id === runId);
    if (!run) {
      throw new Error("The saved publishing run could not be found.");
    }
    if (run.completedAt) {
      return;
    }
    const connection = this.connections.get(run.connectionId);
    const clientSecret = await this.connections.getClientSecret(run.connectionId);
    if (!connection || !clientSecret) {
      throw new Error("The publishing connection or its secret is unavailable.");
    }
    const controller = new AbortController();
    this.controllers.set(run.id, controller);
    if (run.kind !== "standard") {
      this.openTrace(run);
    }
    try {
      if (run.batches.some((batch) => batch.operationId)) {
        await this.resumeBatches(run, connection, clientSecret, controller.signal);
      } else {
        const settings = run.kind === "standard"
          ? undefined
          : await this.loadRetrySettings(run);
        if (run.kind !== "standard" && !settings) {
          throw new Error("Saved Experience Edge settings are unavailable.");
        }
        await this.execute(run, connection, clientSecret, settings, controller.signal);
      }
    } catch (error: unknown) {
      const latest = this.listRuns().find((candidate) => candidate.id === run.id) ?? run;
      const failed = this.finishWithFailure(latest, errorMessage(error));
      await this.saveRun(failed);
      this.openTrace(failed);
      throw error;
    } finally {
      this.controllers.delete(run.id);
    }
  }

  showTrace(runId: string): void {
    const run = this.listRuns().find((candidate) => candidate.id === runId);
    if (run) {
      this.openTrace(run);
    }
  }

  async enqueuePendingRuns(): Promise<void> {
    const queuedRunIds = new Set(
      this.operations.list()
        .filter((record) => record.kind === "publishing")
        .map((record) => record.publishRunId),
    );
    for (const run of this.listRuns().filter((candidate) => !candidate.completedAt)) {
      if (queuedRunIds.has(run.id)) {
        continue;
      }
      await this.operations.enqueuePublishing({
        kind: "publishing",
        duplicateKey: `publishing:${run.id}`,
        publishRunId: run.id,
        publishKind: run.kind,
        connectionId: run.connectionId,
        connectionName: run.connectionName,
        itemId: run.rootItemId,
        itemPath: run.rootPath,
        language: run.language,
      });
    }
  }

  async abandonQueuedRun(runId: string): Promise<void> {
    const run = this.listRuns().find((candidate) => candidate.id === runId);
    if (!run || run.completedAt) {
      return;
    }
    await this.saveRun({
      ...run,
      completedAt: new Date().toISOString(),
      conclusion: "Removed from the Operations queue before execution.",
    });
  }

  async configureConnection(connectionId?: string): Promise<void> {
    let resolvedConnectionId = connectionId;
    if (!resolvedConnectionId) {
      const selected = await vscode.window.showQuickPick(
        this.connections.list().map((connection) => ({
          label: connection.name,
          description: connection.serverUrl,
          connectionId: connection.id,
        })),
        { title: "Configure traced publishing", placeHolder: "Select an XM Cloud connection" },
      );
      resolvedConnectionId = selected?.connectionId;
    }
    if (!resolvedConnectionId || !this.connections.get(resolvedConnectionId)) {
      return;
    }
    const controller = new AbortController();
    const existing = this.listProfiles().find((profile) =>
      profile.connectionId === resolvedConnectionId
    );
    const existingToken = await this.connections.getEdgeToken(resolvedConnectionId);
    const endpoint = await vscode.window.showInputBox({
      title: "Configure traced publishing (1/3)",
      prompt: "Enter the Experience Edge GraphQL endpoint.",
      value: existing?.edgeEndpoint ?? "https://edge.sitecorecloud.io/api/graphql/v1",
      ignoreFocusOut: true,
      validateInput: validateHttpsUrl,
    });
    if (endpoint === undefined) {
      return;
    }
    const token = await vscode.window.showInputBox({
      title: "Configure traced publishing (2/3)",
      prompt: existingToken
        ? "Enter a replacement Experience Edge token, or leave empty to keep the stored token."
        : "Enter the Experience Edge token.",
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) =>
        value || existingToken ? undefined : "Experience Edge token is required.",
    });
    if (token === undefined) {
      return;
    }
    const effectiveToken = token || existingToken;
    if (!effectiveToken) {
      return;
    }
    const tokenApproved = await this.confirmEdgeTokenScope(
      resolvedConnectionId,
      endpoint.trim(),
      effectiveToken,
      controller.signal,
    );
    if (!tokenApproved) {
      return;
    }
    const siteSelection = await this.selectSiteName(
      resolvedConnectionId,
      existing?.siteName,
      controller.signal,
    );
    if (!siteSelection) {
      return;
    }
    await this.saveProfile(
      {
        connectionId: resolvedConnectionId,
        edgeEndpoint: endpoint.trim(),
        siteName: siteSelection.siteName,
      },
      effectiveToken,
    );
    await vscode.window.showInformationMessage("Traced publishing settings saved.");
  }

  showLatestTrace(): void {
    const latest = this.listRuns()[0];
    if (latest) {
      this.openTrace(latest);
    } else {
      void vscode.window.showInformationMessage("No publish traces have been recorded yet.");
    }
  }

  async retryFailedVerification(runId: string): Promise<void> {
    const original = this.listRuns().find((run) => run.id === runId);
    if (!original) {
      await vscode.window.showErrorMessage("The selected publish trace is no longer available.");
      return;
    }
    if (this.controllers.size > 0) {
      await vscode.window.showInformationMessage(
        "Wait for the current publish operation or verification retry to finish.",
      );
      return;
    }
    const firstFailedStage = diagnosticStageIds.find((id) => {
      const status = original.stages.find((stage) => stage.id === id)?.status;
      return status === "diverged" || status === "failed";
    }) ?? diagnosticStageIds.find((id) =>
      original.stages.find((stage) => stage.id === id)?.status === "inconclusive"
    );
    if (!firstFailedStage) {
      await vscode.window.showInformationMessage(
        "This trace has no failed diagnostic stage to retry.",
      );
      return;
    }
    const settings = await this.loadRetrySettings(original);
    if (!settings) {
      return;
    }
    const controller = new AbortController();
    let run = prepareDiagnosticRetry(original, firstFailedStage, new Date().toISOString());
    await this.saveRun(run);
    this.openTrace(run);
    this.controllers.set(run.id, controller);
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Retrying publish verification: ${run.rootPath}`,
          cancellable: true,
        },
        async (_progress, token) => {
          const subscription = token.onCancellationRequested(() => controller.abort());
          try {
            const firstIndex = diagnosticStageIds.indexOf(firstFailedStage);
            if (firstIndex <= diagnosticStageIds.indexOf("edgeItem")) {
              run = run.kind === "power"
                ? await this.verifyPowerEdgeItems(run, settings, controller.signal)
                : await this.verifyEdgeItems(run, settings, controller.signal);
            }
            if (firstIndex <= diagnosticStageIds.indexOf("edgeLayout")) {
              run = await this.verifyLayout(run, settings, controller.signal);
            }
            if (firstIndex <= diagnosticStageIds.indexOf("application")) {
              run = await this.verifyApplication(run, controller.signal);
            }
            if (firstIndex <= diagnosticStageIds.indexOf("browserDom")) {
              run = await this.verifyBrowserDom(run, controller.signal);
            }
          } finally {
            subscription.dispose();
          }
        },
      );
      await this.complete(run, classify(run));
    } catch (error: unknown) {
      if (isAbort(error)) {
        await this.saveRun(original);
        this.renderIfDisplayed(original);
        await vscode.window.showInformationMessage("Verification retry was cancelled.");
        return;
      }
      const failed = finishRetryWithFailure(
        run,
        "Verification retry failed",
        errorMessage(error),
        new Date().toISOString(),
      );
      await this.saveRun(failed);
      this.renderIfDisplayed(failed);
      await vscode.window.showErrorMessage(
        failed.conclusion ?? "Verification retry failed.",
      );
    } finally {
      this.controllers.delete(run.id);
    }
  }

  async repairPowerPublish(runId: string): Promise<void> {
    const original = this.listRuns().find((run) => run.id === runId);
    const divergentItemIds = original?.kind === "power"
      ? original.powerEdgeVerification?.divergentItemIds ?? []
      : [];
    if (!original || original.kind !== "power" || divergentItemIds.length === 0) {
      await vscode.window.showInformationMessage(
        "This Power Publish trace has no missing or mismatched items to republish.",
      );
      return;
    }
    if (this.controllers.size > 0) {
      await vscode.window.showInformationMessage(
        "Wait for the current publish operation or verification retry to finish.",
      );
      return;
    }
    const connection = this.connections.get(original.connectionId);
    const clientSecret = await this.connections.getClientSecret(original.connectionId);
    if (!connection || !clientSecret) {
      await vscode.window.showErrorMessage(
        "The publishing connection or its stored secret is unavailable.",
      );
      return;
    }
    const settings = await this.loadRetrySettings(original);
    if (!settings) {
      return;
    }
    const itemIds = deduplicateIds(divergentItemIds);
    const selected = new Set(itemIds.map(normalizeId));
    const snapshots = deduplicateSnapshots(original.snapshots).filter((snapshot) =>
      selected.has(normalizeId(snapshot.itemId))
    );
    if (!snapshots.length) {
      await vscode.window.showErrorMessage(
        "The saved Edge divergences do not have authoring snapshots to republish.",
      );
      return;
    }
    const confirmation = await vscode.window.showWarningMessage(
      `Force republish ${snapshots.length} missing or mismatched item(s) to ${connection.name}? ` +
        "Only those items will be published, using Full publish.",
      { modal: true },
      "Force republish items",
    );
    if (confirmation !== "Force republish items") {
      return;
    }
    const fields = (original.fieldSelections ?? []).filter((field) =>
      selected.has(normalizeId(field.itemId))
    );
    const repair: PublishRun = {
      id: randomUUID(),
      kind: "power",
      connectionId: original.connectionId,
      connectionName: original.connectionName,
      targetHost: original.targetHost,
      rootItemId: original.rootItemId,
      rootPath: original.rootPath,
      language: original.language,
      publishMode: "FULL",
      publishSubItems: false,
      publishRelatedItems: false,
      createdAt: new Date().toISOString(),
      snapshots,
      fieldSelections: fields.length ? fields : undefined,
      referenceEdges: original.referenceEdges.filter((edge) =>
        selected.has(normalizeId(edge.sourceItemId))
      ),
      batches: powerRepairBatches(original.batches, itemIds, maximumPowerBatchItems),
      stages: initialStages(
        "power",
        settings,
        { snapshots, fields },
        [
          `Repair of Power Publish ${original.id}: force publishing ${snapshots.length} item(s) that did not match Experience Edge.`,
        ],
      ),
      route: original.route,
      routeItemId: original.routeItemId,
      siteName: original.siteName,
      applicationUrl: original.applicationUrl,
    };
    await this.saveRun(repair);
    await this.operations.enqueuePublishing({
      kind: "publishing",
      duplicateKey: `publishing:${repair.id}`,
      publishRunId: repair.id,
      publishKind: repair.kind,
      connectionId: repair.connectionId,
      connectionName: repair.connectionName,
      itemId: repair.rootItemId,
      itemPath: repair.rootPath,
      language: repair.language,
    });
    this.output.appendLine(
      `Queued Power Publish repair ${repair.id} for ${snapshots.length} item(s) from ${original.id}.`,
    );
    await vscode.window.showInformationMessage(
      `Force republish of ${snapshots.length} item(s) added to Operations.`,
    );
  }

  async publishAgain(runId: string): Promise<void> {
    const run = this.listRuns().find((candidate) => candidate.id === runId);
    if (!run) {
      await vscode.window.showErrorMessage("The selected publish trace is no longer available.");
      return;
    }
    await this.start(run.kind, {
      connectionId: run.connectionId,
      side: "left",
      itemId: run.rootItemId,
      path: run.rootPath,
      language: run.language,
    });
  }

  async recheckPublishStatus(runId: string): Promise<void> {
    const original = this.listRuns().find((run) => run.id === runId);
    if (!original) {
      await vscode.window.showErrorMessage("The selected publish trace is no longer available.");
      return;
    }
    if (this.controllers.size > 0) {
      await vscode.window.showInformationMessage(
        "Wait for the current publish operation or status check to finish.",
      );
      return;
    }
    const operationBatches = original.batches.filter((batch) => batch.operationId);
    if (!isAbandonedRun(original) || operationBatches.length === 0) {
      await vscode.window.showInformationMessage(
        "This trace has no abandoned publishing operation to check.",
      );
      return;
    }
    const connection = this.connections.get(original.connectionId);
    const clientSecret = await this.connections.getClientSecret(original.connectionId);
    if (!connection || !clientSecret) {
      await vscode.window.showErrorMessage(
        "The publish connection or its stored secret is unavailable.",
      );
      return;
    }
    const controller = new AbortController();
    let run = prepareStatusRecheck(original, new Date().toISOString());
    await this.saveRun(run);
    this.openTrace(run);
    this.controllers.set(run.id, controller);
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Checking XM Cloud publish status: ${run.rootPath}`,
          cancellable: true,
        },
        async (_progress, token) => {
          const subscription = token.onCancellationRequested(() => controller.abort());
          try {
            for (const batch of operationBatches) {
              if (batch.operationId) {
                await this.pollPublishing(
                  connection,
                  clientSecret,
                  batch.operationId,
                  controller.signal,
                );
              }
            }
          } finally {
            subscription.dispose();
          }
        },
      );
      const missingOperations = run.batches.filter((batch) => !batch.operationId);
      if (missingOperations.length > 0) {
        run = await this.setStage(
          run,
          "publishing",
          "diverged",
          `${operationBatches.length} saved operation(s) finished, but ${missingOperations.length} batch(es) had not been started.`,
          missingOperations.map((batch) => `${batch.label}: no operation ID`),
        );
        await this.complete(
          run,
          "Saved XM Cloud operations finished, but the original publishing plan was incomplete.",
        );
        return;
      }
      run = await this.setStage(
        run,
        "publishing",
        "matched",
        `${operationBatches.length} saved publishing operation(s) completed.`,
        operationBatches.flatMap((batch) =>
          batch.operationId ? [`${batch.label}: ${batch.operationId}`] : []
        ),
      );
      if (run.kind === "standard") {
        await this.complete(run, "Sitecore completed the publishing operation.");
        return;
      }
      const settings = await this.loadRetrySettings(run);
      if (!settings) {
        run = await this.setStage(
          run,
          "edgeItem",
          "failed",
          "Saved Experience Edge settings are unavailable.",
        );
        await this.complete(
          run,
          "Publishing completed, but saved verification settings are unavailable.",
        );
        return;
      }
      run = await this.verifyEdgeItems(run, settings, controller.signal);
      run = await this.verifyLayout(run, settings, controller.signal);
      run = await this.verifyApplication(run, controller.signal);
      run = await this.verifyBrowserDom(run, controller.signal);
      await this.complete(run, classify(run));
    } catch (error: unknown) {
      if (isAbort(error)) {
        await this.saveRun(original);
        this.renderIfDisplayed(original);
        await vscode.window.showInformationMessage("Publish status check was cancelled.");
        return;
      }
      const failed = finishRetryWithFailure(
        run,
        "Publish status check failed",
        errorMessage(error),
        new Date().toISOString(),
      );
      await this.saveRun(failed);
      this.renderIfDisplayed(failed);
      await vscode.window.showErrorMessage(
        failed.conclusion ?? "Publish status check failed.",
      );
    } finally {
      this.controllers.delete(run.id);
    }
  }

  async abandonCurrentPublish(skipConfirmation = false): Promise<boolean> {
    const incompleteRuns = this.listRuns().filter((run) => !run.completedAt);
    if (this.controllers.size === 0 && incompleteRuns.length === 0) {
      await vscode.window.showInformationMessage(
        "There is no active or incomplete local publish operation to abandon.",
      );
      return false;
    }
    if (!skipConfirmation) {
      const action = "Abandon Local Tracking";
      const selection = await vscode.window.showWarningMessage(
        "Abandon the current local publish operation?",
        {
          modal: true,
          detail:
            "This stops monitoring, marks incomplete publish traces as locally abandoned, and releases the extension lock. It does not cancel publishing in XM Cloud, so a server-side operation may still be running.",
        },
        action,
      );
      if (selection !== action) {
        return false;
      }
    }

    for (const controller of this.controllers.values()) {
      controller.abort();
    }
    this.controllers.clear();
    const completedAt = new Date().toISOString();
    for (const run of incompleteRuns) {
      let abandoned: PublishRun = {
        ...run,
        completedAt,
        conclusion:
          "Local tracking was abandoned by the user. The XM Cloud publishing status is unknown.",
        stages: run.stages.map((stage) =>
          stage.status === "pending" || stage.status === "running"
            ? {
                ...stage,
                status: "skipped",
                summary: "Local tracking abandoned; server-side status is unknown.",
                updatedAt: completedAt,
              }
            : stage
        ),
      };
      const journalPath = await this.writeJournal(abandoned);
      abandoned = { ...abandoned, journalPath };
      await this.saveRun(abandoned);
      this.renderIfDisplayed(abandoned);
      const operationIds = abandoned.batches
        .flatMap((batch) => batch.operationId ? [batch.operationId] : []);
      this.output.appendLine(
        `Abandoned local publish tracking ${abandoned.id}; server-side status unknown${
          operationIds.length ? ` (${operationIds.join(", ")})` : ""
        }.`,
      );
    }
    if (!skipConfirmation) {
      await vscode.window.showInformationMessage(
        "Local publish tracking was abandoned. XM Cloud publishing was not cancelled.",
      );
    }
    return true;
  }

  async resumePending(): Promise<void> {
    const pending = this.listRuns().find((run) =>
      !run.completedAt && run.batches.some((batch) => batch.operationId)
    );
    if (!pending) {
      return;
    }
    const connection = this.connections.get(pending.connectionId);
    const secret = await this.connections.getClientSecret(pending.connectionId);
    if (!connection || !secret) {
      return;
    }
    const controller = new AbortController();
    this.controllers.set(pending.id, controller);
    this.output.appendLine(`Resuming publish trace ${pending.id}.`);
    if (pending.kind !== "standard") {
      this.openTrace(pending);
    }
    try {
      await this.resumeBatches(pending, connection, secret, controller.signal);
    } catch (error: unknown) {
      this.output.appendLine(`Unable to resume publish trace: ${errorMessage(error)}`);
    } finally {
      this.controllers.delete(pending.id);
    }
  }

  dispose(): void {
    for (const controller of this.controllers.values()) {
      controller.abort();
    }
    this.connectionSubscription.dispose();
  }

  private async execute(
    initialRun: PublishRun,
    connection: NonNullable<ReturnType<ConnectionStore["get"]>>,
    clientSecret: string,
    profileSettings: ProfileRunSettings | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    let run = await this.setStage(initialRun, "publishing", "running", "Starting publish.");
    this.output.appendLine(
      `${publishKindLabel(run.kind)}: ${run.rootPath}, ${run.language}, ${run.targetHost}.`,
    );
    for (let index = 0; index < run.batches.length; index += 1) {
      const batch = run.batches[index];
      run = await this.setBatchProgress(
        run,
        index,
        "running",
        "Submitting to Sitecore.",
        `Submitting publishing batch ${index + 1} of ${run.batches.length}.`,
      );
      this.output.appendLine(`${batch.label}: starting ${batch.itemIds.join(", ")}.`);
      const operationId = await this.publishing.start(
        connection,
        clientSecret,
        {
          itemIds: batch.itemIds,
          languages: [run.language],
          mode: run.publishMode,
          publishSubItems: run.publishSubItems,
          publishRelatedItems: run.publishRelatedItems,
          displayName: `XM Cloud Sync: ${batch.label}`,
        },
        signal,
      );
      run = {
        ...run,
        batches: run.batches.map((candidate, candidateIndex) =>
          candidateIndex === index
            ? {
                ...candidate,
                operationId,
                checkpointStatus: "running",
                checkpointSummary: "Submitted; waiting for Sitecore.",
              }
            : candidate
        ),
      };
      await this.saveRun(run);
      this.renderIfDisplayed(run);
      const status = await this.pollPublishing(
        connection,
        clientSecret,
        operationId,
        signal,
        async (progress) => {
          run = await this.setBatchProgress(
            run,
            index,
            "running",
            publishingProgressSummary(progress),
            `Publishing batch ${index + 1} of ${run.batches.length}: ${publishingProgressSummary(progress)}`,
          );
        },
      );
      run = await this.setBatchProgress(
        run,
        index,
        "matched",
        `${status.processed} item(s) processed.`,
        `Completed publishing batch ${index + 1} of ${run.batches.length}.`,
      );
      this.output.appendLine(
        `${batch.label}: ${status.state}, ${status.processed} item(s) processed.`,
      );
    }
    run = await this.setStage(
      run,
      "publishing",
      "matched",
      `${run.batches.length} publishing batch(es) completed.`,
      run.batches.flatMap((batch) => batch.operationId ? [`${batch.label}: ${batch.operationId}`] : []),
    );

    if (run.kind === "standard") {
      await this.complete(run, "Sitecore completed the publishing operation.");
      return;
    }
    if (!profileSettings) {
      throw new Error("Experience Edge settings are unavailable for traced publishing.");
    }
    run = run.kind === "power"
      ? await this.verifyPowerEdgeItems(run, profileSettings, signal)
      : await this.verifyEdgeItems(run, profileSettings, signal);
    run = await this.verifyLayout(run, profileSettings, signal);
    run = await this.verifyApplication(run, signal);
    run = await this.verifyBrowserDom(run, signal);
    const conclusion = classify(run);
    await this.complete(run, conclusion);
  }

  private async resumeBatches(
    initialRun: PublishRun,
    connection: NonNullable<ReturnType<ConnectionStore["get"]>>,
    clientSecret: string,
    signal: AbortSignal,
  ): Promise<void> {
    let run = initialRun;
    const profile = run.kind === "standard"
      ? undefined
      : this.listProfiles().find((candidate) =>
          candidate.connectionId === run.connectionId
        );
    const edgeToken = run.kind === "standard"
      ? undefined
      : await this.connections.getEdgeToken(run.connectionId);
    const settings = profile && edgeToken
      ? {
          profile,
          edgeToken,
          route: run.route,
          routeItemId: run.routeItemId,
          applicationUrl: run.applicationUrl,
        }
      : undefined;
    for (let index = 0; index < run.batches.length; index += 1) {
      let batch = run.batches[index];
      if (!batch.operationId) {
        run = await this.setBatchProgress(
          run,
          index,
          "running",
          "Submitting to Sitecore.",
          `Submitting publishing batch ${index + 1} of ${run.batches.length}.`,
        );
        const operationId = await this.publishing.start(
          connection,
          clientSecret,
          {
            itemIds: batch.itemIds,
            languages: [run.language],
            mode: run.publishMode,
            publishSubItems: run.publishSubItems,
            publishRelatedItems: run.publishRelatedItems,
            displayName: `XM Cloud Sync: ${batch.label}`,
          },
          signal,
        );
        run = {
          ...run,
          batches: run.batches.map((candidate, candidateIndex) =>
            candidateIndex === index
              ? {
                  ...candidate,
                  operationId,
                  checkpointStatus: "running",
                  checkpointSummary: "Submitted; waiting for Sitecore.",
                }
              : candidate
          ),
        };
        await this.saveRun(run);
        this.renderIfDisplayed(run);
        batch = run.batches[index];
      }
      if (batch.operationId) {
        run = await this.setBatchProgress(
          run,
          index,
          "running",
          batch.checkpointSummary ?? "Resuming Sitecore status tracking.",
          `Tracking publishing batch ${index + 1} of ${run.batches.length}.`,
        );
        const status = await this.pollPublishing(
          connection,
          clientSecret,
          batch.operationId,
          signal,
          async (progress) => {
            run = await this.setBatchProgress(
              run,
              index,
              "running",
              publishingProgressSummary(progress),
              `Publishing batch ${index + 1} of ${run.batches.length}: ${publishingProgressSummary(progress)}`,
            );
          },
        );
        run = await this.setBatchProgress(
          run,
          index,
          "matched",
          `${status.processed} item(s) processed.`,
          `Completed publishing batch ${index + 1} of ${run.batches.length}.`,
        );
      }
    }
    run = await this.setStage(
      run,
      "publishing",
      "matched",
      "Previously started publishing operations completed.",
    );
    if (run.kind === "standard") {
      await this.complete(run, "Sitecore completed the publishing operation.");
      return;
    }
    if (!profile || !edgeToken) {
      await this.complete(
        run,
        "Publishing completed after restart, but saved Experience Edge settings were unavailable.",
      );
      return;
    }
    const verificationSettings = settings ?? {
      profile,
      edgeToken,
      route: run.route,
      routeItemId: run.routeItemId,
      applicationUrl: run.applicationUrl,
    };
    run = run.kind === "power"
      ? await this.verifyPowerEdgeItems(run, verificationSettings, signal)
      : await this.verifyEdgeItems(run, verificationSettings, signal);
    run = await this.verifyLayout(run, verificationSettings, signal);
    run = await this.verifyApplication(run, signal);
    run = await this.verifyBrowserDom(run, signal);
    await this.complete(run, classify(run));
  }

  private async verifyPowerEdgeItems(
    initialRun: PublishRun,
    settings: ProfileRunSettings,
    signal: AbortSignal,
  ): Promise<PublishRun> {
    const observedSnapshots = deduplicateSnapshots(initialRun.snapshots);
    const snapshots = observedSnapshots.filter((snapshot) => snapshot.version > 0);
    const skippedEvidence = versionlessSnapshotEvidence(observedSnapshots, initialRun.language);
    this.output.appendLine(
      `Power Publish: all Sitecore batches completed; verifying ${snapshots.length} language-versioned item(s) on Experience Edge and skipping ${skippedEvidence.length} version-0 item(s).`,
    );
    let run = await this.setPowerEdgeVerification(
      initialRun,
      "running",
      `Verifying ${snapshots.length} observable item(s) on Experience Edge; ${skippedEvidence.length} version-0 item(s) skipped.`,
    );
    if (!snapshots.length) {
      return this.setPowerEdgeVerification(
        run,
        "matched",
        `No ${run.language} language-versioned items required Experience Edge verification.`,
        skippedEvidence,
      );
    }
    const deadline = Date.now() + edgePropagationTimeoutMs;
    const observations = new Map<string, PowerEdgeObservation>();
    let pendingSnapshots = snapshots;
    let pass = 1;
    while (pendingSnapshots.length) {
      let progressWrites = Promise.resolve();
      await mapWithConcurrency(
        pendingSnapshots,
        maximumPowerEdgeVerificationConcurrency,
        async (snapshot): Promise<PowerEdgeObservation> => {
          const item = await this.edge.item(
            settings.profile.edgeEndpoint,
            settings.edgeToken,
            snapshot.itemId,
            run.language,
            signal,
          );
          if (!item || normalizeId(item.id) !== normalizeId(snapshot.itemId)) {
            return {
              evidence: [],
              divergences: [`${snapshot.path}: item not found`],
              divergentItemId: snapshot.itemId,
            };
          }
          const fields = powerExpectedFieldsForSnapshot(run, snapshot);
          const itemEvidence: string[] = [];
          const itemDivergences: string[] = [];
          for (const [fieldName, expected] of fields) {
            const actual = item.fields[fieldName];
            if (expected === undefined || actual !== expected) {
              itemDivergences.push(
                `${snapshot.path} › ${fieldName}: expected ${
                  expected === undefined ? "missing authoring value" : formatFieldValue(expected)
                }, Edge returned ${
                  actual === undefined ? "missing" : formatFieldValue(actual)
                }`,
              );
            } else {
              itemEvidence.push(`${snapshot.path} › ${fieldName}: matched`);
            }
          }
          if (!fields.length) {
            itemEvidence.push(`${snapshot.path}: item identity matched`);
          }
          return {
            evidence: itemEvidence,
            divergences: itemDivergences,
            divergentItemId: itemDivergences.length ? snapshot.itemId : undefined,
          };
        },
        (snapshot, observation, checkedThisPass) => {
          observations.set(normalizeId(snapshot.itemId), observation);
          if (
            checkedThisPass % maximumPowerEdgeVerificationConcurrency !== 0 &&
            checkedThisPass !== pendingSnapshots.length
          ) {
            return;
          }
          const matchedCount = [...observations.values()].filter((candidate) =>
            !candidate.divergentItemId
          ).length;
          const summary = pass === 1
            ? `Checked ${observations.size} of ${snapshots.length} observable item(s); ${matchedCount} matched so far.`
            : `Rechecking ${pendingSnapshots.length} unmatched item(s): ${checkedThisPass} checked; ${matchedCount} of ${snapshots.length} matched.`;
          progressWrites = progressWrites.then(async () => {
            run = await this.setPowerEdgeVerification(run, "running", summary);
          });
        },
      );
      await progressWrites;

      const divergentItemIds = pendingSnapshots
        .filter((snapshot) =>
          observations.get(normalizeId(snapshot.itemId))?.divergentItemId
        )
        .map((snapshot) => snapshot.itemId);
      if (!divergentItemIds.length) {
        const evidence = [
          ...powerEdgeEvidence(snapshots, observations, "evidence"),
          ...skippedEvidence,
        ];
        this.output.appendLine(
          `Power Publish: ${snapshots.length} observable item(s) matched on Experience Edge.`,
        );
        return this.setPowerEdgeVerification(
          run,
          "matched",
          `${snapshots.length} observable item(s) matched on Experience Edge; ${skippedEvidence.length} version-0 item(s) skipped.`,
          evidence,
        );
      }
      if (Date.now() >= deadline) {
        const divergences = [
          ...powerEdgeEvidence(snapshots, observations, "divergences"),
          ...skippedEvidence,
        ];
        run = await this.setPowerEdgeVerification(
          run,
          "diverged",
          `${divergentItemIds.length} of ${snapshots.length} observable item(s) did not match within the 30-second propagation window; ${skippedEvidence.length} version-0 item(s) skipped.`,
          divergences,
          divergentItemIds,
        );
        this.output.appendLine(
          `Power Publish: ${divergentItemIds.length} observable item(s) did not match on Experience Edge within the 30-second propagation window.`,
        );
        return run;
      }
      const matchedCount = snapshots.length - divergentItemIds.length;
      run = await this.setPowerEdgeVerification(
        run,
        "running",
        `${matchedCount} of ${snapshots.length} observable item(s) matched; waiting to recheck ${divergentItemIds.length} within 30 seconds.`,
      );
      await delay(5_000, signal);
      const divergentIds = new Set(divergentItemIds.map(normalizeId));
      pendingSnapshots = snapshots.filter((snapshot) =>
        divergentIds.has(normalizeId(snapshot.itemId))
      );
      pass += 1;
    }
    return run;
  }

  private async setPowerEdgeVerification(
    run: PublishRun,
    status: PowerPublishEdgeVerification["status"],
    summary: string,
    evidence?: readonly string[],
    divergentItemIds?: readonly string[],
  ): Promise<PublishRun> {
    const stageStatus: TraceStageStatus = status;
    const updated: PublishRun = {
      ...run,
      powerEdgeVerification: {
        status,
        summary,
        evidence,
        divergentItemIds: divergentItemIds && deduplicateIds(divergentItemIds),
      },
      stages: run.stages.map((stage) => stage.id === "edgeItem"
        ? {
            ...stage,
            status: stageStatus,
            summary,
            evidence,
            updatedAt: new Date().toISOString(),
          }
        : stage),
    };
    await this.saveRun(updated);
    this.renderIfDisplayed(updated);
    return updated;
  }

  private async setBatchProgress(
    run: PublishRun,
    batchIndex: number,
    status: NonNullable<PublishBatch["checkpointStatus"]>,
    batchSummary: string,
    stageSummary: string,
  ): Promise<PublishRun> {
    const updated: PublishRun = {
      ...run,
      batches: run.batches.map((batch, index) => index === batchIndex
        ? {
            ...batch,
            checkpointStatus: status,
            checkpointSummary: batchSummary,
          }
        : batch),
      stages: run.stages.map((stage) => stage.id === "publishing"
        ? {
            ...stage,
            status: "running",
            summary: stageSummary,
            updatedAt: new Date().toISOString(),
          }
        : stage),
    };
    await this.saveRun(updated);
    this.renderIfDisplayed(updated);
    return updated;
  }

  private async verifyEdgeItems(
    initialRun: PublishRun,
    settings: ProfileRunSettings,
    signal: AbortSignal,
  ): Promise<PublishRun> {
    const observableSnapshots = initialRun.snapshots.filter((snapshot) => snapshot.version > 0);
    const skippedEvidence = versionlessSnapshotEvidence(initialRun.snapshots, initialRun.language);
    let run = await this.setStage(
      initialRun,
      "edgeItem",
      "running",
      `Waiting up to 30 seconds for Experience Edge; ${skippedEvidence.length} version-0 item(s) skipped.`,
    );
    if (!observableSnapshots.length) {
      return this.setStage(
        run,
        "edgeItem",
        "matched",
        `No ${run.language} language-versioned items required Experience Edge verification.`,
        skippedEvidence,
      );
    }
    const deadline = Date.now() + edgePropagationTimeoutMs;
    let missing: string[] = [];
    let matches: string[] = [];
    do {
      missing = [];
      matches = [];
      for (const snapshot of observableSnapshots) {
        const expectedFields = expectedFieldsForSnapshot(run, snapshot);
        if (run.fieldSelections?.length && expectedFields.length === 0) {
          continue;
        }
        const item = await this.edge.item(
          settings.profile.edgeEndpoint,
          settings.edgeToken,
          snapshot.itemId,
          run.language,
          signal,
        );
        if (!item || normalizeId(item.id) !== normalizeId(snapshot.itemId)) {
          missing.push(`${snapshot.path}: item not found`);
          continue;
        }
        for (const [name, expected] of expectedFields) {
          const actual = item.fields[name];
          if (actual !== expected) {
            missing.push(
              `${snapshot.path} › ${name}: expected ${formatFieldValue(expected)}, Edge returned ${
                actual === undefined ? "missing" : formatFieldValue(actual)
              }`,
            );
          } else if (run.fieldSelections?.length) {
            matches.push(
              `${snapshot.path} › ${name}: ${formatFieldValue(expected)} matched`,
            );
          }
        }
      }
      if (missing.length === 0) {
        return this.setStage(
          run,
          "edgeItem",
          "matched",
          run.fieldSelections?.length
            ? `${run.fieldSelections.length} selected field value(s) reached Experience Edge.`
            : `${observableSnapshots.length} observable item snapshot(s) reached Experience Edge.`,
          [...matches, ...skippedEvidence],
        );
      }
      if (Date.now() < deadline) {
        await delay(5_000, signal);
      }
    } while (Date.now() < deadline);
    run = await this.setStage(
      run,
      "edgeItem",
      "diverged",
      "Experience Edge did not match the authoring snapshot within the 30-second propagation window.",
      [...missing, ...skippedEvidence],
    );
    return run;
  }

  private async verifyLayout(
    initialRun: PublishRun,
    settings: ProfileRunSettings,
    signal: AbortSignal,
  ): Promise<PublishRun> {
    if (!settings.route || !settings.profile.siteName) {
      return this.setStage(
        initialRun,
        "edgeLayout",
        "skipped",
        "Route or Sitecore site name was not configured.",
      );
    }
    let run = await this.setStage(
      initialRun,
      "edgeLayout",
      "running",
      `Querying ${settings.profile.siteName}${settings.route}.`,
    );
    const layout = await this.edge.renderedLayout(
      settings.profile.edgeEndpoint,
      settings.edgeToken,
      settings.profile.siteName,
      settings.route,
      run.language,
      signal,
    );
    if (!layout) {
      return this.setStage(
        run,
        "edgeLayout",
        "diverged",
        "Experience Edge did not resolve a rendered layout for the route.",
      );
    }
    const selectedFieldCount = run.fieldSelections?.length ?? 0;
    const snapshotsToInspect = selectedFieldCount
      ? run.snapshots.filter((snapshot) =>
          expectedFieldsForSnapshot(run, snapshot).length > 0
        )
      : run.snapshots;
    const layoutEvidence = snapshotsToInspect.map((snapshot) => {
      const selectedFieldNames = selectedFieldCount
        ? expectedFieldsForSnapshot(run, snapshot).map(([name]) => name)
        : undefined;
      if (
        !selectedFieldNames &&
        normalizeId(snapshot.itemId) === normalizeId(run.rootItemId) &&
        layout.itemId &&
        normalizeId(layout.itemId) === normalizeId(snapshot.itemId)
      ) {
        return {
          path: snapshot.path,
          itemId: snapshot.itemId,
          found: true,
          fieldMismatches: [] as readonly string[],
          fieldMatches: [] as readonly string[],
        };
      }
      return inspectRenderedSnapshot(layout.rendered, snapshot, selectedFieldNames);
    });
    const missingIds = layoutEvidence
      .filter((evidence) => !evidence.found)
      .map((evidence) => `${evidence.path}: item ${evidence.itemId} was not exposed in rendered data`);
    const fieldMismatches = layoutEvidence.flatMap((evidence) => evidence.fieldMismatches);
    const fieldMatches = layoutEvidence.flatMap((evidence) => evidence.fieldMatches);
    const rootMismatch = !layout.itemId
      ? ["Rendered layout did not identify its route item."]
      : settings.routeItemId && normalizeId(layout.itemId) !== normalizeId(settings.routeItemId)
        ? [`Route resolved to ${layout.itemId}, expected pre-publish route item ${settings.routeItemId}`]
        : [];
    const referenceMismatches = run.referenceEdges.flatMap((edge) => {
      const inspection = inspectRenderedReference(layout.rendered, edge);
      return inspection.sourceFound && !inspection.targetFound
        ? [`${shortId(edge.sourceItemId)} did not reference ${shortId(edge.targetItemId)} through ${edge.fieldName}`]
        : [];
    });
    const divergences = [
      ...rootMismatch,
      ...fieldMismatches,
      ...referenceMismatches,
      ...(selectedFieldCount ? missingIds : []),
    ];
    run = await this.setStage(
      run,
      "edgeLayout",
      divergences.length ? "diverged" : "matched",
      divergences.length
        ? selectedFieldCount
          ? "The rendered layout did not expose every selected field value."
          : "The rendered layout did not match every observed item and scoped field value."
        : selectedFieldCount
          ? `${selectedFieldCount} selected field value(s) matched in the rendered layout.`
          : "The rendered route identity and observable reference chains matched.",
      [...divergences, ...fieldMatches, ...(selectedFieldCount ? [] : missingIds)],
    );
    return run;
  }

  private async verifyApplication(
    initialRun: PublishRun,
    signal: AbortSignal,
  ): Promise<PublishRun> {
    if (!initialRun.applicationUrl) {
      return this.setStage(
        initialRun,
        "application",
        "skipped",
        "Application response verification was not configured.",
      );
    }
    let run = await this.setStage(
      initialRun,
      "application",
      "running",
      `Requesting ${initialRun.applicationUrl}.`,
    );
    try {
      const result = await this.edge.probeApplication(initialRun.applicationUrl, signal);
      const evidence = [
        `URL: ${initialRun.applicationUrl}`,
        `HTTP ${result.status}`,
        ...Object.entries(result.headers).map(([name, value]) => `${name}: ${value}`),
      ];
      const explicitFieldSelection = Boolean(run.fieldSelections?.length);
      const candidateValues = run.snapshots.flatMap((snapshot) =>
        expectedFieldsForSnapshot(run, snapshot)
          .filter(([, value]) => value.trim().length >= 3)
          .map(([name, value]) => ({ path: snapshot.path, name, value }))
      );
      const matchedValues = candidateValues.filter((candidate) =>
        result.body.includes(candidate.value)
      );
      const healthyStatus = result.status >= 200 && result.status < 400;
      const contentMatched = candidateValues.length === 0 ||
        (explicitFieldSelection
          ? matchedValues.length === candidateValues.length
          : matchedValues.length > 0);
      const stageStatus: TraceStageStatus = !healthyStatus
        ? "diverged"
        : contentMatched
          ? "matched"
          : "inconclusive";
      run = await this.setStage(
        run,
        "application",
        stageStatus,
        stageStatus === "matched"
          ? matchedValues.length
            ? explicitFieldSelection
              ? `The public application response contains all ${matchedValues.length} selected textual value(s).`
              : `The public application response contains ${matchedValues.length} expected value(s).`
            : "The public application response was successful; no textual assertions were available."
          : stageStatus === "inconclusive"
            ? matchedValues.length
              ? `The response was successful but exposed only ${matchedValues.length}/${candidateValues.length} selected textual value(s). Browser-rendered DOM was not evaluated.`
              : "The response was successful but did not expose the expected text in its server response. Browser-rendered DOM was not evaluated."
            : `The application returned HTTP ${result.status}.`,
        [
          ...evidence,
          ...matchedValues.slice(0, 20).map((candidate) =>
            `Matched ${candidate.path}: ${candidate.name}`
          ),
          ...(explicitFieldSelection
            ? candidateValues
                .filter((candidate) => !matchedValues.includes(candidate))
                .slice(0, 20)
                .map((candidate) =>
                  `Missing ${candidate.path} › ${candidate.name}: ${formatFieldValue(candidate.value)}`
                )
            : []),
        ],
      );
    } catch (error: unknown) {
      run = await this.setStage(
        run,
        "application",
        "failed",
        `Optional application probe failed: ${errorMessage(error)}`,
      );
    }
    return run;
  }

  private async verifyBrowserDom(
    initialRun: PublishRun,
    signal: AbortSignal,
  ): Promise<PublishRun> {
    const assertions = (initialRun.fieldSelections ?? []).flatMap(
      (selection): readonly BrowserDomAssertion[] => {
        if (!selection.browserSelector) {
          return [];
        }
        const snapshot = initialRun.snapshots.find((candidate) =>
          normalizeId(candidate.itemId) === normalizeId(selection.itemId)
        );
        const expected = snapshot?.fields[selection.fieldName];
        return snapshot && expected !== undefined
          ? [{
              itemPath: snapshot.path,
              fieldName: selection.fieldName,
              selector: selection.browserSelector,
              expected,
            }]
          : [];
      },
    );
    if (!initialRun.applicationUrl || assertions.length === 0) {
      return this.setStage(
        initialRun,
        "browserDom",
        "skipped",
        "No Browser DOM selectors were configured.",
      );
    }
    let run = await this.setStage(
      initialRun,
      "browserDom",
      "running",
      `Opening ${initialRun.applicationUrl} in an isolated headless browser.`,
    );
    try {
      const result = await verifyBrowserDom(
        initialRun.applicationUrl,
        assertions,
        signal,
      );
      const different = result.assertions.filter((assertion) =>
        assertion.status === "different"
      );
      const uncertain = result.assertions.filter((assertion) =>
        assertion.status === "missing" || assertion.status === "invalid"
      );
      const status: TraceStageStatus = different.length
        ? "diverged"
        : uncertain.length
          ? "inconclusive"
          : "matched";
      const evidence = [
        `Browser: ${result.browserChannel}`,
        `Requested URL: ${result.requestedUrl}`,
        `Final URL: ${result.finalUrl}`,
        ...result.assertions.map((assertion) => {
          const observed = assertion.observedTexts.length
            ? assertion.observedTexts.map(formatFieldValue).join(", ")
            : "none";
          return `${assertion.itemPath} › ${assertion.fieldName}: ${assertion.status}; selector ${JSON.stringify(assertion.selector)}; matches=${assertion.matchCount}; expected=${formatFieldValue(assertion.expected)}; observed=${observed}`;
        }),
      ];
      run = await this.setStage(
        run,
        "browserDom",
        status,
        status === "matched"
          ? `${assertions.length} selected field value(s) matched in the browser-rendered DOM.`
          : status === "diverged"
            ? `${different.length} selector assertion(s) found elements with different rendered text.`
            : `${uncertain.length} selector assertion(s) could not identify a browser-rendered value conclusively.`,
        evidence,
      );
    } catch (error: unknown) {
      if (isAbort(error)) {
        throw error;
      }
      run = await this.setStage(
        run,
        "browserDom",
        "failed",
        `Optional Browser DOM verification failed: ${errorMessage(error)}`,
      );
    }
    return run;
  }

  private async pollPublishing(
    connection: NonNullable<ReturnType<ConnectionStore["get"]>>,
    clientSecret: string,
    operationId: string,
    signal: AbortSignal,
    report?: (status: PublishingStatus) => Promise<void>,
  ): Promise<PublishingStatus> {
    const startedAt = Date.now();
    let previousProgress = "";
    while (Date.now() - startedAt < 30 * 60_000) {
      const status = await this.publishing.status(
        connection,
        clientSecret,
        operationId,
        signal,
      );
      this.output.appendLine(
        `Publishing ${operationId}: ${status.state}, processed=${status.processed}.`,
      );
      const progress = `${status.state}:${status.processed}`;
      if (report && progress !== previousProgress) {
        previousProgress = progress;
        await report(status);
      }
      if (status.isFailed) {
        throw new Error(`Publishing operation ${operationId} failed (${status.state}).`);
      }
      if (status.isDone) {
        return status;
      }
      await delay(Date.now() - startedAt < 60_000 ? 2_000 : 5_000, signal);
    }
    throw new Error(`Publishing operation ${operationId} did not finish within 30 minutes.`);
  }

  private async collectDiagnosticPublishSetup(
    kind: "traced" | "power",
    connection: NonNullable<ReturnType<ConnectionStore["get"]>>,
    clientSecret: string,
    root: AuthoringItemDetails,
    language: string,
    signal: AbortSignal,
  ): Promise<DiagnosticPublishSetup | undefined> {
    const prepared = await this.ensurePublishingProfile(connection.id, signal);
    if (!prepared) {
      return undefined;
    }
    const sites = await this.loadVerifiedSites(connection.id, signal);
    const selectedSiteName = canonicalSiteName(sites, prepared.profile.siteName) ??
      (sites.length === 1 ? sites[0].name : prepared.profile.siteName);
    const selectedSite = sites.find((site) => site.name === selectedSiteName);
    const initialRoute = selectedSite
      ? suggestRoute(root.path, selectedSite.rootPath)
      : suggestRoute(root.path);
    const initialApplicationUrl = prepared.profile.applicationBaseUrl
      ? new URL(
          initialRoute.replace(/^\//u, ""),
          ensureTrailingSlash(prepared.profile.applicationBaseUrl),
        ).toString()
      : undefined;
    let discoveredDetails: readonly AuthoringItemDetails[] = [root];
    const result = await showTracedPublishForm(
      this.extensionUri,
      {
        kind,
        connectionName: connection.name,
        targetHost: new URL(connection.serverUrl).hostname,
        rootPath: root.path,
        language,
        sites: sites.map((site) => ({
          name: site.name,
          rootPath: site.rootPath,
          suggestedRoute: suggestRoute(root.path, site.rootPath),
        })),
        selectedSiteName,
        route: initialRoute,
        applicationUrl: initialApplicationUrl,
        fields: tracedFieldCandidates([root], false),
      },
      async () => {
        const discovery = await this.loadStructuralDescendants(
          connection,
          clientSecret,
          root,
          signal,
        );
        discoveredDetails = discovery.details;
        if (discovery.truncated) {
          this.output.appendLine(
            `${publishKindLabel(kind)} field discovery stopped after ${maximumTracedFieldItems} structural items.`,
          );
        }
        return tracedFieldCandidates(discovery.details.slice(1), true);
      },
      signal,
    );
    if (!result) {
      return undefined;
    }
    const siteName = canonicalSiteName(sites, result.siteName) ?? result.siteName;
    const profile = {
      ...prepared.profile,
      siteName,
    };
    await this.saveProfile(profile, prepared.edgeToken);
    const fields: readonly PublishFieldSelection[] = result.fields.map((field) => ({
      itemId: field.itemId,
      fieldName: field.fieldName,
      browserSelector: field.browserSelector,
    }));
    const ownerIds = new Set(fields.map((field) => normalizeId(field.itemId)));
    const snapshots = [
      root,
      ...discoveredDetails.filter((details) =>
        normalizeId(details.itemId) !== normalizeId(root.itemId) &&
        ownerIds.has(normalizeId(details.itemId))
      ),
    ].map(snapshotFromDetails);
    return {
      options: {
        mode: result.mode,
        publishSubItems: result.publishSubItems,
        publishRelatedItems: result.publishRelatedItems,
      },
      profileSettings: {
        profile,
        edgeToken: prepared.edgeToken,
        route: result.route ? normalizeRoute(result.route) : undefined,
        routeItemId: undefined,
        applicationUrl: result.applicationUrl,
      },
      tracedFields: { snapshots, fields },
      structuralDetails: kind === "power" || result.publishSubItems
        ? discoveredDetails
        : [root],
    };
  }

  private async loadStructuralDescendants(
    connection: NonNullable<ReturnType<ConnectionStore["get"]>>,
    clientSecret: string,
    root: AuthoringItemDetails,
    signal: AbortSignal,
  ): Promise<{
    readonly details: readonly AuthoringItemDetails[];
    readonly truncated: boolean;
    readonly incompleteReasons: readonly string[];
  }> {
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Discovering fields in the selected publish tree",
        cancellable: true,
      },
      async (progress, token) => {
        const discoveryController = new AbortController();
        const forwardAbort = (): void => discoveryController.abort(signal.reason);
        signal.addEventListener("abort", forwardAbort, { once: true });
        const subscription = token.onCancellationRequested(() =>
          discoveryController.abort(new DOMException("Field discovery cancelled.", "AbortError"))
        );
        const details: AuthoringItemDetails[] = [root];
        const queue: AuthoringItemDetails[] = root.hasChildren ? [root] : [];
        let truncated = false;
        const incompleteReasons: string[] = [];
        try {
          while (queue.length > 0) {
            const parent = queue.shift();
            if (!parent) {
              break;
            }
            progress.report({
              message: `${details.length}/${maximumTracedFieldItems}: ${parent.path}`,
            });
            const level = await this.authoring.loadTreeLevel(
              connection,
              clientSecret,
              { itemId: parent.itemId },
              root.language,
              discoveryController.signal,
            );
            for (const child of level.children) {
              if (details.length >= maximumTracedFieldItems) {
                truncated = true;
                incompleteReasons.push(
                  `Structural discovery reached its ${maximumTracedFieldItems}-item safety limit.`,
                );
                queue.length = 0;
                break;
              }
              try {
                const childDetails = await this.authoring.loadItemDetails(
                  connection,
                  clientSecret,
                  child.itemId,
                  root.language,
                  discoveryController.signal,
                );
                details.push(childDetails);
                if (childDetails.hasChildren) {
                  queue.push(childDetails);
                }
              } catch (error: unknown) {
                if (discoveryController.signal.aborted) {
                  throw discoveryController.signal.reason;
                }
                this.output.appendLine(
                  `Structural field candidate ${child.path} could not be loaded: ${errorMessage(error)}`,
                );
                incompleteReasons.push(
                  `Unable to load structural item ${child.path}: ${errorMessage(error)}`,
                );
              }
            }
          }
          return { details, truncated, incompleteReasons };
        } finally {
          subscription.dispose();
          signal.removeEventListener("abort", forwardAbort);
        }
      },
    );
  }

  private async reviewCollapsedPowerScope(
    connection: NonNullable<ReturnType<ConnectionStore["get"]>>,
    clientSecret: string,
    root: AuthoringItemDetails,
    publishSubItemsThroughSitecore: boolean,
    requiredItemIds: readonly string[],
    knownStructuralDetails: readonly AuthoringItemDetails[],
    signal: AbortSignal,
  ): Promise<CollapsedScopeGraphPlan | undefined> {
    const graph = this.createCollapsedScopeGraph(
      connection,
      clientSecret,
      root,
      publishSubItemsThroughSitecore,
      knownStructuralDetails,
    );
    const result = await showPowerPublishScopeForm(
      this.extensionUri,
      graph.state(),
      (scopeId, scanSignal, report) => graph.scan(scopeId, scanSignal, report),
      (selectedScopeIds) => {
        const validation = graph.validate(selectedScopeIds);
        if (validation) {
          return validation;
        }
        const plan = graph.plan(selectedScopeIds);
        const snapshotIds = new Set(plan.snapshots.map((snapshot) => normalizeId(snapshot.itemId)));
        const missingAssertionOwner = requiredItemIds.find((itemId) =>
          !snapshotIds.has(normalizeId(itemId))
        );
        return missingAssertionOwner
          ? "A selected field assertion belongs to an item outside the selected collapsed scopes."
          : { selectedScopeIds };
      },
      signal,
    );
    if (!result) {
      return undefined;
    }
    return graph.plan(result.selectedScopeIds);
  }

  private createCollapsedScopeGraph(
    connection: NonNullable<ReturnType<ConnectionStore["get"]>>,
    clientSecret: string,
    root: AuthoringItemDetails,
    publishSubItemsThroughSitecore: boolean,
    knownStructuralDetails: readonly AuthoringItemDetails[],
  ): CollapsedScopeGraph {
    const knownDetails = new Map<string, AuthoringItemDetails>();
    for (const details of knownStructuralDetails) {
      knownDetails.set(normalizeId(details.itemId), details);
      knownDetails.set(details.path.toLocaleLowerCase(), details);
    }
    return new CollapsedScopeGraph(
      root,
      publishSubItemsThroughSitecore,
      {
        loadItem: (target, scanSignal) => {
          const cached = knownDetails.get(normalizeId(target));
          return cached
            ? Promise.resolve(cached)
            : this.authoring.loadItem(
                connection,
                clientSecret,
                target.toLocaleLowerCase().startsWith("/sitecore/")
                  ? { path: target }
                  : { itemId: target },
                root.language,
                undefined,
                scanSignal,
              );
        },
        loadChildren: async (parent, scanSignal) => {
          const level = await this.authoring.loadTreeLevel(
            connection,
            clientSecret,
            { itemId: parent.itemId },
            root.language,
            scanSignal,
          );
          const details: AuthoringItemDetails[] = [];
          for (const child of level.children) {
            const cached = knownDetails.get(normalizeId(child.itemId));
            const childDetails = cached ??
              await this.authoring.loadItemDetails(
                connection,
                clientSecret,
                child.itemId,
                root.language,
                scanSignal,
              );
            knownDetails.set(normalizeId(childDetails.itemId), childDetails);
            knownDetails.set(childDetails.path.toLocaleLowerCase(), childDetails);
            details.push(childDetails);
          }
          return details;
        },
      },
      collapsedScopeItemBudget,
      collapsedScopeReferenceBudget,
    );
  }

  private async prepareSavedPowerPlan(
    connection: NonNullable<ReturnType<ConnectionStore["get"]>>,
    clientSecret: string,
    root: AuthoringItemDetails,
    intent: PublishingIntent,
    requiredItemIds: readonly string[],
    knownStructuralDetails: readonly AuthoringItemDetails[],
    signal: AbortSignal,
    allowReview: boolean,
  ): Promise<CollapsedScopeGraphPlan> {
    const selectedScopeIds = intent.selectedCollapsedScopeIds?.map(normalizeId);
    const observedScopeIds = new Set(
      intent.observedCollapsedScopeIds?.map(normalizeId) ?? [],
    );
    if (!selectedScopeIds?.length || !observedScopeIds.size) {
      throw new PowerPublishReviewRequiredError(
        "The saved Power Publish predates reusable collapsed-scope identities.",
      );
    }
    const graph = this.createCollapsedScopeGraph(
      connection,
      clientSecret,
      root,
      intent.publishSubItems,
      knownStructuralDetails,
    );
    const report = async (): Promise<void> => undefined;
    await graph.scan(normalizeId(root.itemId), signal, report);
    const remaining = new Set(selectedScopeIds);
    remaining.delete(normalizeId(root.itemId));
    while (remaining.size) {
      const state = graph.state();
      const available = state.nodes.find((node) => remaining.has(normalizeId(node.id)));
      if (!available) {
        throw new PowerPublishReviewRequiredError(
          `Saved collapsed scope ${[...remaining][0]} is no longer reachable from the selected content.`,
        );
      }
      await graph.scan(available.id, signal, report);
      remaining.delete(normalizeId(available.id));
    }
    const state = graph.state();
    const newlyObserved = state.nodes.filter((node) =>
      (node.kind === "content" || node.kind === "media") &&
      !observedScopeIds.has(normalizeId(node.id))
    );
    if (newlyObserved.length && !allowReview) {
      throw new PowerPublishReviewRequiredError(
        `New external collapsed scope requires review: ${newlyObserved[0]!.path}`,
      );
    }
    if (newlyObserved.length) {
      const result = await showPowerPublishScopeForm(
        this.extensionUri,
        state,
        (scopeId, scanSignal, reportState) => graph.scan(scopeId, scanSignal, reportState),
        (reviewedScopeIds) => {
          const reviewedValidation = graph.validate(reviewedScopeIds);
          if (reviewedValidation) {
            return reviewedValidation;
          }
          const reviewedPlan = graph.plan(reviewedScopeIds);
          const reviewedSnapshotIds = new Set(
            reviewedPlan.snapshots.map((snapshot) => normalizeId(snapshot.itemId)),
          );
          const missingOwner = requiredItemIds.find((itemId) =>
            !reviewedSnapshotIds.has(normalizeId(itemId))
          );
          return missingOwner
            ? "A selected field assertion belongs to an item outside the selected collapsed scopes."
            : { selectedScopeIds: reviewedScopeIds };
        },
        signal,
        selectedScopeIds,
      );
      if (!result) {
        throw new DOMException("Power Publish scope review was cancelled.", "AbortError");
      }
      return graph.plan(result.selectedScopeIds);
    }
    const validation = graph.validate(selectedScopeIds);
    if (validation) {
      throw new PowerPublishReviewRequiredError(validation);
    }
    const plan = graph.plan(selectedScopeIds);
    const snapshotIds = new Set(plan.snapshots.map((snapshot) => normalizeId(snapshot.itemId)));
    const missingAssertionOwner = requiredItemIds.find((itemId) =>
      !snapshotIds.has(normalizeId(itemId))
    );
    if (missingAssertionOwner) {
      throw new PowerPublishReviewRequiredError(
        `Field assertion owner ${missingAssertionOwner} is outside the saved collapsed scopes.`,
      );
    }
    return plan;
  }

  private async collectPublishOptions(kind: PublishKind): Promise<PublishOptions | undefined> {
    const mode = await vscode.window.showQuickPick(
      [
        { label: "Smart publish", description: "Publish changed items only", mode: "SMART" as const },
        { label: "Full publish", description: "Republish the selected scope", mode: "FULL" as const },
      ],
      { title: `${publishKindLabel(kind)}: publishing mode` },
    );
    if (!mode) {
      return undefined;
    }
    if (kind === "power") {
      return { mode: mode.mode, publishSubItems: false, publishRelatedItems: false };
    }
    const scope = await vscode.window.showQuickPick(
      [
        { label: "Descendants", description: "Include structural child items", id: "descendants" },
        { label: "Related items", description: "Let Sitecore include referenced content", id: "related" },
      ],
      {
        title: `${publishKindLabel(kind)}: optional scope`,
        placeHolder: "Select optional additions, or press Enter for the selected item only",
        canPickMany: true,
      },
    );
    if (!scope) {
      return undefined;
    }
    return {
      mode: mode.mode,
      publishSubItems: scope.some((item) => item.id === "descendants"),
      publishRelatedItems: scope.some((item) => item.id === "related"),
    };
  }

  private async ensurePublishingProfile(
    connectionId: string,
    signal: AbortSignal,
  ): Promise<{
    readonly profile: PublishingSiteProfile;
    readonly edgeToken: string;
  } | undefined> {
    let profile = this.listProfiles().find((candidate) => candidate.connectionId === connectionId);
    let edgeToken = await this.connections.getEdgeToken(connectionId);
    if (profile && edgeToken) {
      return { profile, edgeToken };
    }
    const endpoint = await vscode.window.showInputBox({
      title: "Configure traced publishing (1/2)",
      prompt: "Enter the Experience Edge GraphQL endpoint.",
      value: profile?.edgeEndpoint ?? "https://edge.sitecorecloud.io/api/graphql/v1",
      ignoreFocusOut: true,
      validateInput: validateHttpsUrl,
    });
    if (endpoint === undefined) {
      return undefined;
    }
    const suppliedToken = await vscode.window.showInputBox({
      title: "Configure traced publishing (2/2)",
      prompt: edgeToken
        ? "A token is already stored for this connection. Enter a replacement, or leave empty to keep it."
        : "Enter the Experience Edge API token. It is stored with this connection in VS Code Secret Storage.",
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) =>
        value || edgeToken ? undefined : "Experience Edge token is required.",
    });
    if (suppliedToken === undefined) {
      return undefined;
    }
    edgeToken = suppliedToken || edgeToken;
    if (!edgeToken) {
      return undefined;
    }
    const tokenApproved = await this.confirmEdgeTokenScope(
      connectionId,
      endpoint.trim(),
      edgeToken,
      signal,
    );
    if (!tokenApproved) {
      return undefined;
    }
    profile = {
      connectionId,
      edgeEndpoint: endpoint.trim(),
      siteName: profile?.siteName,
      applicationBaseUrl: profile?.applicationBaseUrl,
    };
    await this.saveProfile(profile, edgeToken);
    return { profile, edgeToken };
  }

  private async selectSiteName(
    connectionId: string,
    currentSiteName: string | undefined,
    signal: AbortSignal,
  ): Promise<{ readonly siteName?: string } | undefined> {
    const sites = await this.loadVerifiedSites(connectionId, signal);
    if (sites.length === 1) {
      return { siteName: sites[0].name };
    }
    if (sites.length > 1) {
      const ordered = [...sites].sort((left, right) => {
        const leftCurrent = left.name === currentSiteName ? 0 : 1;
        const rightCurrent = right.name === currentSiteName ? 0 : 1;
        return leftCurrent - rightCurrent ||
          left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
      });
      const selected = await vscode.window.showQuickPick(
        ordered.map((site) => ({
          label: site.name,
          description: site.rootPath,
          detail: site.rootItemId ? `Root item ID: ${site.rootItemId}` : undefined,
          siteName: site.name,
        })),
        {
          title: "Traced publish: Sitecore site",
          placeHolder: "Select the site used by the route",
          matchOnDescription: true,
          matchOnDetail: true,
        },
      );
      return selected ? { siteName: selected.siteName } : undefined;
    }
    const manual = await vscode.window.showInputBox({
      title: "Traced publish: Sitecore site",
      prompt: "No configured sites were discovered. Enter the Experience Edge site name, or leave empty.",
      placeHolder: "grenadier",
      value: currentSiteName,
      ignoreFocusOut: true,
    });
    return manual === undefined ? undefined : { siteName: manual.trim() || undefined };
  }

  private async loadVerifiedSites(
    connectionId: string,
    signal: AbortSignal,
  ): Promise<readonly AuthoringSite[]> {
    let sites = this.connections.listVerifiedSites(connectionId);
    if (this.connections.hasVerifiedSiteCatalog(connectionId)) {
      return sites;
    }
    const connection = this.connections.get(connectionId);
    const clientSecret = await this.connections.getClientSecret(connectionId);
    if (!connection || !clientSecret) {
      return sites;
    }
    try {
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Discovering configured sites for ${connection.name}`,
          cancellable: false,
        },
        async () => this.authoring.testConnection(connection, clientSecret, signal),
      );
      sites = result.sites;
      await this.connections.storeVerifiedSites(connectionId, sites);
    } catch (error: unknown) {
      if (isAbort(error)) {
        throw error;
      }
      this.output.appendLine(
        `Configured-site discovery failed; allowing manual site entry: ${errorMessage(error)}`,
      );
    }
    return sites;
  }

  private async confirmEdgeTokenScope(
    connectionId: string,
    endpoint: string,
    token: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return false;
    }
    let edgeSites;
    try {
      edgeSites = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Validating Experience Edge token for ${connection.name}`,
          cancellable: false,
        },
        async () => this.edge.listSites(endpoint, token, signal),
      );
    } catch (error: unknown) {
      if (isAbort(error)) {
        throw error;
      }
      await vscode.window.showErrorMessage(
        `Experience Edge token validation failed: ${errorMessage(error)}`,
      );
      return false;
    }

    const verifiedSites = this.connections.listVerifiedSites(connectionId);
    const verifiedMatches = verifiedSites.filter((verifiedSite) =>
      edgeSites.some((edgeSite) =>
        verifiedSite.name.localeCompare(edgeSite.name, undefined, { sensitivity: "base" }) === 0 &&
        (
          !edgeSite.rootPath ||
          verifiedSite.rootPath.localeCompare(
            edgeSite.rootPath,
            undefined,
            { sensitivity: "base" },
          ) === 0
        )
      )
    );
    const hasCatalog = this.connections.hasVerifiedSiteCatalog(connectionId);
    const scopeMatches = !hasCatalog || (
      verifiedSites.length > 0 &&
      verifiedMatches.length === verifiedSites.length
    );
    const siteLines = edgeSites.slice(0, 20).map((site) =>
      [
        `• ${site.name}`,
        site.hostname ? `hostname: ${site.hostname}` : undefined,
        site.rootPath ? `root: ${site.rootPath}` : undefined,
      ].filter((value): value is string => Boolean(value)).join(" — ")
    );
    if (edgeSites.length > 20) {
      siteLines.push(`• …and ${edgeSites.length - 20} more site(s)`);
    }
    const detail = [
      `Connection: ${connection.name}`,
      `CM host: ${new URL(connection.serverUrl).hostname}`,
      `Edge endpoint: ${endpoint}`,
      "",
      `Accessible Edge sites (${edgeSites.length}):`,
      ...(siteLines.length ? siteLines : ["• No sites returned"]),
      "",
      hasCatalog
        ? `Matches verified connection sites: ${verifiedMatches.length}/${verifiedSites.length}`
        : "No verified Authoring site catalog is available for comparison.",
    ].join("\n");
    const action = scopeMatches ? "Use Token" : "Use Anyway";
    const selection = scopeMatches
      ? await vscode.window.showInformationMessage(
          "Experience Edge token is valid. Confirm the accessible sites before storing it.",
          { modal: true, detail },
          action,
        )
      : await vscode.window.showWarningMessage(
          "The token is valid, but its Edge sites do not match the sites verified for this connection.",
          { modal: true, detail },
          action,
        );
    return selection === action;
  }

  private async loadRetrySettings(
    run: PublishRun,
  ): Promise<ProfileRunSettings | undefined> {
    const profile = this.listProfiles().find((candidate) =>
      candidate.connectionId === run.connectionId
    );
    const edgeToken = await this.connections.getEdgeToken(run.connectionId);
    if (!profile || !edgeToken) {
      await vscode.window.showErrorMessage(
        "Saved Experience Edge settings are unavailable. Configure Traced Publishing before retrying.",
      );
      return undefined;
    }
    return {
      profile: {
        ...profile,
        siteName: run.siteName ?? profile.siteName,
      },
      edgeToken,
      route: run.route,
      routeItemId: run.routeItemId,
      applicationUrl: run.applicationUrl,
    };
  }

  private async confirm(
    kind: PublishKind,
    connectionName: string,
    serverUrl: string,
    root: AuthoringItemDetails,
    language: string,
    options: PublishOptions,
    itemCount: number,
  ): Promise<boolean> {
    const scope = [
      options.publishSubItems
        ? kind === "power"
          ? "Sitecore descendants for every selected scope"
          : "descendants"
        : undefined,
      options.publishRelatedItems ? "related items" : undefined,
    ].filter((value): value is string => Boolean(value));
    const selection = await vscode.window.showWarningMessage(
      [
        `${publishKindLabel(kind)} to “${connectionName}” (${new URL(serverUrl).hostname})?`,
        `${root.path} — ${root.itemId}`,
        `Language: ${language}; mode: ${options.mode}; ${
          kind === "power"
            ? options.publishSubItems
              ? `${itemCount} selected collapsed scope root(s)`
              : `${itemCount} explicit inspected item(s)`
            : `${itemCount} explicit item(s)`
        }`,
        `Additional scope: ${scope.join(", ") || "none"}`,
      ].filter((value): value is string => Boolean(value)).join("\n"),
      { modal: true },
      "Publish",
    );
    return selection === "Publish";
  }

  private async setStage(
    run: PublishRun,
    id: TraceStage["id"],
    status: TraceStageStatus,
    summary: string,
    evidence?: readonly string[],
  ): Promise<PublishRun> {
    const updated = {
      ...run,
      stages: run.stages.map((stage) => stage.id === id
        ? { ...stage, status, summary, evidence, updatedAt: new Date().toISOString() }
        : stage),
    };
    await this.saveRun(updated);
    this.renderIfDisplayed(updated);
    return updated;
  }

  private async complete(run: PublishRun, conclusion: string): Promise<PublishRun> {
    let completed: PublishRun = {
      ...run,
      conclusion,
      completedAt: new Date().toISOString(),
    };
    const journalPath = await this.writeJournal(completed);
    completed = { ...completed, journalPath };
    await this.saveRun(completed);
    this.renderIfDisplayed(completed);
    return completed;
  }

  private finishWithFailure(run: PublishRun, message: string): PublishRun {
    const activeStage = run.stages.find((stage) => stage.status === "running");
    const phase = activeStage?.id === "publishing" ? "Publishing" : "Verification";
    return {
      ...run,
      completedAt: new Date().toISOString(),
      conclusion: `${phase} failed: ${message}`,
      stages: run.stages.map((stage) => stage.status === "running"
        ? { ...stage, status: "failed", summary: message, updatedAt: new Date().toISOString() }
        : stage),
    };
  }

  private async saveRun(run: PublishRun): Promise<void> {
    const runs = [run, ...this.listRuns().filter((candidate) => candidate.id !== run.id)].slice(0, 30);
    await this.workspaceState.update(runsKey, runs);
    if (!run.completedAt) {
      const runningStage = run.stages.find((stage) => stage.status === "running");
      await this.operations.updatePublishingProgress(
        run.id,
        runningStage && runningStage.id !== "publishing" ? "verifying" : "executing",
        runningStage?.summary,
      );
    }
  }

  private listRuns(): readonly PublishRun[] {
    return readPublishRuns(this.workspaceState.get<unknown>(runsKey, []));
  }

  private listProfiles(): readonly PublishingSiteProfile[] {
    return readPublishingProfiles(this.globalState.get<unknown>(profilesKey, []));
  }

  private async saveProfile(profile: PublishingSiteProfile, token: string): Promise<void> {
    const profiles = [
      ...this.listProfiles().filter((candidate) => candidate.connectionId !== profile.connectionId),
      profile,
    ];
    await this.connections.storeEdgeToken(profile.connectionId, token);
    await this.globalState.update(profilesKey, profiles);
  }

  private async removeOrphanedProfiles(): Promise<void> {
    const connectionIds = new Set(this.connections.list().map((connection) => connection.id));
    const profiles = this.listProfiles();
    const orphaned = profiles.filter((profile) => !connectionIds.has(profile.connectionId));
    if (orphaned.length === 0) {
      return;
    }
    await Promise.all(orphaned.map((profile) =>
      this.connections.deleteEdgeToken(profile.connectionId)
    ));
    await this.globalState.update(
      profilesKey,
      profiles.filter((profile) => connectionIds.has(profile.connectionId)),
    );
  }

  private async writeJournal(run: PublishRun): Promise<string | undefined> {
    try {
      const directory = vscode.Uri.joinPath(this.globalStorageUri, "publish-journals");
      await vscode.workspace.fs.createDirectory(directory);
      const file = vscode.Uri.joinPath(directory, `${run.createdAt.replace(/[:.]/gu, "-")}-${run.id}.json`);
      await vscode.workspace.fs.writeFile(file, Buffer.from(JSON.stringify(run, null, 2), "utf8"));
      return file.fsPath;
    } catch (error: unknown) {
      this.output.appendLine(`Unable to write publish journal: ${errorMessage(error)}`);
      return undefined;
    }
  }

  private openTrace(run: PublishRun): void {
    this.operationDetails.show(
      run.id,
      (cspSource) => traceHtml(run, cspSource),
    );
  }

  private renderIfDisplayed(run: PublishRun): void {
    this.operationDetails.renderIfDisplayed(
      run.id,
      (cspSource) => traceHtml(run, cspSource),
    );
  }
}

function snapshotFromDetails(details: AuthoringItemDetails): PublishSnapshot {
  const fields: Record<string, string> = {};
  for (const field of details.fields) {
    if (!field.isStandardTemplate) {
      fields[field.name] = field.value;
    }
  }
  return {
    itemId: details.itemId,
    path: details.path,
    displayName: details.displayName,
    language: details.language,
    version: details.version,
    fields,
    references: details.fields.flatMap((field) =>
      parseReferenceField(field).itemReferences.map((reference) => reference.target)
    ),
  };
}

function tracedFieldCandidates(
  details: readonly AuthoringItemDetails[],
  descendant: boolean,
): readonly TracedPublishFieldCandidate[] {
  return details.flatMap((item) =>
    item.fields
      .filter((field) => !field.isStandardTemplate && field.value.trim().length > 0)
      .map((field) => ({
        key: `${normalizeId(item.itemId)}:${field.name.toLocaleLowerCase()}`,
        itemId: item.itemId,
        itemName: item.displayName,
        itemPath: item.path,
        fieldName: field.name,
        value: summarizeFieldValue(field.value),
        descendant,
      }))
  );
}

function canonicalSiteName(
  sites: readonly AuthoringSite[],
  requested: string | undefined,
): string | undefined {
  if (!requested) {
    return undefined;
  }
  return sites.find((site) =>
    site.name.localeCompare(requested, undefined, { sensitivity: "base" }) === 0
  )?.name;
}

interface PowerEdgeObservation {
  readonly evidence: readonly string[];
  readonly divergences: readonly string[];
  readonly divergentItemId?: string;
}

async function mapWithConcurrency<T, TResult>(
  values: readonly T[],
  maximumConcurrency: number,
  mapper: (value: T) => Promise<TResult>,
  onResult?: (value: T, result: TResult, completed: number) => void,
): Promise<readonly TResult[]> {
  const results: TResult[] = new Array(values.length);
  let nextIndex = 0;
  let completed = 0;
  const workerCount = Math.min(Math.max(1, maximumConcurrency), values.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const result = await mapper(values[index]);
      results[index] = result;
      completed += 1;
      onResult?.(values[index], result, completed);
    }
  }));
  return results;
}

function summarizeFieldValue(value: string): string {
  const singleLine = value.replace(/\s+/gu, " ").trim();
  if (!singleLine) {
    return "(empty)";
  }
  return singleLine.length > 100 ? `${singleLine.slice(0, 97)}…` : singleLine;
}

function formatFieldValue(value: string): string {
  return JSON.stringify(
    value.length > 160 ? `${value.slice(0, 157)}…` : value,
  );
}

function externalScopeReferenceEvidence(
  details: readonly AuthoringItemDetails[],
): readonly string[] {
  const scopeIds = new Set(details.map((item) => normalizeId(item.itemId)));
  const evidence = details.flatMap((item) =>
    item.fields
      .flatMap((field) =>
        parseReferenceField(field).itemReferences
          .filter((reference) => !scopeIds.has(normalizeId(reference.target)))
          .map((reference) =>
            `Outside structural scope: ${item.path} › ${field.name} references ${reference.target}`
          )
      )
  );
  const maximumEvidence = 50;
  return evidence.length > maximumEvidence
    ? [
        ...evidence.slice(0, maximumEvidence),
        `${evidence.length - maximumEvidence} additional outside-scope reference(s) omitted.`,
      ]
    : evidence;
}

function inspectRenderedSnapshot(
  rendered: string,
  snapshot: PublishSnapshot,
  selectedFieldNames?: readonly string[],
): {
  readonly path: string;
  readonly itemId: string;
  readonly found: boolean;
  readonly fieldMismatches: readonly string[];
  readonly fieldMatches: readonly string[];
} {
  let root: unknown;
  try {
    root = JSON.parse(rendered) as unknown;
  } catch {
    const found = normalizeId(rendered).includes(normalizeId(snapshot.itemId));
    return {
      path: snapshot.path,
      itemId: snapshot.itemId,
      found,
      fieldMismatches: selectedFieldNames?.map((name) =>
        `${snapshot.path} › ${name}: rendered layout data could not be inspected`
      ) ?? [],
      fieldMatches: [],
    };
  }
  const candidates: unknown[] = [];
  walkObjects(root, (value) => {
    if (Object.values(value).some((candidate) =>
      typeof candidate === "string" &&
      normalizeId(candidate) === normalizeId(snapshot.itemId)
    )) {
      candidates.push(value);
    }
  });
  if (candidates.length === 0) {
    return {
      path: snapshot.path,
      itemId: snapshot.itemId,
      found: false,
      fieldMismatches: [],
      fieldMatches: [],
    };
  }
  const actualFields = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    collectNamedFieldValues(candidate, actualFields);
  }
  const expectedFields = selectedFieldNames
    ? selectedFieldNames.map((name) => [name, snapshot.fields[name]] as const)
    : Object.entries(snapshot.fields).filter(([name]) => actualFields.has(name));
  const fieldMismatches: string[] = [];
  const fieldMatches: string[] = [];
  for (const [name, expected] of expectedFields) {
    const expectedValue = expected ?? "";
    const observedValues = actualFields.get(name);
    if (!observedValues || observedValues.size === 0) {
      fieldMismatches.push(
        `${snapshot.path} › ${name}: not observable in rendered layout; expected ${formatFieldValue(expectedValue)}`,
      );
    } else if (!observedValues.has(expectedValue)) {
      const renderedValues = [...observedValues].map(formatFieldValue).join(", ");
      fieldMismatches.push(
        `${snapshot.path} › ${name}: expected ${formatFieldValue(expectedValue)}, ` +
        `rendered layout exposed ${renderedValues} across ${candidates.length} matching object(s)`,
      );
    } else if (selectedFieldNames) {
      const observation = observedValues.size > 1
        ? ` matched among ${observedValues.size} observed values`
        : " matched";
      fieldMatches.push(
        `${snapshot.path} › ${name}: ${formatFieldValue(expectedValue)}${observation} ` +
        `across ${candidates.length} matching object(s)`,
      );
    }
  }
  return {
    path: snapshot.path,
    itemId: snapshot.itemId,
    found: candidates.length > 0,
    fieldMismatches,
    fieldMatches,
  };
}

function inspectRenderedReference(
  rendered: string,
  edge: ReferenceEdge,
): { readonly sourceFound: boolean; readonly targetFound: boolean } {
  let root: unknown;
  try {
    root = JSON.parse(rendered) as unknown;
  } catch {
    return { sourceFound: false, targetFound: false };
  }
  const sourceCandidates: Readonly<Record<string, unknown>>[] = [];
  walkObjects(root, (value) => {
    if (Object.values(value).some((candidate) =>
      typeof candidate === "string" &&
      normalizeId(candidate) === normalizeId(edge.sourceItemId)
    )) {
      sourceCandidates.push(value);
    }
  });
  return {
    sourceFound: sourceCandidates.length > 0,
    targetFound: sourceCandidates.some((candidate) =>
      normalizeId(JSON.stringify(candidate)).includes(normalizeId(edge.targetItemId))
    ),
  };
}

function walkObjects(
  value: unknown,
  visitor: (value: Readonly<Record<string, unknown>>) => void,
): void {
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      walkObjects(entry, visitor);
    }
    return;
  }
  const record = value as Readonly<Record<string, unknown>>;
  visitor(record);
  for (const entry of Object.values(record)) {
    walkObjects(entry, visitor);
  }
}

function collectNamedFieldValues(
  value: unknown,
  target: Map<string, Set<string>>,
): void {
  const add = (name: string, fieldValue: string): void => {
    const values = target.get(name) ?? new Set<string>();
    values.add(fieldValue);
    target.set(name, values);
  };
  walkObjects(value, (record) => {
    if (typeof record.name === "string" && typeof record.value === "string") {
      add(record.name, record.value);
    }
    const fields = record.fields;
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
      return;
    }
    for (const [name, field] of Object.entries(fields)) {
      if (typeof field === "string") {
        add(name, field);
      } else if (
        field &&
        typeof field === "object" &&
        !Array.isArray(field) &&
        typeof (field as Readonly<Record<string, unknown>>).value === "string"
      ) {
        add(name, (field as Readonly<Record<string, string>>).value);
      }
    }
  });
}

function initialStages(
  kind: PublishKind,
  profile: ProfileRunSettings | undefined,
  tracedFields: TracedFieldSelectionResult,
  scopeEvidence: readonly string[] = [],
): readonly TraceStage[] {
  const browserSelectorCount = tracedFields.fields.filter((field) =>
    field.browserSelector
  ).length;
  const authoringEvidence = [
    ...tracedFields.fields.flatMap((selection) => {
      const snapshot = tracedFields.snapshots.find((candidate) =>
        normalizeId(candidate.itemId) === normalizeId(selection.itemId)
      );
      const expected = snapshot?.fields[selection.fieldName];
      return snapshot && expected !== undefined
        ? [`${snapshot.path} › ${selection.fieldName}: expected ${formatFieldValue(expected)}`]
        : [];
    }),
    ...scopeEvidence,
  ];
  return [
    {
      id: "authoring",
      label: "Authoring snapshot",
      status: "matched",
      summary: tracedFields.fields.length
        ? `Snapshot captured with ${tracedFields.fields.length} selected field assertion(s).`
        : "Snapshot captured.",
      evidence: authoringEvidence,
    },
    { id: "publishing", label: "Sitecore publishing", status: "pending" },
    {
      id: "edgeItem",
      label: kind === "power" ? "Final Raw Experience Edge" : "Raw Experience Edge",
      status: kind === "standard" ? "skipped" : "pending",
      summary: kind === "standard" ? "Not requested for Standard publish." : undefined,
    },
    {
      id: "edgeLayout",
      label: "Rendered route layout",
      status: kind === "standard" || !profile?.route ? "skipped" : "pending",
      summary: kind === "standard"
        ? "Not requested for Standard publish."
        : !profile?.route
          ? "No route configured."
          : undefined,
    },
    {
      id: "application",
      label: "Application response",
      status: kind === "standard" || !profile?.applicationUrl ? "skipped" : "pending",
      summary: kind === "standard"
        ? "Not requested for Standard publish."
        : !profile?.applicationUrl
          ? "Optional verification was not configured."
          : undefined,
    },
    {
      id: "browserDom",
      label: "Browser DOM",
      status: kind === "standard" || !profile?.applicationUrl || browserSelectorCount === 0
        ? "skipped"
        : "pending",
      summary: kind === "standard"
        ? "Not requested for Standard publish."
        : !profile?.applicationUrl
          ? "Application URL was not configured."
          : browserSelectorCount === 0
            ? "No Browser DOM selectors were configured."
            : undefined,
    },
  ];
}

function classify(run: PublishRun): string {
  const stage = (id: TraceStage["id"]): TraceStage | undefined =>
    run.stages.find((candidate) => candidate.id === id);
  if (stage("edgeItem")?.status === "diverged") {
    return "Likely boundary: Sitecore publishing → Experience Edge ingestion.";
  }
  if (stage("edgeLayout")?.status === "diverged") {
    return "Likely boundary: raw Experience Edge item → rendered route layout.";
  }
  if (stage("browserDom")?.status === "diverged") {
    return "The browser found the configured element, but its rendered text differed from the selected field value.";
  }
  if (stage("browserDom")?.status === "inconclusive") {
    return "Browser DOM verification could not identify every configured selector conclusively.";
  }
  if (stage("application")?.status === "diverged") {
    return "Likely boundary: rendered Experience Edge layout → application or CDN response.";
  }
  if (stage("application")?.status === "inconclusive") {
    return stage("browserDom")?.status === "matched"
      ? "Selected values matched in the browser DOM; the server response alone was inconclusive."
      : "Rendered layout matched, but the server response did not prove what the browser rendered.";
  }
  if (run.stages.some((candidate) => candidate.status === "failed")) {
    return "Publishing completed, but an optional diagnostic stage could not be evaluated.";
  }
  return "Publishing and every configured diagnostic stage matched.";
}

function traceHtml(run: PublishRun, cspSource: string): string {
  const stageHtml = run.stages.map((stage) => {
    const evidence = stage.evidence?.length
      ? `<details><summary>Show evidence</summary><ul>${stage.evidence
          .map((line) => `<li><code>${escapeHtml(line)}</code></li>`)
          .join("")}</ul></details>`
      : "";
    const batchDetails = stage.id === "publishing"
      ? powerPublishBatchDetails(run, stage)
      : "";
    return `<section class="stage ${stage.status}">
      <span class="symbol">${stageSymbol(stage.status)}</span>
      <div><strong>${escapeHtml(stage.label)}</strong>
      ${stage.summary ? `<p>${escapeHtml(stage.summary)}</p>` : ""}
      ${evidence}${batchDetails}</div>
    </section>`;
  }).join("");
  const graph = run.referenceEdges.length
    ? `<details class="graph"><summary>Show selected-scope references</summary><ul>${run.referenceEdges
        .map((edge) =>
          `<li><code>${escapeHtml(shortId(edge.sourceItemId))}</code> → <code>${escapeHtml(shortId(edge.targetItemId))}</code> via ${escapeHtml(edge.fieldName)}</li>`
        )
        .join("")}</ul></details>`
    : "";
  const actions = traceActions(run);
  const actionHtml = actions.length
    ? `<p class="actions">${actions.map((action) =>
      `<a class="button" href="${commandHref(action.command, run.id)}">${escapeHtml(action.label)}</a>`
    ).join(" ")}</p>`
    : "";
  const attempts = run.retryAttempts?.length
    ? `<details class="attempts"><summary>Show previous attempts (${run.retryAttempts.length})</summary>${
        [...run.retryAttempts].reverse().map((attempt) =>
          `<article><strong>${escapeHtml(traceAttemptLabel(attempt.action))}</strong>
          <span> · ${escapeHtml(formatTimestamp(attempt.attemptedAt))}</span>
          ${attempt.conclusion ? `<p>${escapeHtml(attempt.conclusion)}</p>` : ""}
          <ul>${attempt.stages.map((stage) =>
            `<li>${escapeHtml(stage.label)} — ${escapeHtml(stage.status)}${
              stage.summary ? `: ${escapeHtml(stage.summary)}` : ""
            }</li>`
          ).join("")}</ul></article>`
        ).join("")
      }</details>`
    : "";
  const conclusion = run.conclusion
    ? `<aside><strong>Conclusion</strong><p>${escapeHtml(run.conclusion)}</p>${actionHtml}</aside>`
    : `<aside><strong>Publishing…</strong><p>The trace updates as each stage completes.</p></aside>`;
  return `<!doctype html><html><head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline';">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>
      body{max-width:820px;margin:0 auto;padding:28px 32px;color:var(--vscode-editor-foreground);font:13px var(--vscode-font-family)}
      h1{font-size:20px;margin:0 0 4px}.meta{color:var(--vscode-descriptionForeground);margin-bottom:24px}
      aside{padding:12px 14px;margin:0 0 18px;border-left:3px solid var(--vscode-focusBorder);background:var(--vscode-textBlockQuote-background)}
      aside p,.stage p{margin:5px 0 0}.stage{display:grid;grid-template-columns:28px 1fr;gap:6px;padding:11px 4px;border-bottom:1px solid var(--vscode-panel-border)}
      .symbol{font-size:16px}.matched .symbol{color:var(--vscode-testing-iconPassed)}.inconclusive .symbol{color:var(--vscode-editorWarning-foreground)}.diverged .symbol,.failed .symbol{color:var(--vscode-testing-iconFailed)}
      .running .symbol{color:var(--vscode-progressBar-background)}.skipped{color:var(--vscode-descriptionForeground)}
      details{margin-top:8px}summary{color:var(--vscode-textLink-foreground);cursor:pointer}.graph{margin-top:18px}
      .actions{margin-top:12px}.button{display:inline-block;padding:5px 10px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);text-decoration:none;border-radius:2px}
      .button:hover{background:var(--vscode-button-hoverBackground)}.attempts{margin-top:18px}.attempts article{padding:10px 0;border-bottom:1px solid var(--vscode-panel-border)}.attempts article p{margin:5px 0}
      code{font-family:var(--vscode-editor-font-family);font-size:12px}li{margin:5px 0}
    </style></head><body>
    <h1>${escapeHtml(run.rootPath)}</h1>
    <div class="meta">${escapeHtml(publishKindLabel(run.kind))} · ${escapeHtml(run.connectionName)} · ${escapeHtml(run.language)}</div>
    ${conclusion}${stageHtml}${attempts}${graph}
  </body></html>`;
}

function powerPublishBatchDetails(run: PublishRun, stage: TraceStage): string {
  if (run.kind !== "power") {
    return "";
  }
  const expanded = stage.status === "running" ? " open" : "";
  return `<details class="batches"${expanded}><summary>Show Power Publish batches (${run.batches.length})</summary><ul>${
    run.batches.map((batch) =>
      `<li><strong>${escapeHtml(batch.label)}</strong> — ${escapeHtml(
        powerPublishBatchStatus(batch, stage),
      )}${batch.checkpointSummary ? `: ${escapeHtml(batch.checkpointSummary)}` : ""}${
        batch.checkpointEvidence?.length
          ? `<ul>${batch.checkpointEvidence.map((line) =>
              `<li><code>${escapeHtml(line)}</code></li>`
            ).join("")}</ul>`
          : ""
      }</li>`
    ).join("")
  }</ul></details>`;
}

function powerPublishBatchStatus(batch: PublishBatch, stage: TraceStage): string {
  switch (batch.checkpointStatus) {
    case "pending": return "not started";
    case "running": return batch.operationId ? "in progress" : "submitting";
    case "matched": return "completed";
    case "diverged": return "diverged";
    default:
      return batch.operationId
        ? stage.status === "matched"
          ? "completed"
          : "submitted"
        : "not started";
  }
}

function traceActions(
  run: PublishRun,
): readonly { readonly command: string; readonly label: string }[] {
  if (isAbandonedRun(run)) {
    return [run.batches.some((batch) => batch.operationId)
      ? { command: recheckStatusCommand, label: "Check status again" }
      : { command: republishTraceCommand, label: "Publish again…" }];
  }
  const publishingStatus = run.stages.find((stage) => stage.id === "publishing")?.status;
  if (
    publishingStatus === "failed" ||
    publishingStatus === "diverged" ||
    (
      publishingStatus !== "matched" &&
      run.conclusion?.startsWith("Publishing failed:")
    )
  ) {
    return [{ command: republishTraceCommand, label: "Publish again…" }];
  }
  const diagnosticStages = run.stages.filter((stage) =>
    diagnosticStageIds.includes(stage.id as typeof diagnosticStageIds[number])
  );
  const retryableDiagnostic = diagnosticStages.find((stage) =>
    stage.status === "failed" || stage.status === "diverged"
  ) ?? diagnosticStages.find((stage) =>
    stage.status === "inconclusive"
  );
  const actions: Array<{ readonly command: string; readonly label: string }> = [];
  if (retryableDiagnostic) {
    actions.push({
        command: retryVerificationCommand,
        label: retryableDiagnostic.id === "browserDom"
          ? "Retry Browser DOM"
          : run.kind === "power" && retryableDiagnostic.id === "edgeItem"
            ? "Retry final Edge verification"
          : retryableDiagnostic.status === "inconclusive"
            ? "Retry application response"
            : "Retry failed verification",
      });
  }
  if (
    run.kind === "power" &&
    run.powerEdgeVerification?.status === "diverged" &&
    run.powerEdgeVerification.divergentItemIds?.length
  ) {
    actions.push({
      command: repairPowerPublishCommand,
      label: "Force republish missing items",
    });
  }
  return actions;
}

function commandHref(command: string, runId: string): string {
  return `command:${command}?${encodeURIComponent(JSON.stringify([runId]))}`;
}

function traceAttemptLabel(action: PublishTraceAttempt["action"]): string {
  return action === "verificationRetry" ? "Verification retry" : "Publish status re-check";
}

function formatTimestamp(value: string): string {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? value : timestamp.toLocaleString();
}

function isAbandonedRun(run: PublishRun): boolean {
  return run.conclusion?.startsWith("Local tracking was abandoned by the user.") === true;
}

function stageSymbol(status: TraceStageStatus): string {
  switch (status) {
    case "matched": return "✓";
    case "inconclusive": return "?";
    case "diverged":
    case "failed": return "✗";
    case "running": return "◌";
    case "pending": return "○";
    case "skipped": return "–";
  }
}

function publishKindLabel(kind: PublishKind): string {
  switch (kind) {
    case "standard": return "Standard publish";
    case "traced": return "Traced publish";
    case "power": return "Power publish";
  }
}

function publishingProgressSummary(status: PublishingStatus): string {
  return `${status.state.toLocaleLowerCase()} · ${status.processed} item(s) processed.`;
}

function powerEdgeEvidence(
  snapshots: readonly PublishSnapshot[],
  observations: ReadonlyMap<string, PowerEdgeObservation>,
  kind: "evidence" | "divergences",
): readonly string[] {
  return snapshots.flatMap((snapshot) =>
    observations.get(normalizeId(snapshot.itemId))?.[kind] ?? []
  );
}

function normalizeId(value: string): string {
  return value.replace(/[{}-]/gu, "").toLowerCase();
}

function normalizeRoute(value: string): string {
  const route = value.trim().replace(/\\/gu, "/").replace(/\/{2,}/gu, "/");
  return route.startsWith("/") ? route : `/${route}`;
}

function suggestRoute(itemPath: string, siteRootPath?: string): string {
  const itemSegments = pathSegments(itemPath);
  const rootSegments = siteRootPath ? pathSegments(siteRootPath) : [];
  const belongsToSite = rootSegments.length > 0 &&
    itemSegments.length >= rootSegments.length &&
    rootSegments.every((segment, index) =>
      segment.localeCompare(itemSegments[index], undefined, { sensitivity: "base" }) === 0
    );
  let routeSegments = belongsToSite
    ? itemSegments.slice(rootSegments.length)
    : itemSegments.slice(-1);
  let homeIndex = -1;
  for (let index = routeSegments.length - 1; index >= 0; index -= 1) {
    if (routeSegments[index].localeCompare("home", undefined, { sensitivity: "base" }) === 0) {
      homeIndex = index;
      break;
    }
  }
  if (homeIndex >= 0) {
    routeSegments = routeSegments.slice(homeIndex + 1);
  }
  const localDataIndex = routeSegments.findIndex((segment) =>
    segment.localeCompare("data", undefined, { sensitivity: "base" }) === 0
  );
  if (localDataIndex > 0) {
    routeSegments = routeSegments.slice(0, localDataIndex);
  }
  const slugSegments = routeSegments.map(slugSegment).filter(Boolean);
  return slugSegments.length ? `/${slugSegments.join("/")}` : "/";
}

function pathSegments(value: string): readonly string[] {
  return value.trim().replace(/\\/gu, "/").split("/").filter(Boolean);
}

function slugSegment(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Mark}+/gu, "")
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function shortId(value: string): string {
  return value.replace(/[{}]/gu, "").slice(0, 8);
}

function validateHttpsUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" ? undefined : "URL must use HTTPS.";
  } catch {
    return "Enter a valid HTTPS URL.";
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
