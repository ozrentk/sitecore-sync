import type { ProbeEvidence } from "./fallbackDiagnostics";

type Locator = { itemId: string } | { path: string };
type ReadItem = (label: string, locator: Locator, language: string) => Promise<ProbeEvidence>;
function configurationRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function fields(evidence: ProbeEvidence): Record<string, unknown>[] {
  if (evidence.status !== "complete") { return []; }
  return evidence.pages.flatMap(page => {
    const nodes = configurationRecord(configurationRecord(configurationRecord(page.data)?.item)?.fields)?.nodes;
    return Array.isArray(nodes) ? nodes.flatMap(node => configurationRecord(node) ? [configurationRecord(node)!] : []) : [];
  });
}
function item(evidence: ProbeEvidence): Record<string, unknown> | undefined {
  if (evidence.status !== "complete") { return undefined; }
  return configurationRecord(configurationRecord(evidence.pages[0]?.data)?.item);
}
function guid(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^(?:[\da-f]{32}|[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}|\{[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\})$/iu.test(value)) { return undefined; }
  return value.replace(/[{}-]/gu, "").toLowerCase();
}
function relevant(field: Record<string, unknown>): boolean {
  return typeof field.name === "string" && (/fallback/iu.test(field.name)
    || ["__base template", "__standard values", "shared", "unversioned"].includes(field.name.toLowerCase()));
}
function compact(evidence: ProbeEvidence): unknown {
  const metadata = configurationRecord(configurationRecord(evidence.pages[0]?.data)?.item);
  const summarizePages = (pages: ProbeEvidence["pages"]) => pages.map(page => ({
    observedAt: page.observedAt, requestId: page.requestId, outerItem: page.outerItem,
    settings: fields({ label: evidence.label, language: evidence.language, status: "complete", pages: [page] }).filter(relevant),
  }));
  return {
    label: evidence.label, language: evidence.language, status: evidence.status, outcome: evidence.outcome,
    issue: evidence.issue, restarts: evidence.restarts, requestIds: evidence.requestIds,
    pages: summarizePages(evidence.pages),
    discardedAttempts: evidence.discardedAttempts?.map(attempt => ({ reason: attempt.reason, pages: summarizePages(attempt.pages) })),
    observedAt: evidence.pages.map(page => page.observedAt),
    item: metadata ? { itemId: metadata.itemId, name: metadata.name, path: metadata.path,
      version: metadata.version, language: metadata.language, template: metadata.template, versions: metadata.versions } : null,
    settings: fields(evidence).filter(relevant),
    note: "Only fallback, base-template, Standard Values and field-scope settings retained; missing settings are unknown, not false.",
  };
}

/** Collect configuration items, not a resolved policy. Names identify candidate settings; IDs and provenance remain in evidence. */
export async function collectFallbackConfiguration(
  observations: readonly ProbeEvidence[], languages: readonly string[], read: ReadItem, signal: AbortSignal,
): Promise<unknown> {
  const metadataLocale = languages.find(language => language.toLowerCase() === "en") ?? languages.at(-1)!;
  let reads = 0;
  const readBounded: ReadItem = async (label, locator, language) => {
    signal.throwIfAborted();
    if (reads >= 96) { return { label, language, pages: [], status: "limit-reached" }; }
    reads++;
    return read(label, locator, language);
  };
  const languageItems: unknown[] = [];
  const links: unknown[] = [];
  const queue: Locator[] = languages.map(language => ({ path: `/sitecore/system/Languages/${language}` }));
  const visited = new Set<string>();
  let languageReads = 0;
  while (queue.length && languageReads < 16) {
    signal.throwIfAborted();
    const locator = queue.shift()!;
    const key = "itemId" in locator ? locator.itemId : locator.path.toLowerCase();
    if (visited.has(key)) { continue; }
    visited.add(key);
    const evidence = await readBounded("language definition", locator, metadataLocale);
    languageReads++;
    languageItems.push({ locator, evidence: compact(evidence) });
    const id = guid(item(evidence)?.itemId);
    if (id) { visited.add(id); }
    for (const field of fields(evidence).filter(field => typeof field.name === "string" && field.name.toLowerCase() === "fallback language")) {
      const targetId = guid(field.value);
      const targetLanguage = !targetId && typeof field.value === "string" && /^[a-z]{2,8}(?:-[a-z\d]{1,8})*$/iu.test(field.value)
        ? field.value : undefined;
      links.push({ from: id, fieldId: field.fieldId, value: field.value, targetId, targetLanguage,
        interpretation: targetId || targetLanguage ? "reference-observed" : field.value === "" ? "empty-setting" : "unrecognized-reference" });
      if (targetId && !visited.has(targetId)) { queue.push({ itemId: targetId }); }
      if (targetLanguage) { queue.push({ path: `/sitecore/system/Languages/${targetLanguage}` }); }
    }
  }
  const definitions = new Map<string, { name: unknown; fallbackObserved: boolean }>();
  const templates = new Set<string>();
  for (const observation of observations) {
    const templateId = guid(configurationRecord(item(observation)?.template)?.templateId);
    if (templateId) { templates.add(templateId); }
    for (const field of fields(observation)) {
      const id = guid(configurationRecord(field.templateField)?.templateFieldId);
      if (!id || typeof field.name !== "string" || field.name.startsWith("__")) { continue; }
      definitions.set(id, { name: field.name, fallbackObserved: field.containsFallbackValue === true || definitions.get(id)?.fallbackObserved === true });
    }
  }
  const selected = [...definitions].sort((a, b) => Number(b[1].fallbackObserved) - Number(a[1].fallbackObserved)).slice(0, 16);
  const templateItems: unknown[] = [];
  const templateQueue: Locator[] = [...templates].map(itemId => ({ itemId }));
  const seenTemplates = new Set<string>();
  while (templateQueue.length && seenTemplates.size < 16) {
    signal.throwIfAborted();
    const locator = templateQueue.shift()!;
    const id = "itemId" in locator ? locator.itemId : locator.path;
    if (seenTemplates.has(id)) { continue; }
    seenTemplates.add(id);
    const evidence = await readBounded("template / Standard Values", locator, metadataLocale);
    templateItems.push({ locator, evidence: compact(evidence) });
    for (const field of fields(evidence)) {
      if (typeof field.name !== "string" || !["__base template", "__standard values"].includes(field.name.toLowerCase()) || typeof field.value !== "string") { continue; }
      for (const reference of field.value.split("|")) {
        const targetId = guid(reference);
        if (targetId && !seenTemplates.has(targetId)) { templateQueue.push({ itemId: targetId }); }
      }
    }
  }
  const fieldDefinitions: unknown[] = [];
  for (const [id, summary] of selected) {
    for (const language of [...new Set([metadataLocale, ...languages])]) {
      const evidence = await readBounded(`field definition: ${String(summary.name)}`, { itemId: id }, language);
      fieldDefinitions.push({ definitionId: id, ...summary, evidence: compact(evidence) });
    }
  }
  return {
    metadataLocale, languageItems, links, fieldDefinitions, templateItems,
    itemSettings: observations.map(compact),
    coverage: { configurationItemReads: reads, maximumItemReads: 96, maximumLanguageItems: 16,
      languageTraversalTruncated: queue.length > 0, maximumTemplateItems: 16, templateTraversalTruncated: templateQueue.length > 0,
      fieldDefinitionsDiscovered: definitions.size, fieldDefinitionsSelected: selected.length, fieldSelectionTruncated: definitions.size > selected.length },
    environmentSettings: { status: "unknown", names: ["LanguageFieldFallback.AllowVaryFallbackSettingsPerLanguage", "Authoring execution-context item/field fallback enablement"] },
    notice: "Exact reads only. Metadata locale is a probe choice, not a fallback source. Reference links are observations, not proof of an effective chain; repeated references are not followed again. Field definitions prioritize fallback-marked fields, then other content fields (maximum 16). Base-template/Standard Values traversal is bounded. No environment enablement or inherited write target is inferred.",
  };
}
