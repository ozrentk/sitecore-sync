import {
  deepStrictEqual,
  match,
  strictEqual,
  throws,
} from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import type { AuthoringItemDetails } from "../../src/sitecore/authoringClient";
import {
  itemAncestorPaths,
  matchesItem,
  parseItemTaskManifest,
  validateNumberInput,
  type ItemTaskMatchRules,
  type NumberTaskInput,
} from "../../src/tasks/itemTaskManifest";

const taskDirectory = resolve(process.cwd(), "test-fixtures", "item-task");
const manifestPath = resolve(taskDirectory, "task.json");

test("item task manifest parses every supported execution and input shape", () => {
  const plugin = parseItemTaskManifest({
    id: " example-task ",
    name: " Example task ",
    description: " Demonstrates parsing ",
    script: "scripts/run.mjs",
    execution: { type: "javascript" },
    matches: {
      templateIds: [" {AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE} "],
      itemIds: ["item-id"],
      parentPaths: [" /sitecore/content/Tenant/Site "],
      ancestorPaths: ["/sitecore/content"],
    },
    inputs: [
      {
        id: "title",
        type: "text",
        label: " Title ",
        description: " Optional title ",
        placeholder: " Enter a title ",
        default: "",
      },
      {
        id: "count",
        type: "number",
        required: true,
        minimum: 1,
        maximum: 10,
        default: 3,
      },
      { id: "enabled", type: "boolean", default: true },
      {
        id: "mode",
        type: "pick",
        required: true,
        default: 2,
        options: [
          "one",
          { label: "Second", value: 2, description: "Numeric choice" },
          false,
        ],
      },
    ],
  }, manifestPath);

  strictEqual(plugin.id, "example-task");
  strictEqual(plugin.name, "Example task");
  strictEqual(plugin.description, "Demonstrates parsing");
  strictEqual(plugin.directoryPath, taskDirectory);
  strictEqual(plugin.scriptPath, resolve(taskDirectory, "scripts", "run.mjs"));
  deepStrictEqual(plugin.execution, { type: "javascript" });
  deepStrictEqual(plugin.matches, {
    templateIds: ["{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}"],
    itemIds: ["item-id"],
    parentPaths: ["/sitecore/content/Tenant/Site"],
    ancestorPaths: ["/sitecore/content"],
  });
  strictEqual(plugin.inputs.length, 4);
  deepStrictEqual(plugin.inputs[1], {
    id: "count",
    label: "count",
    description: undefined,
    required: true,
    type: "number",
    defaultValue: 3,
    minimum: 1,
    maximum: 10,
    placeholder: undefined,
  });
  deepStrictEqual(plugin.inputs[3], {
    id: "mode",
    label: "mode",
    description: undefined,
    required: true,
    type: "pick",
    defaultValue: 2,
    options: [
      { label: "one", value: "one" },
      { label: "Second", value: 2, description: "Numeric choice" },
      { label: "false", value: false },
    ],
  });
});

test("item task manifest defaults to local PowerShell execution", () => {
  const plugin = parseItemTaskManifest({
    id: "powershell-task",
    name: "PowerShell task",
    script: "run.PS1",
    matches: { itemIds: ["item-id"] },
  }, manifestPath);

  deepStrictEqual(plugin.execution, { type: "powershell" });
  deepStrictEqual(plugin.inputs, []);
});

test("item task manifest keeps scripts inside their plug-in directory", () => {
  for (const script of ["../outside.ps1", resolve(taskDirectory, "..", "outside.ps1")]) {
    throws(
      () => parseItemTaskManifest({
        ...baseManifest(),
        script,
      }, manifestPath),
      /must be inside its manifest directory/u,
    );
  }
});

test("item task manifest enforces script extensions for each execution type", () => {
  const invalid = [
    [{ type: "javascript" }, "run.ps1", /JavaScript tasks require/u],
    [{ type: "powershell" }, "run.js", /PowerShell tasks require/u],
    [{ type: "spe-remoting" }, "run.mjs", /PowerShell tasks require/u],
  ] as const;
  for (const [execution, script, expected] of invalid) {
    throws(
      () => parseItemTaskManifest({ ...baseManifest(), execution, script }, manifestPath),
      expected,
    );
  }
});

test("item task manifest rejects malformed core properties and match rules", () => {
  const invalid: readonly [unknown, RegExp][] = [
    [null, /JSON object/u],
    [[], /JSON object/u],
    [{ ...baseManifest(), id: " " }, /property “id”/u],
    [{ ...baseManifest(), execution: "javascript" }, /execution.*object/u],
    [{ ...baseManifest(), execution: { type: "shell" } }, /execution\.type/u],
    [{ ...baseManifest(), matches: undefined }, /matches.*required/u],
    [{ ...baseManifest(), matches: {} }, /matching rule/u],
    [{ ...baseManifest(), matches: { itemIds: [""] } }, /non-empty strings/u],
  ];
  for (const [value, expected] of invalid) {
    throws(() => parseItemTaskManifest(value, manifestPath), expected);
  }
});

test("item task manifest rejects inconsistent input definitions", () => {
  const invalidInputs: readonly [readonly unknown[], RegExp][] = [
    [[null], /input 1 must be an object/u],
    [[{ id: "1bad", type: "text" }], /input ID/u],
    [[{ id: "same", type: "text" }, { id: "SAME", type: "text" }], /duplicated/u],
    [[{ id: "value", type: "unknown" }], /must be “text”, “number”, “pick”, or “boolean”/u],
    [[{ id: "value", type: "number", minimum: 5, maximum: 2 }], /minimum greater/u],
    [[{ id: "value", type: "number", minimum: 1, default: 0 }], /default outside/u],
    [[{ id: "value", type: "boolean", default: "yes" }], /must be a boolean/u],
    [[{ id: "value", type: "pick", options: [] }], /non-empty array/u],
    [[{ id: "value", type: "pick", options: [null] }], /pick option 1 is invalid/u],
    [[{ id: "value", type: "pick", options: ["one"], default: "two" }], /not one of its options/u],
  ];
  for (const [inputs, expected] of invalidInputs) {
    throws(
      () => parseItemTaskManifest({ ...baseManifest(), inputs }, manifestPath),
      expected,
    );
  }
});

test("item task matching normalizes IDs and combines rules with OR semantics", () => {
  const item = matchingItem();
  const ruleSets: readonly ItemTaskMatchRules[] = [
    rules({ itemIds: ["{11111111-2222-3333-4444-555555555555}"] }),
    rules({ templateIds: ["{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}"] }),
    rules({ parentPaths: ["\\sitecore\\content\\tenant\\site\\"] }),
    rules({ ancestorPaths: ["SITECORE/CONTENT/TENANT"] }),
  ];

  for (const ruleSet of ruleSets) {
    strictEqual(matchesItem(ruleSet, item), true);
  }
  strictEqual(matchesItem(rules({ parentPaths: ["/sitecore/content/Tenant"] }), item), false);
  strictEqual(matchesItem(rules({ ancestorPaths: ["/sitecore/contention"] }), item), false);
});

test("item task ancestor paths are normalized and exclude the item itself", () => {
  deepStrictEqual(itemAncestorPaths(" sitecore\\content//Tenant/Site/Home/ "), [
    "/sitecore",
    "/sitecore/content",
    "/sitecore/content/Tenant",
    "/sitecore/content/Tenant/Site",
  ]);
  deepStrictEqual(itemAncestorPaths("/"), []);
});

test("number input validation covers required, finite, and bounded values", () => {
  const input: NumberTaskInput = {
    id: "count",
    label: "Count",
    type: "number",
    required: true,
    minimum: 1,
    maximum: 5,
  };
  match(String(validateNumberInput("", input)), /required/u);
  match(String(validateNumberInput("many", input)), /must be a number/u);
  match(String(validateNumberInput("0", input)), /at least 1/u);
  match(String(validateNumberInput("6", input)), /at most 5/u);
  strictEqual(validateNumberInput("3", input), undefined);
  strictEqual(validateNumberInput("", { ...input, required: false }), undefined);
});

function baseManifest(): Record<string, unknown> {
  return {
    id: "task",
    name: "Task",
    script: "run.ps1",
    matches: { itemIds: ["item-id"] },
  };
}

function rules(overrides: Partial<ItemTaskMatchRules>): ItemTaskMatchRules {
  return {
    templateIds: [],
    itemIds: [],
    parentPaths: [],
    ancestorPaths: [],
    ...overrides,
  };
}

function matchingItem(): Pick<AuthoringItemDetails, "itemId" | "path" | "template"> {
  return {
    itemId: "11111111222233334444555555555555",
    path: "/sitecore/content/Tenant/Site/Home",
    template: {
      templateId: "aaaaaaaabbbbccccddddeeeeeeeeeeee",
      name: "Page",
    },
  };
}
