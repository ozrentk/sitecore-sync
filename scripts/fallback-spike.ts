import { readFileSync } from "node:fs";
import {
  buildClientSchema, buildSchema, getIntrospectionQuery, Kind, parse, print, validate, visit,
  type IntrospectionQuery,
} from "graphql";
import { itemDetailsQuery } from "../src/sitecore/graphql/authoringQueries";

export interface FallbackProbe {
  readonly label: string;
  readonly query: string;
  readonly variables: {
    readonly where: { readonly database: string; readonly itemId: string; readonly language: string };
    readonly pageSize: number;
    readonly after: null;
  };
}

/** Generates requests only. No network, credentials, content writes or inferred configuration. */
export function buildFallbackProbes(itemId: string, languages: readonly string[]): readonly FallbackProbe[] {
  if (!/^\{?[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}\}?$/iu.test(itemId)
    || itemId.startsWith("{") !== itemId.endsWith("}")) {
    throw new Error("Supply an item GUID.");
  }
  if (languages.length < 1 || languages.length > 8
    || languages.some(language => !/^[a-z]{2,8}(?:-[a-z\d]{1,8})*$/iu.test(language))
    || new Set(languages.map(language => language.toLowerCase())).size !== languages.length) {
    throw new Error("Supply 1–8 distinct language names: requested locale first, then known candidates.");
  }
  const exact = print(itemDetailsQuery);
  const crossCheck = print(visit(itemDetailsQuery, {
    Argument(node) {
      return node.name.value === "withLanguageFallback"
        ? { ...node, value: { kind: Kind.BOOLEAN, value: true } }
        : undefined;
    },
  }));
  const probe = (language: string, fallback: boolean): FallbackProbe => ({
    label: `${language}: ${fallback ? "Sitecore cross-check" : "exact locale"}`,
    query: fallback ? crossCheck : exact,
    variables: { where: { database: "master", itemId, language }, pageSize: 100, after: null },
  });
  return [...languages.map(language => probe(language, false)), probe(languages[0]!, true)];
}

/** Checks the exported environment contract without treating schema compatibility as runtime proof. */
export function validateFallbackProbes(schemaText: string, probes: readonly FallbackProbe[]): readonly string[] {
  const trimmed = schemaText.trim();
  let schema;
  if (trimmed.startsWith("{")) {
    const json: unknown = JSON.parse(trimmed);
    const candidate = json && typeof json === "object" && "data" in json ? json.data : json;
    if (!candidate || typeof candidate !== "object" || !("__schema" in candidate)) {
      throw new Error("Expected an introspection response or SDL schema.");
    }
    // buildClientSchema validates the introspection structure at this external boundary.
    schema = buildClientSchema(candidate as IntrospectionQuery);
  } else {
    schema = buildSchema(trimmed);
  }
  return [...new Set(probes.flatMap(probe => validate(schema, parse(probe.query)).map(error => error.message)))];
}

if (require.main === module) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === "schema" && args.length === 0) {
      process.stdout.write(getIntrospectionQuery({ descriptions: true }));
    } else if (command === "probes" && args.length >= 2) {
      process.stdout.write(JSON.stringify(buildFallbackProbes(args[0]!, args.slice(1)), null, 2));
    } else if (command === "validate" && args.length === 1) {
      const probes = buildFallbackProbes("00000000-0000-0000-0000-000000000001", ["en"]);
      const errors = validateFallbackProbes(readFileSync(args[0]!, "utf8"), probes);
      process.stdout.write(errors.length ? errors.join("\n") : "Probe queries match the exported schema. Runtime behavior remains unverified.");
      process.exitCode = errors.length ? 1 : 0;
    } else {
      throw new Error("Usage: node --import tsx scripts/fallback-spike.ts schema | probes <item-guid> <requested> [candidate ...] | validate <schema-file>");
    }
  } catch (error) {
    // Do not echo schema content, paths, credentials or arbitrary parser error details.
    process.stderr.write(error instanceof Error && (error.message.startsWith("Usage:")
      || error.message.startsWith("Supply")) ? error.message : "Unable to validate the schema. Check its SDL/introspection format.");
    process.exitCode = 1;
  }
}
