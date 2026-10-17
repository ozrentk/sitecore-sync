import type { RichLinkInfo } from "./richTextLinks";
export interface FrameSelection { from: number; to: number; anchorCell?: number; headCell?: number }
export interface FrameStatus { enabled: boolean; active: boolean; reason: string }
export interface FrameState { raw: string; sequence: number; selection: FrameSelection; statuses: Record<string, FrameStatus> }
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const position = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 524288;
export function frameSelection(value: unknown): value is FrameSelection {
  return record(value) && position(value.from) && position(value.to) && value.from <= value.to
    && [value.anchorCell, value.headCell].every(item => item === undefined || position(item));
}
export function frameState(value: unknown, after: number): value is FrameState {
  if (!record(value) || typeof value.raw !== "string" || value.raw.length > 262144 || !Number.isSafeInteger(value.sequence) || Number(value.sequence) <= after || !frameSelection(value.selection) || !record(value.statuses)) return false;
  const entries = Object.entries(value.statuses);
  return entries.length <= 64 && entries.every(([key, item]) => /^[a-z][a-z\d]{0,31}$/iu.test(key) && !["constructor", "prototype", "__proto__"].includes(key)
    && record(item) && typeof item.enabled === "boolean" && typeof item.active === "boolean" && typeof item.reason === "string" && item.reason.length <= 1024);
}
export function frameLinkInfo(value: unknown): value is RichLinkInfo & { existing: boolean } {
  return record(value) && ["url", "sitecore", "unknown"].includes(String(value.kind)) && typeof value.existing === "boolean"
    && typeof value.href === "string" && value.href.length <= 262144
    && (value.itemId === undefined || typeof value.itemId === "string" && /^[a-f\d]{32}$/iu.test(value.itemId))
    && (value.reason === undefined || typeof value.reason === "string" && value.reason.length <= 1024);
}
