import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { notifyConnectionAdded } from "../../src/connections/connectionOnboarding";

async function added(template: unknown, choice?: string) {
  const calls: string[] = [];
  let offered: readonly string[] = [];
  let message = "";
  await notifyConnectionAdded("Development", {
    sharedTemplate: () => template,
    notify: async (text, ...actions) => { message = text; offered = actions; return choice; },
    testConnection: async () => { calls.push("test"); },
    configureTemplate: async () => { calls.push("setup"); },
  });
  return { calls, offered, message };
}

test("missing shared template offers setup and an explicit decline after addition", async () => {
  for (const template of [undefined, "", "   "]) {
    const result = await added(template, "Not now");
    deepStrictEqual(result.offered, ["Test Connection", "Set up URL template", "Not now"]);
    deepStrictEqual(result.calls, []);
    match(result.message, /Added XM Cloud connection/);
  }
  deepStrictEqual((await added(undefined)).calls, []);
  deepStrictEqual((await added("", "Set up URL template")).calls, ["setup"]);
  deepStrictEqual((await added("", "Test Connection")).calls, ["test"]);
});

test("a shared template suppresses onboarding even when per-connection placeholders lack values", async () => {
  const result = await added("{publicBaseUrl}/{language}/{country}{route}", "Test Connection");
  deepStrictEqual(result.offered, ["Test Connection"]);
  deepStrictEqual(result.calls, ["test"]);
  strictEqual(result.message.includes("Set up"), false);
  deepStrictEqual((await added("https://example.test{route}", "Set up URL template")).calls, []);
});
