import type {
  PublishRun,
  PublishTraceAttempt,
  TraceStage,
} from "./publishingTypes";

export const diagnosticStageIds = [
  "edgeItem",
  "edgeLayout",
  "application",
  "browserDom",
] as const;

export type DiagnosticStageId = typeof diagnosticStageIds[number];

export function prepareDiagnosticRetry(
  run: PublishRun,
  firstStage: DiagnosticStageId,
  attemptedAt: string,
): PublishRun {
  const firstIndex = diagnosticStageIds.indexOf(firstStage);
  return {
    ...archiveTraceAttempt(run, "verificationRetry", attemptedAt),
    completedAt: undefined,
    conclusion: undefined,
    journalPath: undefined,
    stages: run.stages.map((stage) => {
      const diagnosticIndex = diagnosticStageIds.indexOf(stage.id as DiagnosticStageId);
      if (diagnosticIndex < firstIndex) {
        return stage;
      }
      return resetDiagnosticStage(
        run,
        stage,
        "Queued for verification retry.",
        attemptedAt,
      );
    }),
  };
}

export function prepareStatusRecheck(
  run: PublishRun,
  attemptedAt: string,
): PublishRun {
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
      if (!diagnosticStageIds.includes(stage.id as DiagnosticStageId)) {
        return stage;
      }
      if (run.kind === "standard") {
        return {
          ...stage,
          status: "skipped",
          summary: "Not requested for Standard publish.",
          evidence: undefined,
          updatedAt: attemptedAt,
        };
      }
      return resetDiagnosticStage(
        run,
        stage,
        "Waiting for publishing status re-check.",
        attemptedAt,
      );
    }),
  };
}

export function finishRetryWithFailure(
  run: PublishRun,
  label: string,
  message: string,
  completedAt: string,
): PublishRun {
  return {
    ...run,
    completedAt,
    conclusion: `${label}: ${message}`,
    stages: run.stages.map((stage) => stage.status === "running"
      ? { ...stage, status: "failed", summary: message, updatedAt: completedAt }
      : stage),
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

function resetDiagnosticStage(
  run: PublishRun,
  stage: TraceStage,
  pendingSummary: string,
  updatedAt: string,
): TraceStage {
  if (stage.id === "edgeLayout" && (!run.route || !run.siteName)) {
    return skippedStage(stage, "Route or Sitecore site name was not configured.", updatedAt);
  }
  if (stage.id === "application" && !run.applicationUrl) {
    return skippedStage(
      stage,
      "Application response verification was not configured.",
      updatedAt,
    );
  }
  if (
    stage.id === "browserDom" &&
    (!run.applicationUrl || !hasBrowserDomAssertions(run))
  ) {
    return skippedStage(stage, "No Browser DOM selectors were configured.", updatedAt);
  }
  return {
    ...stage,
    status: "pending",
    summary: pendingSummary,
    evidence: undefined,
    updatedAt,
  };
}

function skippedStage(stage: TraceStage, summary: string, updatedAt: string): TraceStage {
  return {
    ...stage,
    status: "skipped",
    summary,
    evidence: undefined,
    updatedAt,
  };
}

function hasBrowserDomAssertions(run: PublishRun): boolean {
  return run.fieldSelections?.some((field) => Boolean(field.browserSelector)) === true;
}
