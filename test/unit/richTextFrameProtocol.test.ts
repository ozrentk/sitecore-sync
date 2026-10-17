import { test } from "node:test";
import { strictEqual } from "node:assert/strict";
import { frameState, frameSelection, frameLinkInfo } from "../../src/editor/richTextFrameProtocol";
test("frame snapshots require a newer sequence, bounded raw source and typed selection/statuses", () => {
  const state = { raw: "<p>Keep</p>", sequence: 2, selection: { from: 1, to: 2 }, statuses: { bold: { enabled: true, active: false, reason: "" } } };
  strictEqual(frameState(state, 1), true); strictEqual(frameState(state, 2), false);
  for (const patch of [{ raw: "x".repeat(262145) }, { sequence: NaN }, { selection: { from: -1, to: 2 } }, { selection: { from: 3, to: 2 } }, { statuses: { bold: { enabled: "true", active: false, reason: "" } } }, { statuses: JSON.parse('{"__proto__":{}}') }]) strictEqual(frameState({ ...state, ...patch }, 1), false);
  strictEqual(frameSelection({ from: 1, to: 2, anchorCell: Infinity }), false);
});
test("link bridge results reject malformed values without interpreting unsupported profiles", () => {
  strictEqual(frameLinkInfo({ kind: "url", href: "/page", existing: true }), true);
  strictEqual(frameLinkInfo({ kind: "unknown", href: "custom", reason: "Use HTML", existing: true }), true);
  for (const value of [null, { kind: "url", href: "/page" }, { kind: "script", href: "x", existing: true }, { kind: "sitecore", href: "x", itemId: "wrong", existing: true }]) strictEqual(frameLinkInfo(value), false);
});
