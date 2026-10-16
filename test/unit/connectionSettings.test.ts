import { deepStrictEqual, strictEqual, throws, doesNotThrow } from "node:assert/strict";
import { test } from "node:test";
import { parseConnectionSettings, SettingsValidationError, type ConnectionSettingsInput } from "../../src/connections/connectionSettingsValidation";

function input(): ConnectionSettingsInput {
  return { name: "Development", serverUrl: "https://cm.example.test", clientId: "client", clientSecret: { action: "keep", value: "" },
    deploymentEnabled: false, deploymentClientId: "", deploymentEnvironmentId: "", deploymentSecret: { action: "keep", value: "" },
    publishingEnabled: false, edgeEndpoint: "https://edge.example.test/graphql", siteName: "", edgeToken: { action: "keep", value: "" },
    applicationBaseUrl: "", publicTemplate: "{publicBaseUrl}/{language}{route}", defaultSite: "", sites: [] };
}
test("connection dashboard validates required fields, origin URLs and payload types", () => {
  strictEqual(parseConnectionSettings({ ...input(), name: " Dev ", serverUrl: "https://CM.example.test/" }).serverUrl, "https://cm.example.test");
  for (const value of [null, [], { ...input(), name: " " }, { ...input(), clientId: "" }, { ...input(), deploymentEnabled: "false" },
    { ...input(), sites: {} }, { ...input(), serverUrl: "https://user:password@cm.example.test" }, { ...input(), serverUrl: "http://cm.example.test" }, { ...input(), serverUrl: "https://cm.example.test/api" }]) {
    throws(() => parseConnectionSettings(value), SettingsValidationError);
  }
});
test("secret edits require an explicit replacement and do not retain unrelated values", () => {
  deepStrictEqual(parseConnectionSettings({ ...input(), clientSecret: { action: "keep", value: "do-not-retain" } }).clientSecret, { action: "keep", value: "" });
  throws(() => parseConnectionSettings({ ...input(), edgeToken: { action: "replace", value: "" } }), SettingsValidationError);
  throws(() => parseConnectionSettings({ ...input(), clientSecret: { action: "invalid", value: "" } }), SettingsValidationError);
  doesNotThrow(() => parseConnectionSettings({ ...input(), edgeToken: { action: "replace", value: "" } }, "connection"));
});
test("URL settings validate every site's origin and preserve only known properties", () => {
  for (const site of [{ name: "__proto__", publicBaseUrl: "", deploymentBaseUrl: "" }, { name: "site", publicBaseUrl: "https://example.test/path", deploymentBaseUrl: "" }]) {
    throws(() => parseConnectionSettings({ ...input(), sites: [site] }), SettingsValidationError);
  }
  throws(() => parseConnectionSettings({ ...input(), defaultSite: "missing" }), SettingsValidationError);
  throws(() => parseConnectionSettings({ ...input(), publicTemplate: "{unknown}" }), SettingsValidationError);
  throws(() => parseConnectionSettings({ ...input(), publishingEnabled: true, edgeEndpoint: "javascript:alert(1)" }), SettingsValidationError);
  const parsed = parseConnectionSettings({ ...input(), sites: [{ name: "site", publicBaseUrl: "https://EXAMPLE.test/", deploymentBaseUrl: "" }], defaultSite: "site" });
  strictEqual(parsed.sites[0].publicBaseUrl, "https://example.test");
});
