import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { ConnectionStore } from "../connections/connectionStore";
import type {
  AuthoringContentClient,
  AuthoringItemDetails,
  AuthoringItemField,
} from "../sitecore/authoringClient";
import { ExperienceEdgeClient } from "../sitecore/experienceEdgeClient";
import { PublishingClient, type PublishingStatus } from "../sitecore/publishingClient";
import type {
  PublishKind,
  PublishMode,
  PublishRun,
  PublishSnapshot,
  PublishTarget,
  PublishingSiteProfile,
  ReferenceEdge,
  TraceStage,
  TraceStageStatus,
} from "./publishingTypes";

const runsKey = "sitecoreXmCloudSync.publishRuns.v1";
const profilesKey = "sitecoreXmCloudSync.publishingProfiles.v1";
const maximumReferenceItems = 50;
const maximumReferenceDepth = 8;

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
  ) {
    this.connectionSubscription = connections.onDidChange(() => {
      void this.removeOrphanedProfiles();
    });
  }

  async start(kind: PublishKind, target: PublishTarget): Promise<void> {
    if (this.controllers.size > 0) {
      await vscode.window.showInformationMessage(
        "Wait for the current publish operation to finish before starting another.",
      );
      return;
    }
    const connection = this.connections.get(target.connectionId);
    const clientSecret = await this.connections.getClientSecret(target.connectionId);
    if (!connection || !clientSecret) {
      await vscode.window.showErrorMessage("The selected XM Cloud connection or secret is missing.");
      return;
    }

    const controller = new AbortController();
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
      const options = await this.collectPublishOptions(kind);
      if (!options) {
        return;
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

      let profileSettings = kind === "standard"
        ? undefined
        : await this.collectProfileSettings(target.connectionId, controller.signal);
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
      const confirmed = await this.confirm(
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
        snapshots: graph.snapshots.filter((snapshot) =>
          selectedIds.some((itemId) => normalizeId(itemId) === normalizeId(snapshot.itemId))
        ),
        referenceEdges: graph.edges.filter((edge) =>
          selectedIds.some((itemId) => normalizeId(itemId) === normalizeId(edge.sourceItemId)) &&
          selectedIds.some((itemId) => normalizeId(itemId) === normalizeId(edge.targetItemId))
        ),
        batches,
        stages: initialStages(kind, profileSettings),
        route: profileSettings?.route,
        routeItemId: profileSettings?.routeItemId,
        siteName: profileSettings?.profile.siteName,
        applicationUrl: profileSettings?.applicationUrl,
      };
      await this.saveRun(run);
      this.controllers.set(run.id, controller);
      if (kind !== "standard") {
        this.openTrace(run);
      }
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `${publishKindLabel(kind)}: ${rootDetails.path}`,
          cancellable: false,
        },
        async () =>
          this.execute(run as PublishRun, connection, clientSecret, profileSettings, controller.signal),
      );
      this.controllers.delete(run.id);
      if (kind === "standard") {
        await vscode.window.showInformationMessage(
          `${connection.name}: published ${rootDetails.path} (${target.language}).`,
        );
      }
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
      if (run) {
        this.controllers.delete(run.id);
      }
    }
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
    const siteSelection = await this.selectSiteName(
      resolvedConnectionId,
      existing?.siteName,
      new AbortController().signal,
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
      token || existingToken as string,
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
    do {
      missing = [];
      for (const snapshot of run.snapshots) {
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
        const mismatches = Object.entries(snapshot.fields)
          .filter(([, expected]) => expected.length > 0)
          .filter(([name, expected]) => item.fields[name] !== expected)
          .map(([name]) => name);
        if (mismatches.length > 0) {
          missing.push(`${snapshot.path}: field mismatch (${mismatches.join(", ")})`);
        }
      }
      if (missing.length === 0) {
        return this.setStage(
          run,
          "edgeItem",
          "matched",
          `${run.snapshots.length} expected item snapshot(s) reached Experience Edge.`,
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
    const layoutEvidence = run.snapshots.map((snapshot) => {
      if (
        normalizeId(snapshot.itemId) === normalizeId(run.rootItemId) &&
        layout.itemId &&
        normalizeId(layout.itemId) === normalizeId(snapshot.itemId)
      ) {
        return {
          path: snapshot.path,
          itemId: snapshot.itemId,
          found: true,
          fieldMismatches: [] as readonly string[],
        };
      }
      return inspectRenderedSnapshot(layout.rendered, snapshot);
    });
    const missingIds = layoutEvidence
      .filter((evidence) => !evidence.found)
      .map((evidence) => `${evidence.path}: item ${evidence.itemId} was not exposed in rendered data`);
    const fieldMismatches = layoutEvidence.flatMap((evidence) => evidence.fieldMismatches);
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
    const divergences = [...rootMismatch, ...fieldMismatches, ...referenceMismatches];
    run = await this.setStage(
      run,
      "edgeLayout",
      divergences.length ? "diverged" : "matched",
      divergences.length
        ? "The rendered layout did not match every observed item and scoped field value."
        : "The rendered route identity and observable reference chains matched.",
      [...divergences, ...missingIds],
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
        `HTTP ${result.status}`,
        ...Object.entries(result.headers).map(([name, value]) => `${name}: ${value}`),
      ];
      const candidateValues = run.snapshots.flatMap((snapshot) =>
        Object.entries(snapshot.fields)
          .filter(([, value]) => value.trim().length >= 3)
          .map(([name, value]) => ({ path: snapshot.path, name, value }))
      );
      const matchedValues = candidateValues.filter((candidate) =>
        result.body.includes(candidate.value)
      );
      const healthyStatus = result.status >= 200 && result.status < 400;
      const contentMatched = candidateValues.length === 0 || matchedValues.length > 0;
      const healthy = healthyStatus && contentMatched;
      run = await this.setStage(
        run,
        "application",
        healthy ? "matched" : "diverged",
        healthy
          ? matchedValues.length
            ? `The public application response contains ${matchedValues.length} expected value(s).`
            : "The public application response was successful; no textual assertions were available."
          : healthyStatus
            ? "The response was successful but contained none of the expected textual values."
            : `The application returned HTTP ${result.status}.`,
        [
          ...evidence,
          ...matchedValues.slice(0, 20).map((candidate) =>
            `Matched ${candidate.path}: ${candidate.name}`
          ),
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
    signal: AbortSignal,
  ): Promise<ProfileRunSettings | undefined> {
    let profile = this.listProfiles().find((candidate) => candidate.connectionId === connectionId);
    let edgeToken = await this.connections.getEdgeToken(connectionId);
    if (!profile || !edgeToken) {
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
      profile = {
        connectionId,
        edgeEndpoint: endpoint.trim(),
        siteName: profile?.siteName,
        applicationBaseUrl: profile?.applicationBaseUrl,
      };
      await this.saveProfile(profile, edgeToken);
    }
    const siteSelection = await this.selectSiteName(connectionId, profile.siteName, signal);
    if (!siteSelection) {
      return undefined;
    }
    profile = { ...profile, siteName: siteSelection.siteName };
    await this.saveProfile(profile, edgeToken);
    let route = "";
    if (profile.siteName) {
      const selectedRoute = await vscode.window.showInputBox({
        title: "Traced publish: route verification",
        prompt: `Enter a route for Sitecore site “${profile.siteName}”, or leave empty.`,
        placeHolder: "/station-wagon",
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

  private async selectSiteName(
    connectionId: string,
    currentSiteName: string | undefined,
    signal: AbortSignal,
  ): Promise<{ readonly siteName?: string } | undefined> {
    let sites = this.connections.listVerifiedSites(connectionId);
    if (!this.connections.hasVerifiedSiteCatalog(connectionId)) {
      const connection = this.connections.get(connectionId);
      const clientSecret = await this.connections.getClientSecret(connectionId);
      if (connection && clientSecret) {
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
      }
    }
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
      ].join("\n"),
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
    return {
      ...run,
      completedAt: new Date().toISOString(),
      conclusion: `Publishing failed: ${message}`,
      stages: run.stages.map((stage) => stage.status === "running"
        ? { ...stage, status: "failed", summary: message, updatedAt: new Date().toISOString() }
        : stage),
    };
  }

  private async saveRun(run: PublishRun): Promise<void> {
    const runs = [run, ...this.listRuns().filter((candidate) => candidate.id !== run.id)].slice(0, 30);
    await this.workspaceState.update(runsKey, runs);
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
        "Publish Trace",
        vscode.ViewColumn.Active,
        { enableScripts: false, retainContextWhenHidden: true },
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
): {
  readonly path: string;
  readonly itemId: string;
  readonly found: boolean;
  readonly fieldMismatches: readonly string[];
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
      fieldMismatches: [],
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
  const actualFields = new Map<string, string>();
  for (const candidate of candidates) {
    collectNamedFieldValues(candidate, actualFields);
  }
  const fieldMismatches = Object.entries(snapshot.fields)
    .filter(([name]) => actualFields.has(name))
    .filter(([name, expected]) => actualFields.get(name) !== expected)
    .map(([name]) => `${snapshot.path}: rendered field ${name} differs from raw Edge`);
  return {
    path: snapshot.path,
    itemId: snapshot.itemId,
    found: candidates.length > 0,
    fieldMismatches,
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
): readonly TraceStage[] {
  return [
    { id: "authoring", label: "Authoring snapshot", status: "matched", summary: "Snapshot captured." },
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
  if (stage("application")?.status === "diverged") {
    return "Likely boundary: rendered Experience Edge layout → application or CDN response.";
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
  const conclusion = run.conclusion
    ? `<aside><strong>Conclusion</strong><p>${escapeHtml(run.conclusion)}</p></aside>`
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
      .symbol{font-size:16px}.matched .symbol{color:var(--vscode-testing-iconPassed)}.diverged .symbol,.failed .symbol{color:var(--vscode-testing-iconFailed)}
      .running .symbol{color:var(--vscode-progressBar-background)}.skipped{color:var(--vscode-descriptionForeground)}
      details{margin-top:8px}summary{color:var(--vscode-textLink-foreground);cursor:pointer}.graph{margin-top:18px}
      code{font-family:var(--vscode-editor-font-family);font-size:12px}li{margin:5px 0}
    </style></head><body>
    <h1>${escapeHtml(run.rootPath)}</h1>
    <div class="meta">${escapeHtml(publishKindLabel(run.kind))} · ${escapeHtml(run.connectionName)} · ${escapeHtml(run.language)}</div>
    ${conclusion}${stageHtml}${graph}
  </body></html>`;
}

function stageSymbol(status: TraceStageStatus): string {
  switch (status) {
    case "matched": return "✓";
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
