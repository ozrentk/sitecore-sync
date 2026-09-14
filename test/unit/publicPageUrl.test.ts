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
  await rejects(resolvePublicPage("{publicBaseUrl}{route}", { sites: { site: values } }, [site], item(`${site.rootPath}/Data/Shared`), "en", async path => item(path), new AbortController().signal), /No page presentation/);
  await rejects(resolvePublicPage("{publicBaseUrl}{route}", {}, [site], page, "en", async () => { throw new Error("offline"); }, AbortSignal.abort()), /abort/i);
  await rejects(resolvePublicPage("{publicBaseUrl}{route}", {}, [site, { ...site, name: "another" }], page, "en", async path => item(path), new AbortController().signal), /Several sites/);
  await rejects(resolvePublicPage("{publicBaseUrl}{route}", {}, [site], item(`${page.path}/Data/Text`), "en", async () => { throw new Error("offline"); }, new AbortController().signal), /offline/);
});

test("final-layout delta identifies the selected page without returned shared layout", async () => {
  const site = { name: "site", rootPath: "/sitecore/content/Example/global" };
  const base = item(`${site.rootPath}/home/50 States 50 Trails`, true);
  const page = { ...base, fields: [{ ...base.fields[0], name: "__Final Renderings", value:
    '<r xmlns:p="p" xmlns:s="s" p:p="1"><d id="{11111111-1111-1111-1111-111111111111}">' +
    '<r uid="{22222222-2222-2222-2222-222222222222}"><p:d /></r>' +
    '<r uid="{33333333-3333-3333-3333-333333333333}" p:before="*" s:ds="{44444444-4444-4444-4444-444444444444}" s:id="{55555555-5555-5555-5555-555555555555}" s:ph="/main/content" />' +
    '</d></r>' }] };
  strictEqual(hasPagePresentation(page), true);
  const target = await resolvePublicPage("https://example.test{route}", {}, [site], page, "en-US",
    async () => { throw new Error("Selected page must resolve without walking ancestors"); }, new AbortController().signal);
  strictEqual(target.page, page);
  strictEqual(target.url, "https://example.test/50-states-50-trails");
  const datasource = await resolvePublicPage("https://example.test{route}", {}, [site], item(`${page.path}/Data/Text`), "en-US",
    async path => path === page.path ? page : item(path), new AbortController().signal);
  strictEqual(datasource.page, page);
});

test("presentation detection excludes empty, deletion-only and unrelated fields", () => {
  const base = item("/sitecore/content/Site/home/Page", true);
  const guid = "{11111111-1111-1111-1111-111111111111}";
  for (const value of ["", "<r />", `<r><d id="${guid}" /></r>`,
    `<r><d id="${guid}"><r uid="${guid}"><p:d /></r></d></r>`,
    '<r><d><r s:id="invalid" /></d></r>', `<r id="${guid}" />`]) {
    strictEqual(hasPagePresentation({ ...base, fields: [{ ...base.fields[0], name: "__Final Renderings", value }] }), false);
  }
  strictEqual(hasPagePresentation({ ...base, fields: [{ ...base.fields[0], name: "Text" }] }), false);
  for (const value of [`<r><d s:l="${guid}" /></r>`, `<r><d><r id="${guid}" /></d></r>`]) {
    strictEqual(hasPagePresentation({ ...base, fields: [{ ...base.fields[0], value }] }), true);
  }
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
