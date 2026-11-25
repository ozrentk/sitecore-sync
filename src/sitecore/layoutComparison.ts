import { createHash } from "node:crypto";
import { object, type LayoutDiagnostic } from "./layoutDiagnostic";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
const fingerprint = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
interface Occurrence { placement: string; uid?: string; componentName?: unknown; dataSource?: unknown; isContentResolved?: unknown; fields?: unknown; }
export function layoutEvidence(report: LayoutDiagnostic) {
  const root = report.rendered;
  const route = object(root) && object(root.sitecore) && object(root.sitecore.route) ? root.sitecore.route : undefined;
  const occurrences: Occurrence[] = []; let limited = false, malformed = false;
  const walk = (placeholders: unknown, path: (string | number)[], depth: number): void => {
    if (placeholders === undefined) return;
    if (!object(placeholders)) { malformed = true; return; }
    if (depth > 20) { limited = true; return; }
    for (const [name, children] of Object.entries(placeholders)) {
      if (!Array.isArray(children)) { malformed = true; continue; }
      for (const [index, child] of children.entries()) {
        if (occurrences.length >= 500) { limited = true; return; }
        if (!object(child)) { malformed = true; continue; }
        const next = [...path, name, index];
        occurrences.push({ placement: JSON.stringify(next), uid: typeof child.uid === "string" && child.uid.trim() ? child.uid.replace(/[{}-]/gu, "").toLowerCase() : undefined,
          componentName: child.componentName, dataSource: child.dataSource, isContentResolved: child.isContentResolved, fields: child.fields });
        walk(child.placeholders, next, depth + 1);
      }
    }
  };
  if (route) walk(route.placeholders, [], 0);
  return { route, occurrences, limited, malformed,
    resolution: { resolved: occurrences.filter(item => item.isContentResolved === true).length,
      unresolved: occurrences.filter(item => item.isContentResolved === false).length,
      unknown: occurrences.filter(item => typeof item.isContentResolved !== "boolean").length } };
}

/** Match only unique UIDs. A position is evidence, never a fabricated occurrence identity. */
export function compareLayouts(preview: LayoutDiagnostic, published: LayoutDiagnostic) {
  if (canonical(preview.selection) !== canonical(published.selection)) throw Error("Layout comparison requires identical inputs.");
  const left = layoutEvidence(preview), right = layoutEvidence(published);
  const summary = (evidence: ReturnType<typeof layoutEvidence>) => ({ resolution: evidence.resolution, count: evidence.occurrences.length, limited: evidence.limited, malformed: evidence.malformed });
  const matches: { uid: string; previewPlacement: string; publishedPlacement: string; differences: string[] }[] = [];
  const ambiguous: { side: string; placement: string; reason: string }[] = [];
  const unmatched: { side: string; uid: string; placement: string }[] = [];
  const grouped = (items: Occurrence[]) => {
    const map = new Map<string, Occurrence[]>();
    for (const item of items) if (item.uid) map.set(item.uid, [...(map.get(item.uid) ?? []), item]);
    return map;
  };
  const l = grouped(left.occurrences), r = grouped(right.occurrences);
  for (const [side, evidence] of [["preview", left], ["published", right]] as const) for (const item of evidence.occurrences) {
    if (!item.uid || (l.get(item.uid)?.length ?? 0) > 1 || (r.get(item.uid)?.length ?? 0) > 1)
      ambiguous.push({ side, placement: item.placement, reason: item.uid ? "Repeated UID; identity ambiguous" : "UID missing; identity unknown" });
  }
  for (const uid of new Set([...l.keys(), ...r.keys()])) {
    const a = l.get(uid) ?? [], b = r.get(uid) ?? [];
    if (a.length > 1 || b.length > 1) continue;
    if (!a[0] || !b[0]) { const item = a[0] ?? b[0]!; unmatched.push({ side: a[0] ? "preview" : "published", uid, placement: item.placement }); continue; }
    const differences = (["placement", "componentName", "dataSource", "isContentResolved", "fields"] as const)
      .filter(property => canonical(a[0]![property]) !== canonical(b[0]![property]));
    matches.push({ uid, previewPlacement: a[0].placement, publishedPlacement: b[0].placement, differences });
  }
  const routeProperties = ["itemId", "name", "itemLanguage", "itemVersion", "fields"];
  return { formatVersion: 1, selection: preview.selection, preview, published,
    comparison: { completeObservedLayouts: [preview, published].every(report => report.httpStatus === 200 && report.graphql === "success" && report.body === "valid" && report.routePresence === "present")
      && !left.limited && !right.limited && !left.malformed && !right.malformed,
      status: left.route && right.route ? "compared-observed-content" : "inconclusive",
      preview: summary(left), published: summary(right), matches, ambiguous, unmatched,
      routeDifferences: left.route && right.route ? routeProperties.filter(property => canonical(left.route![property]) !== canonical(right.route![property])) : null,
      fieldsFingerprints: { preview: left.route ? fingerprint(left.route.fields) : null, published: right.route ? fingerprint(right.route.fields) : null } },
    notice: "Differences describe these two observations only. Missing properties remain unknown. Partial/error/limited evidence is not a complete comparison. Unique UID matching does not prove durable identity. No publishing failure, cause, freshness, fallback source or website runtime equivalence is inferred." };
}
