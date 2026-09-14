import { deepStrictEqual, strictEqual, throws, rejects } from "node:assert/strict";
import { test } from "node:test";
import { hasPagePresentation, inferLanguageParts, resolveHomepageUrl, validatePublicPageTemplate, parsePublicPageConnectionValues, resolvePublicPage, resolvePublicPageUrl } from "../../src/publicPages/publicPageUrl";
import type { AuthoringItemDetails } from "../../src/sitecore/authoringClient";
const values = { publicBaseUrl: "https://public.example", deploymentBaseUrl: "https://preview.example", languages: { "en-CA": { language: "en", country: "ca" } } };
function item(path: string, page = false): AuthoringItemDetails {
  return { itemId: path, path, name: path.split("/").at(-1)!, displayName: "", hasChildren: true, language: "en-CA", version: 1, template: { templateId: "page-template", name: "Custom" }, availableVersions: [], fields: page ? [{ fieldId: "layout", name: "__Renderings", label: "Layout", value: '<r><d l="{01234567-89ab-cdef-0123-456789abcdef}" /></r>', type: "layout", typeKey: "layout", scope: "SHARED", sortOrder: 0, sectionName: "Layout", sectionSortOrder: 0, isStandardTemplate: true, containsFallbackValue: false, containsInheritedValue: true, containsStandardValue: true, textual: true }] : [] };
}
test("URL templates use only requested values and encode language, country and route", () => {
  strictEqual(resolvePublicPageUrl("{publicBaseUrl}/{country}/{language}/{route}", values, "en-CA", "/Vehicle Prices/Čaj"), "https://public.example/ca/en/Vehicle%20Prices/%C4%8Caj");
  strictEqual(resolvePublicPageUrl("{deploymentBaseUrl}{route}", values, "fr", "/"), "https://preview.example/");
  strictEqual(resolvePublicPageUrl("https://literal.example/{language}", {}, "en-CA", "/"), "https://literal.example/en");
  for (const template of ["{publicBaseUrl}/{country}", "{missing}", "{publicBaseUrl}/{deploymentBaseUrl}", "javascript:alert(1)", "https://user:pass@example.test", "{publicBaseUrl}{language}"]) {
    throws(() => resolvePublicPageUrl(template, { publicBaseUrl: "https://public.example" }, "fr", "/"));
  }
  throws(() => resolvePublicPageUrl("{publicBaseUrl}", { publicBaseUrl: "https://example.test/path" }, "en", "/"));
  strictEqual(Object.keys(parsePublicPageConnectionValues({ sites: { x: { publicBaseUrl: 42, languages: [] } } }).sites ?? {}).length, 1);
});
test("effective inherited layout identifies pages and resolves nearest owning page", async () => {
  const site = { name: "site", rootPath: "/sitecore/content/Site" };
  const page = item(`${site.rootPath}/Home/Article`, true);
  strictEqual(hasPagePresentation(page), true);
  strictEqual(hasPagePresentation(item(`${site.rootPath}/Home`)), false);
  const requested: string[] = [];
  const target = await resolvePublicPage("{publicBaseUrl}/{country}/{route}", { sites: { site: values } }, [site], item(`${page.path}/Data/Text`), "en-CA", async path => { requested.push(path); return path === page.path ? page : item(path); }, new AbortController().signal);
  strictEqual(target.url, "https://public.example/ca/article");
  strictEqual(requested.length, 2);
  await rejects(resolvePublicPage("{publicBaseUrl}{route}", { sites: { site: values } }, [site], item(`${site.rootPath}/Data/Shared`), "en", async path => item(path), new AbortController().signal), /No owning page/);
  await rejects(resolvePublicPage("{publicBaseUrl}{route}", {}, [site], page, "en", async () => { throw new Error("offline"); }, AbortSignal.abort()), /abort/i);
  await rejects(resolvePublicPage("{publicBaseUrl}{route}", {}, [site, { ...site, name: "another" }], page, "en", async path => item(path), new AbortController().signal), /Several sites/);
  await rejects(resolvePublicPage("{publicBaseUrl}{route}", {}, [site], item(`${page.path}/Data/Text`), "en", async () => { throw new Error("offline"); }, new AbortController().signal), /offline/);
});


test("URL language and region are inferred from tags without assuming a region", () => {
  deepStrictEqual(inferLanguageParts("En-US"), { language: "en", country: "US" });
  deepStrictEqual(inferLanguageParts("zh-Hant-TW"), { language: "zh", country: "TW" });
  deepStrictEqual(inferLanguageParts("es-419"), { language: "es", country: "419" });
  deepStrictEqual(inferLanguageParts("en"), { language: "en", country: undefined });
  strictEqual(resolvePublicPageUrl("https://example.test/{language}/{country}{route}", {}, "en-US", "/"), "https://example.test/en/US/");
  throws(() => resolvePublicPageUrl("https://example.test/{country}", {}, "en", "/"), /no region/);
  throws(() => resolvePublicPageUrl("https://example.test/{language}", {}, "bad_language_tag", "/"), /Invalid language tag/);
  strictEqual(resolvePublicPageUrl("https://example.test/{country}", { languages: { en: { country: "custom" } } }, "en", "/"), "https://example.test/custom");
  strictEqual(validatePublicPageTemplate("{publicBaseUrl}/{language}/{country}{route}"), undefined);
  strictEqual(validatePublicPageTemplate(""), undefined);
  strictEqual(typeof validatePublicPageTemplate("{unsupported}"), "string");
});

test("homepage preview uses the root route and current site values", () => {
  const sites = [{ name: "A", rootPath: "/sitecore/A" }, { name: "B", rootPath: "/sitecore/B" }];
  const configuration = { sites: { A: { publicBaseUrl: "https://a.example" }, B: { publicBaseUrl: "https://b.example" } } };
  strictEqual(resolveHomepageUrl("{publicBaseUrl}/{language}/{country}{route}", configuration, sites, "en-US", "/sitecore/B/Home/Page"), "https://b.example/en/US/");
  strictEqual(resolveHomepageUrl("https://shared.example{route}", {}, [], "en"), "https://shared.example/");
  strictEqual(resolveHomepageUrl("https://shared.example/{country}{route}", { sites: { A: { languages: { "en-US": { country: "us" } } } } }, sites, "en-US", "/sitecore/A/Home"), "https://shared.example/us/");
  throws(() => resolveHomepageUrl("{publicBaseUrl}{route}", configuration, sites, "en"), /Select an item/);
});
