import { readFileSync } from "node:fs";
import {
  buildClientSchema, buildSchema, getIntrospectionQuery, parse, validate,
  type IntrospectionQuery,
} from "graphql";
import { buildFallbackProbes, type FallbackProbe } from "../src/sitecore/fallbackDiagnostics";
export { buildFallbackProbes } from "../src/sitecore/fallbackDiagnostics";

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
