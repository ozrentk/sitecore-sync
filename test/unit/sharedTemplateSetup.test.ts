import { deepStrictEqual, rejects } from "node:assert/strict";
import { test } from "node:test";
import { configureSharedTemplate } from "../../src/publicPages/sharedTemplateSetup";

test("shared setup saves one template and offers homepage without collecting site, language or path", async () => {
  const calls: string[] = [];
  await configureSharedTemplate({
    askTemplate: async () => { calls.push("template"); return " {publicBaseUrl}/{language}/{country}{route} "; },
    saveTemplate: async value => { calls.push(`save:${value}`); },
    offerHomepage: async () => { calls.push("offer"); return true; },
    openHomepage: async () => { calls.push("open"); },
  });
  deepStrictEqual(calls, ["template", "save:{publicBaseUrl}/{language}/{country}{route}", "offer", "open"]);
});

test("shared setup respects cancellation, preview decline and disabling", async () => {
  for (const input of [undefined, "", "https://example.test{route}"]) {
    const calls: string[] = [];
    await configureSharedTemplate({ askTemplate: async () => input, saveTemplate: async () => { calls.push("save"); }, offerHomepage: async () => { calls.push("offer"); return false; }, openHomepage: async () => { calls.push("open"); } });
    deepStrictEqual(calls, input === undefined ? [] : input === "" ? ["save"] : ["save", "offer"]);
  }
  await rejects(configureSharedTemplate({ askTemplate: async () => "{bad}", saveTemplate: async () => { throw new Error("should not save"); }, offerHomepage: async () => false, openHomepage: async () => undefined }), /unknown placeholder/);
});
