import type { PublishRun, TraceStageStatus } from "./publishingTypes";
import {
  expectedFieldsForSnapshot,
  formatFieldValue,
} from "./publishingVerification";

type ApplicationVerificationContext = Pick<PublishRun, "snapshots" | "fieldSelections">;

export interface ApplicationResponseData {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface ApplicationVerificationOutcome {
  readonly status: Extract<TraceStageStatus, "matched" | "inconclusive" | "diverged">;
  readonly summary: string;
  readonly evidence: readonly string[];
}

interface ApplicationFieldCandidate {
  readonly path: string;
  readonly name: string;
  readonly value: string;
}

const minimumCandidateLength = 3;
const maximumValueEvidence = 20;

export function evaluateApplicationResponse(
  context: ApplicationVerificationContext,
  applicationUrl: string,
  response: ApplicationResponseData,
): ApplicationVerificationOutcome {
  const explicitFieldSelection = Boolean(context.fieldSelections?.length);
  const candidateValues = applicationFieldCandidates(context);
  const matchedValues = candidateValues.filter((candidate) =>
    response.body.includes(candidate.value)
  );
  const healthyStatus = response.status >= 200 && response.status < 400;
  const contentMatched = candidateValues.length === 0 ||
    (explicitFieldSelection
      ? matchedValues.length === candidateValues.length
      : matchedValues.length > 0);
  const status: ApplicationVerificationOutcome["status"] = !healthyStatus
    ? "diverged"
    : contentMatched
      ? "matched"
      : "inconclusive";
  return {
    status,
    summary: applicationSummary(
      status,
      response.status,
      explicitFieldSelection,
      candidateValues.length,
      matchedValues.length,
    ),
    evidence: [
      `URL: ${applicationUrl}`,
      `HTTP ${response.status}`,
      ...Object.entries(response.headers).map(([name, value]) => `${name}: ${value}`),
      ...matchedValues.slice(0, maximumValueEvidence).map((candidate) =>
        `Matched ${candidate.path}: ${candidate.name}`
      ),
      ...(explicitFieldSelection
        ? candidateValues
            .filter((candidate) => !matchedValues.includes(candidate))
            .slice(0, maximumValueEvidence)
            .map((candidate) =>
              `Missing ${candidate.path} › ${candidate.name}: ${formatFieldValue(candidate.value)}`
            )
        : []),
    ],
  };
}

function applicationFieldCandidates(
  context: ApplicationVerificationContext,
): readonly ApplicationFieldCandidate[] {
  return context.snapshots.flatMap((snapshot) =>
    expectedFieldsForSnapshot(context, snapshot)
      .filter(([, value]) => value.trim().length >= minimumCandidateLength)
      .map(([name, value]) => ({ path: snapshot.path, name, value }))
  );
}

function applicationSummary(
  status: ApplicationVerificationOutcome["status"],
  responseStatus: number,
  explicitFieldSelection: boolean,
  candidateCount: number,
  matchedCount: number,
): string {
  if (status === "matched") {
    if (!matchedCount) {
      return "The public application response was successful; no textual assertions were available.";
    }
    return explicitFieldSelection
      ? `The public application response contains all ${matchedCount} selected textual value(s).`
      : `The public application response contains ${matchedCount} expected value(s).`;
  }
  if (status === "diverged") {
    return `The application returned HTTP ${responseStatus}.`;
  }
  return matchedCount
    ? `The response was successful but exposed only ${matchedCount}/${candidateCount} selected textual value(s). Browser-rendered DOM was not evaluated.`
    : "The response was successful but did not expose the expected text in its server response. Browser-rendered DOM was not evaluated.";
}
