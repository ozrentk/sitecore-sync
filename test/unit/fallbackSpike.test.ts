import { deepStrictEqual, match, strictEqual, throws } from "node:assert/strict";
import { test } from "node:test";
import { buildSchema, introspectionFromSchema, Kind, parse, visit } from "graphql";
import { buildFallbackProbes, validateFallbackProbes } from "../../scripts/fallback-spike";

const id = "00000000-0000-0000-0000-000000000001";

test("fallback spike reads every candidate exactly and cross-checks only the original locale", () => {
  const probes = buildFallbackProbes(id, ["en-NZ", "en-AU", "en"]);
  deepStrictEqual(probes.map(probe => probe.variables.where.language), ["en-NZ", "en-AU", "en", "en-NZ"]);
  for (const [index, probe] of probes.entries()) {
    const operations: string[] = [];
    const flags: boolean[] = [];
    visit(parse(probe.query), {
      OperationDefinition(node) { operations.push(node.operation); },
      Argument(node) {
        if (node.name.value === "withLanguageFallback" && node.value.kind === Kind.BOOLEAN) {
          flags.push(node.value.value);
        }
      },
    });
    deepStrictEqual(operations, ["query"]);
    deepStrictEqual(flags, [index === 3]);
    deepStrictEqual(probe.variables, { where: { database: "master", itemId: id, language: probes[index]!.variables.where.language }, pageSize: 100, after: null });
    match(probe.query, /containsStandardValue/u);
    match(probe.query, /containsInheritedValue/u);
    match(probe.query, /containsFallbackValue/u);
    match(probe.query, /versions\(allLanguages: true\)/u);
    match(probe.query, /hasNextPage/u);
  }
});

test("fallback spike accepts a single locale without inventing a fallback chain", () => {
  strictEqual(buildFallbackProbes(`{${id}}`, ["en"]).length, 2);
});

test("fallback spike bounds requests and rejects malformed or duplicate inputs", () => {
  for (const languages of [[], ["en", "EN"], ["en\nquery"], [""], Array.from({ length: 9 }, (_, i) => `en-${i}`)]) {
    throws(() => buildFallbackProbes(id, languages), /Supply/u);
  }
  for (const invalid of ["item", `{${id}`, `${id}}`, "../item"]) {
    throws(() => buildFallbackProbes(invalid, ["en"]), /GUID/u);
  }
});

test("fallback spike validates against a supplied contract and reports missing fields", () => {
  const schema = "type Query { value: String }";
  const probe = { ...buildFallbackProbes(id, ["en"])[0]!, query: "query { value }" };
  deepStrictEqual(validateFallbackProbes(schema, [probe]), []);
  const introspection = introspectionFromSchema(buildSchema(schema));
  deepStrictEqual(validateFallbackProbes(JSON.stringify(introspection), [probe]), []);
  deepStrictEqual(validateFallbackProbes(JSON.stringify({ data: introspection }), [probe]), []);
  match(validateFallbackProbes(schema, [{ ...probe, query: "query { missing }" }])[0]!, /Cannot query field/u);
  throws(() => validateFallbackProbes("{}", [probe]), /introspection/u);
  throws(() => validateFallbackProbes("not SDL", [probe]));
});
