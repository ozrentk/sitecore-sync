import { strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { classifyPublishingTrace } from "../../src/publishing/publishingTraceConclusion";
import type { TraceStage, TraceStageStatus } from "../../src/publishing/publishingTypes";

test("trace conclusion identifies Experience Edge ingestion divergence first", () => {
  strictEqual(
    classifyPublishingTrace({
      stages: [
        stage("edgeItem", "diverged"),
        stage("edgeLayout", "diverged"),
        stage("browserDom", "diverged"),
        stage("application", "diverged"),
        stage("publishing", "failed"),
      ],
    }),
    "Likely boundary: Sitecore publishing → Experience Edge ingestion.",
  );
});

test("trace conclusion identifies rendered-layout divergence before later stages", () => {
  strictEqual(
    classifyPublishingTrace({
      stages: [
        stage("edgeItem", "matched"),
        stage("edgeLayout", "diverged"),
        stage("browserDom", "diverged"),
        stage("application", "diverged"),
      ],
    }),
    "Likely boundary: raw Experience Edge item → rendered route layout.",
  );
});

test("trace conclusion reports different Browser DOM text before application results", () => {
  strictEqual(
    classifyPublishingTrace({
      stages: [
        stage("browserDom", "diverged"),
        stage("application", "diverged"),
      ],
    }),
    "The browser found the configured element, but its rendered text differed from the selected field value.",
  );
});

test("trace conclusion reports inconclusive Browser DOM selectors before application divergence", () => {
  strictEqual(
    classifyPublishingTrace({
      stages: [
        stage("browserDom", "inconclusive"),
        stage("application", "diverged"),
      ],
    }),
    "Browser DOM verification could not identify every configured selector conclusively.",
  );
});

test("trace conclusion identifies application or CDN response divergence", () => {
  strictEqual(
    classifyPublishingTrace({
      stages: [
        stage("browserDom", "matched"),
        stage("application", "diverged"),
      ],
    }),
    "Likely boundary: rendered Experience Edge layout → application or CDN response.",
  );
});

test("trace conclusion accepts browser evidence when the server response is inconclusive", () => {
  strictEqual(
    classifyPublishingTrace({
      stages: [
        stage("application", "inconclusive"),
        stage("browserDom", "matched"),
      ],
    }),
    "Selected values matched in the browser DOM; the server response alone was inconclusive.",
  );
});

test("trace conclusion preserves an inconclusive server-only result", () => {
  strictEqual(
    classifyPublishingTrace({
      stages: [
        stage("application", "inconclusive"),
        stage("browserDom", "skipped"),
        stage("edgeLayout", "matched"),
        stage("authoring", "failed"),
      ],
    }),
    "Rendered layout matched, but the server response did not prove what the browser rendered.",
  );
});

test("trace conclusion reports optional diagnostic failures", () => {
  strictEqual(
    classifyPublishingTrace({
      stages: [
        stage("edgeItem", "matched"),
        stage("edgeLayout", "failed"),
        stage("application", "matched"),
        stage("browserDom", "matched"),
      ],
    }),
    "Publishing completed, but an optional diagnostic stage could not be evaluated.",
  );
});

test("trace conclusion reports success when no decisive failure is present", () => {
  strictEqual(
    classifyPublishingTrace({
      stages: [
        stage("authoring", "matched"),
        stage("publishing", "matched"),
        stage("edgeItem", "matched"),
        stage("edgeLayout", "matched"),
        stage("application", "matched"),
        stage("browserDom", "skipped"),
      ],
    }),
    "Publishing and every configured diagnostic stage matched.",
  );
});

function stage(id: TraceStage["id"], status: TraceStageStatus): TraceStage {
  return { id, label: id, status };
}
