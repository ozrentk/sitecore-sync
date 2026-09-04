import type { PublishRun, TraceStage } from "./publishingTypes";

type PublishingTraceContext = Pick<PublishRun, "stages">;

export function classifyPublishingTrace(context: PublishingTraceContext): string {
  const stage = (id: TraceStage["id"]): TraceStage | undefined =>
    context.stages.find((candidate) => candidate.id === id);
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
  if (context.stages.some((candidate) => candidate.status === "failed")) {
    return "Publishing completed, but an optional diagnostic stage could not be evaluated.";
  }
  return "Publishing and every configured diagnostic stage matched.";
}
