import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { ConnectionStore } from "../connections/connectionStore";
import type {
  AuthoringContentClient,
  AuthoringItemDetails,
  AuthoringItemField,
  AuthoringSite,
} from "../sitecore/authoringClient";
import { ExperienceEdgeClient } from "../sitecore/experienceEdgeClient";
import { PublishingClient, type PublishingStatus } from "../sitecore/publishingClient";
import type { TransferQueueStore } from "../transfers/transferQueueStore";
import {
  verifyBrowserDom,
  type BrowserDomAssertion,
} from "./browserDomVerifier";
import type {
  PublishKind,
  PublishFieldSelection,
  PublishMode,
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
const maximumReferenceItems = 50;
const maximumReferenceDepth = 8;
const maximumTracedFieldItems = 200;
const retryVerificationCommand = "xmCloudSync.retryPublishTraceVerification";
const republishTraceCommand = "xmCloudSync.republishTrace";
const recheckStatusCommand = "xmCloudSync.recheckPublishTraceStatus";
const diagnosticStageIds = ["edgeItem", "edgeLayout", "application", "browserDom"] as const;

interface PublishOptions {
  readonly mode: PublishMode;
  readonly publishSubItems: boolean;
  readonly publishRelatedItems: boolean;
}

interface GraphBuildResult {
  readonly snapshots: readonly PublishSnapshot[];
  readonly edges: readonly ReferenceEdge[];
  readonly orderedItemIds: readonly string[];
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

interface TracedPublishSetup {
  readonly options: PublishOptions;
  readonly profileSettings: ProfileRunSettings;
  readonly tracedFields: TracedFieldSelectionResult;
}

export class PublishingManager implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private displayedRunId: string | undefined;
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
      if (kind === "traced") {
        const setup = await this.collectTracedPublishSetup(
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
      } else {
        const collectedOptions = await this.collectPublishOptions(kind);
        if (!collectedOptions) {
          return;
        }
        options = collectedOptions;
      }

      const graph = kind === "power"
        ? await this.buildObservedGraph(connection, clientSecret, rootDetails, controller.signal)
        : {
            snapshots: [snapshotFromDetails(rootDetails)],
            edges: [],
            orderedItemIds: [rootDetails.itemId],
          };
      const selectedIds = kind === "power"
        ? await this.reviewPowerPlan(graph, rootDetails.itemId)
        : graph.orderedItemIds;
      if (!selectedIds) {
        return;
      }

      if (kind === "power") {
        profileSettings = await this.collectProfileSettings(
          target.connectionId,
          rootDetails.path,
          controller.signal,
        );
      }
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
        ? selectedIds.map((itemId, index) => ({
            itemIds: [itemId],
            label: `Dependency batch ${index + 1}/${selectedIds.length}`,
          }))
        : [{ itemIds: [rootDetails.itemId], label: publishKindLabel(kind) }];
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
        publishSubItems: kind === "power" ? false : options.publishSubItems,
        publishRelatedItems: kind === "power" ? false : options.publishRelatedItems,
        createdAt: new Date().toISOString(),
        snapshots: kind === "traced"
          ? tracedFields.snapshots
          : graph.snapshots.filter((snapshot) =>
              selectedIds.some((itemId) => normalizeId(itemId) === normalizeId(snapshot.itemId))
            ),
        fieldSelections: tracedFields.fields.length ? tracedFields.fields : undefined,
        referenceEdges: graph.edges.filter((edge) =>
          selectedIds.some((itemId) => normalizeId(itemId) === normalizeId(edge.sourceItemId)) &&
          selectedIds.some((itemId) => normalizeId(itemId) === normalizeId(edge.targetItemId))
        ),
        batches,
        stages: initialStages(kind, profileSettings, tracedFields),
        route: profileSettings?.route,
        routeItemId: profileSettings?.routeItemId,
        siteName: profileSettings?.profile.siteName,
        applicationUrl: profileSettings?.applicationUrl,
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
    let run = prepareDiagnosticRetry(original, firstFailedStage);
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
              run = await this.verifyEdgeItems(run, settings, controller.signal);
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
      const failed = finishRetryWithFailure(run, "Verification retry failed", errorMessage(error));
      await this.saveRun(failed);
      this.renderIfDisplayed(failed);
      await vscode.window.showErrorMessage(
        failed.conclusion ?? "Verification retry failed.",
      );
    } finally {
      this.controllers.delete(run.id);
    }
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
    let run = prepareStatusRecheck(original);
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
      const failed = finishRetryWithFailure(run, "Publish status check failed", errorMessage(error));
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
    this.panel?.dispose();
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
          candidateIndex === index ? { ...candidate, operationId } : candidate
        ),
      };
      await this.saveRun(run);
      const status = await this.pollPublishing(connection, clientSecret, operationId, signal);
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
    run = await this.verifyEdgeItems(run, profileSettings, signal);
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
    for (let index = 0; index < run.batches.length; index += 1) {
      let batch = run.batches[index];
      if (!batch.operationId) {
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
            candidateIndex === index ? { ...candidate, operationId } : candidate
          ),
        };
        await this.saveRun(run);
        batch = run.batches[index];
      }
      if (batch.operationId) {
        await this.pollPublishing(connection, clientSecret, batch.operationId, signal);
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
    const profile = this.listProfiles().find((candidate) =>
      candidate.connectionId === run.connectionId
    );
    const edgeToken = await this.connections.getEdgeToken(run.connectionId);
    if (!profile || !edgeToken) {
      await this.complete(
        run,
        "Publishing completed after restart, but saved Experience Edge settings were unavailable.",
      );
      return;
    }
    const settings = {
      profile,
      edgeToken,
      route: run.route,
      routeItemId: run.routeItemId,
      applicationUrl: run.applicationUrl,
    };
    run = await this.verifyEdgeItems(run, settings, signal);
    run = await this.verifyLayout(run, settings, signal);
    run = await this.verifyApplication(run, signal);
    run = await this.verifyBrowserDom(run, signal);
    await this.complete(run, classify(run));
  }

  private async verifyEdgeItems(
    initialRun: PublishRun,
    settings: ProfileRunSettings,
    signal: AbortSignal,
  ): Promise<PublishRun> {
    let run = await this.setStage(initialRun, "edgeItem", "running", "Waiting for Experience Edge.");
    const deadline = Date.now() + 5 * 60_000;
    let missing: string[] = [];
    let matches: string[] = [];
    do {
      missing = [];
      matches = [];
      for (const snapshot of run.snapshots) {
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
            : `${run.snapshots.length} expected item snapshot(s) reached Experience Edge.`,
          matches,
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
      "Experience Edge did not match the authoring snapshot before timeout.",
      missing,
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
  ): Promise<PublishingStatus> {
    const startedAt = Date.now();
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

  private async collectTracedPublishSetup(
    connection: NonNullable<ReturnType<ConnectionStore["get"]>>,
    clientSecret: string,
    root: AuthoringItemDetails,
    language: string,
    signal: AbortSignal,
  ): Promise<TracedPublishSetup | undefined> {
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
            `Traced field discovery stopped after ${maximumTracedFieldItems} structural items.`,
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
              }
            }
          }
          return { details, truncated };
        } finally {
          subscription.dispose();
          signal.removeEventListener("abort", forwardAbort);
        }
      },
    );
  }

  private async buildObservedGraph(
    connection: NonNullable<ReturnType<ConnectionStore["get"]>>,
    clientSecret: string,
    root: AuthoringItemDetails,
    signal: AbortSignal,
  ): Promise<GraphBuildResult> {
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Building observed reference graph",
        cancellable: true,
      },
      async (progress, token) => {
        const graphController = new AbortController();
        const forwardAbort = (): void => graphController.abort(signal.reason);
        signal.addEventListener("abort", forwardAbort, { once: true });
        const subscription = token.onCancellationRequested(() =>
          graphController.abort(new DOMException("Reference discovery cancelled.", "AbortError"))
        );
        try {
          const detailsById = new Map<string, AuthoringItemDetails>();
          const edges: ReferenceEdge[] = [];
          const queue: Array<{ readonly details: AuthoringItemDetails; readonly depth: number }> = [
            { details: root, depth: 0 },
          ];
          while (queue.length > 0 && detailsById.size < maximumReferenceItems) {
            const current = queue.shift();
            if (!current) {
              break;
            }
            const currentId = normalizeId(current.details.itemId);
            if (detailsById.has(currentId)) {
              continue;
            }
            detailsById.set(currentId, current.details);
            progress.report({ message: current.details.path });
            if (current.depth >= maximumReferenceDepth) {
              continue;
            }
            for (const field of current.details.fields.filter(isReferenceField)) {
              for (const targetId of extractItemIds(field.value)) {
                edges.push({
                  sourceItemId: current.details.itemId,
                  targetItemId: targetId,
                  fieldName: field.name,
                });
                if (detailsById.has(normalizeId(targetId))) {
                  continue;
                }
                try {
                  const details = await this.authoring.loadItemDetails(
                    connection,
                    clientSecret,
                    targetId,
                    root.language,
                    graphController.signal,
                  );
                  queue.push({ details, depth: current.depth + 1 });
                } catch (error: unknown) {
                  if (graphController.signal.aborted) {
                    throw graphController.signal.reason;
                  }
                  this.output.appendLine(
                    `Observed reference ${targetId} from ${current.details.path} could not be loaded: ${errorMessage(error)}`,
                  );
                }
              }
            }
          }
          const orderedItemIds = dependencyOrder(root.itemId, detailsById, edges);
          return {
            snapshots: [...detailsById.values()].map(snapshotFromDetails),
            edges,
            orderedItemIds,
          };
        } finally {
          subscription.dispose();
          signal.removeEventListener("abort", forwardAbort);
        }
      },
    );
  }

  private async reviewPowerPlan(
    graph: GraphBuildResult,
    rootItemId: string,
  ): Promise<readonly string[] | undefined> {
    const byId = new Map(graph.snapshots.map((snapshot) => [normalizeId(snapshot.itemId), snapshot]));
    const selected = await vscode.window.showQuickPick(
      graph.orderedItemIds.map((itemId, index) => {
        const snapshot = byId.get(normalizeId(itemId));
        return {
          label: `${index + 1}. ${snapshot?.displayName ?? itemId}`,
          description: normalizeId(itemId) === normalizeId(rootItemId)
            ? "Route/root item — published last"
            : snapshot?.path,
          detail: itemId,
          itemId,
          picked: true,
        };
      }),
      {
        title: "Power publish: review observed dependency order",
        placeHolder: "Dependencies publish first; the selected root publishes last",
        canPickMany: true,
        matchOnDescription: true,
        matchOnDetail: true,
      },
    );
    if (!selected) {
      return undefined;
    }
    const selectedIds = graph.orderedItemIds.filter((itemId) =>
      selected.some((choice) => normalizeId(choice.itemId) === normalizeId(itemId))
    );
    if (!selectedIds.some((itemId) => normalizeId(itemId) === normalizeId(rootItemId))) {
      selectedIds.push(rootItemId);
    }
    return selectedIds;
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

  private async collectProfileSettings(
    connectionId: string,
    itemPath: string,
    signal: AbortSignal,
  ): Promise<ProfileRunSettings | undefined> {
    const prepared = await this.ensurePublishingProfile(connectionId, signal);
    if (!prepared) {
      return undefined;
    }
    let profile = prepared.profile;
    const edgeToken = prepared.edgeToken;
    const siteSelection = await this.selectSiteName(connectionId, profile.siteName, signal);
    if (!siteSelection) {
      return undefined;
    }
    profile = { ...profile, siteName: siteSelection.siteName };
    await this.saveProfile(profile, edgeToken);
    let route = "";
    if (profile.siteName) {
      const selectedSite = this.connections.listVerifiedSites(connectionId).find((site) =>
        site.name.localeCompare(profile.siteName as string, undefined, {
          sensitivity: "base",
        }) === 0
      );
      const suggestedRoute = suggestRoute(itemPath, selectedSite?.rootPath);
      const selectedRoute = await vscode.window.showInputBox({
        title: "Traced publish: route verification",
        prompt:
          `Confirm the suggested Sitecore route for “${profile.siteName}”, change it if needed, or leave it empty to skip route verification.`,
        placeHolder: "/station-wagon",
        value: suggestedRoute,
        ignoreFocusOut: true,
      });
      if (selectedRoute === undefined) {
        return undefined;
      }
      route = selectedRoute;
    }
    const defaultApplicationUrl = profile.applicationBaseUrl && route.trim()
      ? new URL(route.trim().replace(/^\//u, ""), ensureTrailingSlash(profile.applicationBaseUrl)).toString()
      : profile.applicationBaseUrl;
    const applicationUrl = await vscode.window.showInputBox({
      title: "Traced publish: optional application response",
      prompt: "Enter a public application URL to verify, or leave empty. No Vercel credentials are needed.",
      value: defaultApplicationUrl,
      ignoreFocusOut: true,
      validateInput: (value) => value.trim() ? validateHttpsUrl(value) : undefined,
    });
    if (applicationUrl === undefined) {
      return undefined;
    }
    return {
      profile,
      edgeToken,
      route: route.trim() ? normalizeRoute(route) : undefined,
      routeItemId: undefined,
      applicationUrl: applicationUrl.trim() || undefined,
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
      options.publishSubItems ? "descendants" : undefined,
      options.publishRelatedItems ? "related items" : undefined,
    ].filter((value): value is string => Boolean(value));
    const selection = await vscode.window.showWarningMessage(
      [
        `${publishKindLabel(kind)} to “${connectionName}” (${new URL(serverUrl).hostname})?`,
        `${root.path} — ${root.itemId}`,
        `Language: ${language}; mode: ${options.mode}; ${itemCount} explicit item(s)`,
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
    const value = this.workspaceState.get<unknown>(runsKey, []);
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter(isPublishRun).sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt)
    );
  }

  private listProfiles(): readonly PublishingSiteProfile[] {
    const value = this.globalState.get<unknown>(profilesKey, []);
    return Array.isArray(value)
      ? value.filter(isPublishingProfile)
      : [];
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
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        "xmCloudSync.publishTrace",
        "Operation Details",
        vscode.ViewColumn.Active,
        {
          enableScripts: false,
          retainContextWhenHidden: true,
          enableCommandUris: [
            retryVerificationCommand,
            republishTraceCommand,
            recheckStatusCommand,
          ],
        },
      );
      this.panel.iconPath = vscode.Uri.joinPath(this.extensionUri, "media", "sitecore-xm-cloud-sync.svg");
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.displayedRunId = undefined;
      });
    } else {
      this.panel.reveal(vscode.ViewColumn.Active);
    }
    this.displayedRunId = run.id;
    this.panel.webview.html = traceHtml(run, this.panel.webview.cspSource);
  }

  private renderIfDisplayed(run: PublishRun): void {
    if (this.panel && this.displayedRunId === run.id) {
      this.panel.webview.html = traceHtml(run, this.panel.webview.cspSource);
    }
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
    references: details.fields.filter(isReferenceField).flatMap((field) => extractItemIds(field.value)),
  };
}

function tracedFieldCandidates(
  details: readonly AuthoringItemDetails[],
  descendant: boolean,
): readonly TracedPublishFieldCandidate[] {
  return details.flatMap((item) =>
    item.fields
      .filter((field) => !field.isStandardTemplate)
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

function prepareDiagnosticRetry(
  run: PublishRun,
  firstStage: typeof diagnosticStageIds[number],
): PublishRun {
  const firstIndex = diagnosticStageIds.indexOf(firstStage);
  const attemptedAt = new Date().toISOString();
  return {
    ...archiveTraceAttempt(run, "verificationRetry", attemptedAt),
    completedAt: undefined,
    conclusion: undefined,
    journalPath: undefined,
    stages: run.stages.map((stage) => {
      const diagnosticIndex = diagnosticStageIds.indexOf(
        stage.id as typeof diagnosticStageIds[number],
      );
      if (diagnosticIndex < firstIndex) {
        return stage;
      }
      if (stage.id === "edgeLayout" && (!run.route || !run.siteName)) {
        return {
          ...stage,
          status: "skipped",
          summary: "Route or Sitecore site name was not configured.",
          evidence: undefined,
          updatedAt: attemptedAt,
        };
      }
      if (stage.id === "application" && !run.applicationUrl) {
        return {
          ...stage,
          status: "skipped",
          summary: "Application response verification was not configured.",
          evidence: undefined,
          updatedAt: attemptedAt,
        };
      }
      if (
        stage.id === "browserDom" &&
        (!run.applicationUrl || !hasBrowserDomAssertions(run))
      ) {
        return {
          ...stage,
          status: "skipped",
          summary: "No Browser DOM selectors were configured.",
          evidence: undefined,
          updatedAt: attemptedAt,
        };
      }
      return {
        ...stage,
        status: "pending",
        summary: "Queued for verification retry.",
        evidence: undefined,
        updatedAt: attemptedAt,
      };
    }),
  };
}

function prepareStatusRecheck(run: PublishRun): PublishRun {
  const attemptedAt = new Date().toISOString();
  return {
    ...archiveTraceAttempt(run, "statusRecheck", attemptedAt),
    completedAt: undefined,
    conclusion: undefined,
    journalPath: undefined,
    stages: run.stages.map((stage) => {
      if (stage.id === "publishing") {
        return {
          ...stage,
          status: "running",
          summary: "Checking saved XM Cloud publishing operation IDs.",
          evidence: undefined,
          updatedAt: attemptedAt,
        };
      }
      if (diagnosticStageIds.includes(stage.id as typeof diagnosticStageIds[number])) {
        if (run.kind === "standard") {
          return {
            ...stage,
            status: "skipped",
            summary: "Not requested for Standard publish.",
            evidence: undefined,
            updatedAt: attemptedAt,
          };
        }
        if (stage.id === "edgeLayout" && (!run.route || !run.siteName)) {
          return {
            ...stage,
            status: "skipped",
            summary: "Route or Sitecore site name was not configured.",
            evidence: undefined,
            updatedAt: attemptedAt,
          };
        }
        if (stage.id === "application" && !run.applicationUrl) {
          return {
            ...stage,
            status: "skipped",
            summary: "Application response verification was not configured.",
            evidence: undefined,
            updatedAt: attemptedAt,
          };
        }
        if (
          stage.id === "browserDom" &&
          (!run.applicationUrl || !hasBrowserDomAssertions(run))
        ) {
          return {
            ...stage,
            status: "skipped",
            summary: "No Browser DOM selectors were configured.",
            evidence: undefined,
            updatedAt: attemptedAt,
          };
        }
        return {
          ...stage,
          status: "pending",
          summary: "Waiting for publishing status re-check.",
          evidence: undefined,
          updatedAt: attemptedAt,
        };
      }
      return stage;
    }),
  };
}

function archiveTraceAttempt(
  run: PublishRun,
  action: PublishTraceAttempt["action"],
  attemptedAt: string,
): PublishRun {
  const attempt: PublishTraceAttempt = {
    attemptedAt,
    action,
    conclusion: run.conclusion,
    stages: run.stages,
  };
  return {
    ...run,
    retryAttempts: [...(run.retryAttempts ?? []), attempt].slice(-10),
  };
}

function finishRetryWithFailure(
  run: PublishRun,
  label: string,
  message: string,
): PublishRun {
  const completedAt = new Date().toISOString();
  return {
    ...run,
    completedAt,
    conclusion: `${label}: ${message}`,
    stages: run.stages.map((stage) => stage.status === "running"
      ? { ...stage, status: "failed", summary: message, updatedAt: completedAt }
      : stage),
  };
}

function hasBrowserDomAssertions(run: PublishRun): boolean {
  return run.fieldSelections?.some((field) => Boolean(field.browserSelector)) === true;
}

function expectedFieldsForSnapshot(
  run: PublishRun,
  snapshot: PublishSnapshot,
): readonly (readonly [string, string])[] {
  if (!run.fieldSelections?.length) {
    return Object.entries(snapshot.fields).filter(([, expected]) => expected.length > 0);
  }
  return run.fieldSelections
    .filter((field) => normalizeId(field.itemId) === normalizeId(snapshot.itemId))
    .map((field) => [field.fieldName, snapshot.fields[field.fieldName] ?? ""] as const);
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

function isReferenceField(field: AuthoringItemField): boolean {
  const type = `${field.type} ${field.typeKey}`.toLowerCase();
  return ["droplink", "droptree", "multilist", "treelist", "general link", "image", "layout", "tree list"]
    .some((token) => type.includes(token));
}

function extractItemIds(value: string): readonly string[] {
  const matches = value.match(
    /\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?/giu,
  ) ?? [];
  return [...new Map(matches.map((match) => [normalizeId(match), match])).values()];
}

function dependencyOrder(
  rootItemId: string,
  detailsById: ReadonlyMap<string, AuthoringItemDetails>,
  edges: readonly ReferenceEdge[],
): readonly string[] {
  const bySource = new Map<string, string[]>();
  for (const edge of edges) {
    const source = normalizeId(edge.sourceItemId);
    const targets = bySource.get(source) ?? [];
    targets.push(edge.targetItemId);
    bySource.set(source, targets);
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const ordered: string[] = [];
  const visit = (itemId: string): void => {
    const normalized = normalizeId(itemId);
    if (visited.has(normalized) || visiting.has(normalized) || !detailsById.has(normalized)) {
      return;
    }
    visiting.add(normalized);
    for (const targetId of bySource.get(normalized) ?? []) {
      visit(targetId);
    }
    visiting.delete(normalized);
    visited.add(normalized);
    ordered.push(detailsById.get(normalized)?.itemId ?? itemId);
  };
  visit(rootItemId);
  for (const details of detailsById.values()) {
    visit(details.itemId);
  }
  const rootIndex = ordered.findIndex((itemId) => normalizeId(itemId) === normalizeId(rootItemId));
  if (rootIndex >= 0) {
    const [root] = ordered.splice(rootIndex, 1);
    ordered.push(root);
  }
  return ordered;
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
  const actualFields = new Map<string, string>();
  for (const candidate of candidates) {
    collectNamedFieldValues(candidate, actualFields);
  }
  const expectedFields = selectedFieldNames
    ? selectedFieldNames.map((name) => [name, snapshot.fields[name]] as const)
    : Object.entries(snapshot.fields).filter(([name]) => actualFields.has(name));
  const fieldMismatches: string[] = [];
  const fieldMatches: string[] = [];
  for (const [name, expected] of expectedFields) {
    const actual = actualFields.get(name);
    if (actual === undefined) {
      fieldMismatches.push(
        `${snapshot.path} › ${name}: not observable in rendered layout; expected ${formatFieldValue(expected ?? "")}`,
      );
    } else if (actual !== expected) {
      fieldMismatches.push(
        `${snapshot.path} › ${name}: expected ${formatFieldValue(expected ?? "")}, rendered layout returned ${formatFieldValue(actual)}`,
      );
    } else if (selectedFieldNames) {
      fieldMatches.push(
        `${snapshot.path} › ${name}: ${formatFieldValue(expected ?? "")} matched`,
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

function collectNamedFieldValues(value: unknown, target: Map<string, string>): void {
  walkObjects(value, (record) => {
    if (typeof record.name === "string" && typeof record.value === "string") {
      target.set(record.name, record.value);
    }
    const fields = record.fields;
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
      return;
    }
    for (const [name, field] of Object.entries(fields)) {
      if (typeof field === "string") {
        target.set(name, field);
      } else if (
        field &&
        typeof field === "object" &&
        !Array.isArray(field) &&
        typeof (field as Readonly<Record<string, unknown>>).value === "string"
      ) {
        target.set(name, (field as Readonly<Record<string, string>>).value);
      }
    }
  });
}

function initialStages(
  kind: PublishKind,
  profile: ProfileRunSettings | undefined,
  tracedFields: TracedFieldSelectionResult,
): readonly TraceStage[] {
  const browserSelectorCount = tracedFields.fields.filter((field) =>
    field.browserSelector
  ).length;
  const authoringEvidence = tracedFields.fields.flatMap((selection) => {
    const snapshot = tracedFields.snapshots.find((candidate) =>
      normalizeId(candidate.itemId) === normalizeId(selection.itemId)
    );
    const expected = snapshot?.fields[selection.fieldName];
    return snapshot && expected !== undefined
      ? [`${snapshot.path} › ${selection.fieldName}: expected ${formatFieldValue(expected)}`]
      : [];
  });
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
      label: "Raw Experience Edge",
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
    return `<section class="stage ${stage.status}">
      <span class="symbol">${stageSymbol(stage.status)}</span>
      <div><strong>${escapeHtml(stage.label)}</strong>
      ${stage.summary ? `<p>${escapeHtml(stage.summary)}</p>` : ""}
      ${evidence}</div>
    </section>`;
  }).join("");
  const graph = run.referenceEdges.length
    ? `<details class="graph"><summary>Show Observed Reference Graph</summary><ul>${run.referenceEdges
        .map((edge) =>
          `<li><code>${escapeHtml(shortId(edge.sourceItemId))}</code> → <code>${escapeHtml(shortId(edge.targetItemId))}</code> via ${escapeHtml(edge.fieldName)}</li>`
        )
        .join("")}</ul></details>`
    : "";
  const action = traceAction(run);
  const actionHtml = action
    ? `<p class="actions"><a class="button" href="${commandHref(action.command, run.id)}">${escapeHtml(action.label)}</a></p>`
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

function traceAction(
  run: PublishRun,
): { readonly command: string; readonly label: string } | undefined {
  if (isAbandonedRun(run)) {
    return run.batches.some((batch) => batch.operationId)
      ? { command: recheckStatusCommand, label: "Check status again" }
      : { command: republishTraceCommand, label: "Publish again…" };
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
    return { command: republishTraceCommand, label: "Publish again…" };
  }
  const diagnosticStages = run.stages.filter((stage) =>
    diagnosticStageIds.includes(stage.id as typeof diagnosticStageIds[number])
  );
  const retryableDiagnostic = diagnosticStages.find((stage) =>
    stage.status === "failed" || stage.status === "diverged"
  ) ?? diagnosticStages.find((stage) =>
    stage.status === "inconclusive"
  );
  return retryableDiagnostic
    ? {
        command: retryVerificationCommand,
        label: retryableDiagnostic.id === "browserDom"
          ? "Retry Browser DOM"
          : retryableDiagnostic.status === "inconclusive"
            ? "Retry application response"
            : "Retry failed verification",
      }
    : undefined;
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

function isPublishRun(value: unknown): value is PublishRun {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<PublishRun>;
  return typeof candidate.id === "string" &&
    typeof candidate.kind === "string" &&
    typeof candidate.connectionId === "string" &&
    typeof candidate.createdAt === "string" &&
    Array.isArray(candidate.stages);
}

function isPublishingProfile(value: unknown): value is PublishingSiteProfile {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<PublishingSiteProfile>;
  return typeof candidate.connectionId === "string" && typeof candidate.edgeEndpoint === "string";
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
