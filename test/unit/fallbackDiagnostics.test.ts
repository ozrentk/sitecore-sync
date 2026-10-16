import { deepStrictEqual, strictEqual, rejects } from "node:assert/strict";
import { test } from "node:test";
import { Kind, parse } from "graphql";
import { buildFallbackProbes, collectFallbackDiagnostic, serializeFallbackDiagnostic, type ProbeEvidence } from "../../src/sitecore/fallbackDiagnostics";
import type { SitecoreHttpAttempt } from "../../src/sitecore/sitecoreHttpClient";
import { AuthoringContentClient } from "../../src/sitecore/authoringClient";
import { jsonResponse, noOpLogger, QueuedHttpRuntime, requestBody, testConnection, tokenResponse } from "./sitecoreClientTestHelpers";

const id = "00000000-0000-0000-0000-000000000001";
const probes = buildFallbackProbes(id, ["en-NZ", "en"]);
const schema = { data: { __schema: { types: [] } } };
const page = (more = false, cursor = "next") => ({ data: { item: { itemId: id, language: { name: "en-NZ" }, version: 0, fields: { nodes: [{ value: "", containsFallbackValue: null }], pageInfo: { hasNextPage: more, endCursor: cursor } } } } });
const signal = new AbortController().signal;
interface TestReport {
  schema: { status: string };
  observations: { status: string; outcome?: string; pages: { data: { item: null | { fields: { nodes: Record<string, unknown>[] } } } }[] }[];
}
const asJson = (report: unknown): TestReport => JSON.parse(JSON.stringify(report)) as TestReport;

interface DetailedReport {
  observations: ProbeEvidence[];
  queries: { id: number; query: string }[];
  requests: { id: number; queryId: number; variables: Record<string, unknown>; versionSelection?: string;
    startedAt: string; finishedAt: string; status: string; httpAttempts: SitecoreHttpAttempt[] }[];
  coverage: { requestCount: number; maximumRequests: number; evidenceBytesUsed: number; maximumEvidenceBytes: number };
}

function versionPage(version: number, more = false, cursor = "next") {
  const result = page(more, cursor);
  result.data.item.version = version;
  result.data.item.fields.nodes[0]!.value = `version-${version}`;
  return result;
}

test("diagnostics reject outer identity/language mismatches on exact and field-fallback pages", async () => {
  for (const probe of [probes[0]!, probes.at(-1)!]) {
    for (const [patch, issue] of [
      [{ itemId: "00000000-0000-0000-0000-000000000002" }, "outer-item-mismatch"],
      [{ itemId: undefined }, "outer-item-mismatch"],
      [{ language: { name: "en" } }, "outer-language-mismatch"],
      [{ language: null }, "outer-language-mismatch"],
      [{ version: -1 }, "invalid-outer-version"],
    ] as const) {
      const response = versionPage(1);
      Object.assign(response.data.item, patch);
      const report = await collectFallbackDiagnostic([probe], async op => op === "IntrospectionQuery" ? schema : response, signal) as DetailedReport;
      strictEqual(report.observations[0]!.status, "invalid-response");
      strictEqual(report.observations[0]!.issue, issue);
    }
  }
});

test("matching outer locale accepts legitimate field fallback without claiming an item substitution", async () => {
  const response = versionPage(1);
  Object.assign(response.data.item, { itemId: `{${id.toUpperCase()}}`, language: { name: "EN-nz" } });
  Object.assign(response.data.item.fields.nodes[0]!, { containsFallbackValue: true });
  const report = await collectFallbackDiagnostic([probes.at(-1)!], async op => op === "IntrospectionQuery" ? schema : response, signal) as DetailedReport;
  strictEqual(report.observations[0]!.status, "complete");
  strictEqual(report.observations[0]!.label.includes("item.fields only"), true);
  deepStrictEqual(report.observations[0]!.pages[0]!.outerItem, { itemId: `{${id}}`, language: "EN-nz", version: 1 });
});

test("version drift restarts from page one with latest omitted and keeps discarded pages separate", async () => {
  const responses = [schema, versionPage(1, true), versionPage(2), versionPage(3, true), versionPage(3)];
  const calls: Readonly<Record<string, unknown>>[] = [];
  const progress: string[] = [];
  const report = await collectFallbackDiagnostic(probes.slice(0, 1), async (_op, _query, variables) => {
    calls.push(variables); return responses.shift();
  }, signal, message => progress.push(message)) as DetailedReport;
  const observation = report.observations[0]!;
  strictEqual(observation.status, "complete");
  deepStrictEqual(observation.pages.map(p => p.outerItem?.version), [3, 3]);
  deepStrictEqual(observation.discardedAttempts?.[0]?.pages.map(p => p.outerItem?.version), [1, 2]);
  deepStrictEqual(calls.slice(1).map(v => v.after), [null, "next", null, "next"]);
  for (const variables of calls.slice(1)) {
    deepStrictEqual(variables.where, { database: "master", language: "en-NZ", itemId: id });
  }
  deepStrictEqual(observation.restarts, [{ reason: "item-version-drift", afterRequestId: 3 }]);
  strictEqual(progress.some(message => message.includes("restarting from page one")), true);
});

test("repeated drift is item-changed and neither attempt supplies active pages", async () => {
  const responses = [schema, versionPage(1, true), versionPage(2), versionPage(2, true), versionPage(3)];
  const report = await collectFallbackDiagnostic(probes.slice(0, 1), async () => responses.shift(), signal) as DetailedReport;
  const observation = report.observations[0]!;
  strictEqual(observation.status, "item-changed");
  strictEqual(observation.issue, "item-changed");
  strictEqual(observation.pages.length, 0);
  strictEqual(observation.discardedAttempts?.length, 2);
  strictEqual(observation.restarts?.length, 1);
  strictEqual(report.requests.length, 5);
});

test("restart shares the probe page budget and report-wide request and byte budgets", async () => {
  let calls = 0;
  const report = await collectFallbackDiagnostic(probes.slice(0, 1), async op => {
    if (op === "IntrospectionQuery") { return schema; }
    calls++;
    return versionPage(calls === 1 ? 1 : 2, true, String(calls));
  }, signal) as DetailedReport;
  strictEqual(calls, 50);
  strictEqual(report.observations[0]!.status, "limit-reached");
  strictEqual(report.observations[0]!.pages.length, 48);
  strictEqual(report.observations[0]!.discardedAttempts?.[0]?.pages.length, 2);
  strictEqual(report.coverage.evidenceBytesUsed <= report.coverage.maximumEvidenceBytes, true);

  calls = 0;
  const bounded = await collectFallbackDiagnostic(Array.from({ length: 12 }, () => probes[0]!), async op => {
    calls++;
    return op === "IntrospectionQuery" ? schema : versionPage(1, true, String(calls));
  }, signal) as DetailedReport;
  strictEqual(calls, bounded.coverage.maximumRequests);
  strictEqual(bounded.observations.at(-1)!.status, "limit-reached");
});

test("cancellation and failure during a restarted probe never produce completion or reuse discarded pages", async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    const responses = [schema, versionPage(1, true), versionPage(2)];
    const pending = collectFallbackDiagnostic(probes.slice(0, 1), async () => {
      if (responses.length) { return responses.shift(); }
      if (cancel) { controller.abort(); }
      throw new Error("private failure");
    }, controller.signal);
    if (cancel) { await rejects(pending, { name: "AbortError" }); }
    else {
      const report = await pending as DetailedReport;
      strictEqual(report.observations[0]!.status, "unavailable");
      strictEqual(report.observations[0]!.pages.length, 0);
      strictEqual(report.requests.at(-1)!.status, "unavailable");
      strictEqual(JSON.stringify(report).includes("private failure"), false);
    }
  }
});

test("client report traces actual query, cursor, omitted version and HTTP retries without headers", async () => {
  const runtime = new QueuedHttpRuntime([tokenResponse(), jsonResponse(schema),
    new Response("sensitive-body", { status: 429, headers: { "retry-after": "1", "set-cookie": "private-cookie", "x-private": "private-header" } }),
    jsonResponse(versionPage(2, true)), jsonResponse(versionPage(2)), jsonResponse({ data: { item: null } }),
    jsonResponse({ data: { item: null } })]);
  const client = new AuthoringContentClient(noOpLogger, runtime);
  const text = await client.collectFallbackDiagnostic(testConnection, "client-secret", { itemId: id, languages: ["en-NZ"] }, signal);
  const report = JSON.parse(text) as DetailedReport;
  const first = report.requests[1]!;
  deepStrictEqual(first.httpAttempts.map(a => [a.attempt, a.status, a.retryScheduled, a.retryDelayMilliseconds]),
    [[1, 429, true, 1000], [2, 200, false, undefined]]);
  strictEqual(first.httpAttempts.every(a => typeof a.startedAt === "string" && a.elapsedMilliseconds >= 0), true);
  strictEqual(first.versionSelection, "latest (version omitted)");
  for (const [requestIndex, httpIndex] of [[1, 3], [2, 4], [3, 5], [4, 6]] as const) {
    const request = report.requests[requestIndex]!;
    const body = requestBody(runtime, httpIndex);
    strictEqual(report.queries.find(q => q.id === request.queryId)!.query, body.query);
    deepStrictEqual(request.variables, body.variables);
  }
  strictEqual(report.requests[2]!.variables.after, "next");
  for (const sensitive of ["access-token", "client-secret", "private-cookie", "private-header", "sensitive-body", "authorization", "set-cookie"]) {
    strictEqual(text.includes(sensitive), false, sensitive);
  }
});

test("configuration path reads reject the wrong outer item and retain the failed request trace", async () => {
  const report = await collectFallbackDiagnostic(probes.slice(0, 1), async (op, _query, variables) => {
    if (op === "IntrospectionQuery") { return schema; }
    if ((variables.where as { path?: string }).path) {
      return { data: { item: { ...versionPage(1).data.item, path: "/sitecore/system/Languages/wrong" } } };
    }
    return { data: { item: null } };
  }, signal, undefined, true) as { configuration: { languageItems: { evidence: ProbeEvidence }[] } };
  const evidence = report.configuration.languageItems[0]!.evidence;
  strictEqual(evidence.status, "invalid-response");
  strictEqual(evidence.issue, "outer-item-mismatch");
  deepStrictEqual(evidence.requestIds, [3]);
});

test("HTTP success with a GraphQL failure remains unavailable with safe attempt evidence", async () => {
  const runtime = new QueuedHttpRuntime([tokenResponse(), jsonResponse(schema),
    jsonResponse({ errors: [{ message: "private-graphql-error" }] }), jsonResponse({ data: { item: null } }),
    jsonResponse({ data: { item: null } })]);
  const report = JSON.parse(await new AuthoringContentClient(noOpLogger, runtime).collectFallbackDiagnostic(
    testConnection, "client-secret", { itemId: id, languages: ["en-NZ"] }, signal)) as DetailedReport;
  strictEqual(report.observations[0]!.status, "unavailable");
  deepStrictEqual(report.observations[0]!.requestIds, [2]);
  strictEqual(report.requests[1]!.status, "unavailable");
  strictEqual(report.requests[1]!.httpAttempts[0]!.status, 200);
  strictEqual(JSON.stringify(report).includes("private-graphql-error"), false);
});

test("version-zero null fields are preserved as no-local-fields, not a malformed response", async () => {
  const report = asJson(await collectFallbackDiagnostic(probes.slice(0, 1), async op => op === "IntrospectionQuery" ? schema
    : { data: { item: { itemId: id, version: 0, language: { name: "en-NZ" }, fields: null } } }, signal));
  strictEqual(report.observations[0].status, "complete");
  strictEqual(report.observations[0].outcome, "no-local-fields");
  strictEqual(report.observations[0].pages[0].data.item!.fields, null);
});

test("diagnostic preserves raw missing/null provenance and paginates each exact and cross-check read", async () => {
  const calls: Readonly<Record<string, unknown>>[] = [];
  const responses = [schema, page(true), page(), { data: { item: null } }, page()];
  const report = asJson(await collectFallbackDiagnostic(probes, async (_op, _query, variables) => {
    calls.push(variables); return responses.shift();
  }, signal));
  strictEqual(report.schema.status, "complete");
  deepStrictEqual(report.observations.map((entry: { status: string }) => entry.status), ["complete", "complete", "complete"]);
  strictEqual(calls[2]?.after, "next");
  strictEqual(calls[3]?.after, null);
  strictEqual(report.observations[0].pages[0].data.item!.fields.nodes[0].containsFallbackValue, null);
  strictEqual("containsInheritedValue" in report.observations[0].pages[0].data.item!.fields.nodes[0], false);
  strictEqual(report.observations[1].pages[0].data.item, null);
});

test("schema failure does not prevent probes; failed reads never masquerade as absent items", async () => {
  let calls = 0;
  const report = asJson(await collectFallbackDiagnostic(probes.slice(0, 1), async () => {
    calls++; throw new Error("private server detail");
  }, signal));
  strictEqual(calls, 2);
  strictEqual(report.schema.status, "unavailable");
  strictEqual(report.observations[0].status, "unavailable");
  strictEqual(JSON.stringify(report).includes("private server detail"), false);
});

test("malformed pages, repeated cursors and byte/page limits are explicitly incomplete", async () => {
  for (const [response, expected] of [
    [{ data: {} }, "invalid-response"],
    [{ data: { item: { fields: null } } }, "invalid-response"],
    [page(true), "invalid-response"],
    [{ data: { item: { value: "x".repeat(6 * 1024 * 1024) } } }, "limit-reached"],
  ] as const) {
    const report = asJson(await collectFallbackDiagnostic(probes.slice(0, 1), async op => op === "IntrospectionQuery" ? schema : response, signal));
    strictEqual(report.observations[0].status, expected);
  }
  let cursor = 0;
  const report = asJson(await collectFallbackDiagnostic(probes.slice(0, 1), async op => op === "IntrospectionQuery" ? schema : page(true, String(cursor++)), signal));
  strictEqual(report.observations[0].pages.length, 50);
  strictEqual(report.observations[0].status, "limit-reached");
});

test("diagnostic cancels before requests and after a request that ignores cancellation", async () => {
  let calls = 0;
  await rejects(collectFallbackDiagnostic(probes, async () => { calls++; }, AbortSignal.abort()), { name: "AbortError" });
  strictEqual(calls, 0);
  const controller = new AbortController();
  await rejects(collectFallbackDiagnostic(probes, async () => { controller.abort(); return schema; }, controller.signal), { name: "AbortError" });
});

test("diagnostic client uses existing authentication, fixed queries and strips known credentials from report", async () => {
  const runtime = new QueuedHttpRuntime([tokenResponse(), jsonResponse(schema),
    jsonResponse({ data: { item: null } }), jsonResponse({ data: { item: { fields: { nodes: [{ value: "client-secret access-token" }], pageInfo: { hasNextPage: false } } } } }),
    jsonResponse({ data: { item: null } })]);
  const client = new AuthoringContentClient(noOpLogger, runtime);
  const text = await client.collectFallbackDiagnostic(testConnection, "client-secret", { itemId: id, languages: ["en"] }, signal);
  strictEqual(text.includes("client-secret"), false);
  strictEqual(text.includes("access-token"), false);
  for (let i = 1; i < runtime.requests.length; i++) {
    strictEqual(String(runtime.requests[i]!.input), "https://cm.example.com/sitecore/api/authoring/graphql/v1/");
    const operations = parse(requestBody(runtime, i).query as string).definitions.filter(definition => definition.kind === Kind.OPERATION_DEFINITION);
    deepStrictEqual(operations.map(operation => operation.operation), ["query"]);
  }
  strictEqual((requestBody(runtime, 2).query as string).includes("withLanguageFallback: false"), true);
  strictEqual((requestBody(runtime, 3).query as string).includes("withLanguageFallback: true"), true);
  strictEqual((requestBody(runtime, 4).query as string).includes("withLanguageFallback: false"), true);
  deepStrictEqual((requestBody(runtime, 4).variables as { where: unknown }).where,
    { database: "master", language: "en", path: "/sitecore/system/Languages/en" });
  deepStrictEqual(JSON.parse(serializeFallbackDiagnostic({ value: 'a"b\nc' }, ['a"b\nc'])), { value: "[REDACTED]" });
  deepStrictEqual(JSON.parse(serializeFallbackDiagnostic({ ":": ":" }, [":"])), { "[REDACTED]": "[REDACTED]" });
});

test("diagnostic validates inputs before authentication and supports schema-only requests", async () => {
  const runtime = new QueuedHttpRuntime([tokenResponse(), jsonResponse(schema)]);
  const client = new AuthoringContentClient(noOpLogger, runtime);
  await rejects(client.collectFallbackDiagnostic(testConnection, "test-secret", { itemId: "invalid", languages: ["en"] }, signal));
  strictEqual(runtime.requests.length, 0);
  const report = JSON.parse(await client.collectFallbackDiagnostic(testConnection, "test-secret", undefined, signal));
  strictEqual(report.observations.length, 0);
  strictEqual(runtime.requests.length, 2);
});
