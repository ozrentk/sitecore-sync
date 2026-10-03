import type { CreateAuthoringItemInput } from "./authoringClient";
import { buildFallbackProbes } from "./fallbackDiagnostics";

export function fixtureGuid(value: string): string {
  return /^[a-f\d]{32}$/iu.test(value)
    ? value.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/u, "$1-$2-$3-$4-$5") : value;
}

export interface FallbackFixture {
  readonly input: CreateAuthoringItemInput;
  readonly expectedPath: string;
  status: "planned" | "outcome-unknown" | "created";
  itemId?: string;
}

/** Source-only cases and local controls; no existing content or template settings are edited. */
export function planFallbackFixtures(parentId: string, parentPath: string, templateId: string,
  fieldName: string, languages: readonly string[], runId: string): FallbackFixture[] {
  buildFallbackProbes(fixtureGuid(parentId), languages);
  buildFallbackProbes(fixtureGuid(templateId), languages);
  if (languages.length < 2 || !/^\/sitecore\/content\/.+/iu.test(parentPath)
    || !fieldName || fieldName.startsWith("__") || !/^[a-f\d]{12}$/u.test(runId)) {
    throw new Error("Choose a content parent, a content field and at least two locales.");
  }
  return [
    { suffix: "source-enabled", language: languages.at(-1)!, enabled: "1", value: `Fallback source ${runId}` },
    { suffix: "source-disabled", language: languages.at(-1)!, enabled: "", value: `Fallback source ${runId}` },
    { suffix: "local-value", language: languages[0]!, enabled: "1", value: `Local value ${runId}` },
    { suffix: "local-empty", language: languages[0]!, enabled: "1", value: "" },
  ].map(test => {
    const name = `xm-fallback-${runId}-${test.suffix}`;
    return { status: "planned", expectedPath: `${parentPath}/${name}`,
      input: { name, parent: parentId, templateId, language: test.language,
        fields: { [fieldName]: test.value, "__Enable item fallback": test.enabled } } };
  });
}

/** Checkpoint before sending a non-retried mutation. Failures deliberately retain unknown outcome. */
export async function createFallbackFixtures(fixtures: FallbackFixture[],
  create: (input: CreateAuthoringItemInput) => Promise<{ itemId: string; path: string }>,
  checkpoint: () => Promise<void>, signal: AbortSignal): Promise<void> {
  if (fixtures.some(fixture => fixture.status !== "planned")) { throw new Error("Test runs cannot be replayed."); }
  for (const fixture of fixtures) {
    signal.throwIfAborted();
    fixture.status = "outcome-unknown";
    await checkpoint();
    signal.throwIfAborted();
    const created = await create(fixture.input);
    buildFallbackProbes(fixtureGuid(created.itemId), [fixture.input.language]);
    if (created.path.toLowerCase() !== fixture.expectedPath.toLowerCase()) { throw new Error("Unexpected created path."); }
    fixture.itemId = created.itemId;
    fixture.status = "created";
    await checkpoint();
  }
}
