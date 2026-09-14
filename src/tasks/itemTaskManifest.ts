import * as path from "node:path";
import type { AuthoringItemDetails } from "../sitecore/authoringClient";

export interface ItemTaskMatchRules {
  readonly templateIds: readonly string[];
  readonly itemIds: readonly string[];
  readonly parentPaths: readonly string[];
  readonly ancestorPaths: readonly string[];
}

export interface ItemTaskPlugin {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly scriptPath: string;
  readonly directoryPath: string;
  readonly matches: ItemTaskMatchRules;
  readonly execution: ItemTaskExecution;
  readonly inputs: readonly ItemTaskInput[];
}

export type ItemTaskExecution =
  | { readonly type: "powershell" }
  | { readonly type: "javascript" }
  | { readonly type: "spe-remoting" };

interface ItemTaskInputBase {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly required: boolean;
}

export interface TextTaskInput extends ItemTaskInputBase {
  readonly type: "text";
  readonly defaultValue?: string;
  readonly placeholder?: string;
}

export interface NumberTaskInput extends ItemTaskInputBase {
  readonly type: "number";
  readonly defaultValue?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly placeholder?: string;
}

export interface PickTaskInputOption {
  readonly label: string;
  readonly value: string | number | boolean;
  readonly description?: string;
}

export interface PickTaskInput extends ItemTaskInputBase {
  readonly type: "pick";
  readonly defaultValue?: string | number | boolean;
  readonly options: readonly PickTaskInputOption[];
}

export interface BooleanTaskInput extends ItemTaskInputBase {
  readonly type: "boolean";
  readonly defaultValue: boolean;
}

export type ItemTaskInput =
  | TextTaskInput
  | NumberTaskInput
  | PickTaskInput
  | BooleanTaskInput;

export type ItemTaskInputValue = string | number | boolean;

export function parseItemTaskManifest(
  value: unknown,
  manifestPath: string,
): ItemTaskPlugin {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Manifest must contain a JSON object.");
  }
  const candidate = value as Record<string, unknown>;
  const id = requiredText(candidate.id, "id");
  const name = requiredText(candidate.name, "name");
  const script = requiredText(candidate.script, "script");
  const matches = parseMatchRules(candidate.matches);
  const execution = parseExecution(candidate.execution);
  const inputs = parseTaskInputs(candidate.inputs);
  const directoryPath = path.dirname(manifestPath);
  const scriptPath = path.resolve(directoryPath, script);
  const relativeScriptPath = path.relative(directoryPath, scriptPath);
  if (relativeScriptPath.startsWith("..") || path.isAbsolute(relativeScriptPath)) {
    throw new Error("The task script must be inside its manifest directory.");
  }
  const extension = path.extname(scriptPath).toLowerCase();
  if (
    (execution.type === "javascript" && ![".js", ".cjs", ".mjs"].includes(extension)) ||
    (execution.type !== "javascript" && extension !== ".ps1")
  ) {
    throw new Error(
      execution.type === "javascript"
        ? "JavaScript tasks require a .js, .cjs, or .mjs script."
        : "PowerShell tasks require a .ps1 script.",
    );
  }
  return {
    id,
    name,
    description: optionalText(candidate.description),
    scriptPath,
    directoryPath,
    matches,
    execution,
    inputs,
  };
}

export function matchesItem(
  rules: ItemTaskMatchRules,
  item: Pick<AuthoringItemDetails, "itemId" | "path" | "template">,
): boolean {
  const itemId = normalizeId(item.itemId);
  const templateId = normalizeId(item.template.templateId);
  const pathValue = normalizePath(item.path);
  const ancestors = itemAncestorPaths(pathValue).map((entry) => entry.toLowerCase());
  const parent = ancestors.at(-1);
  return rules.itemIds.some((value) => normalizeId(value) === itemId) ||
    rules.templateIds.some((value) => normalizeId(value) === templateId) ||
    rules.parentPaths.some((value) => normalizePath(value).toLowerCase() === parent) ||
    rules.ancestorPaths.some((value) => ancestors.includes(normalizePath(value).toLowerCase()));
}

export function itemAncestorPaths(itemPath: string): readonly string[] {
  const segments = normalizePath(itemPath).split("/").filter(Boolean);
  const ancestors: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    ancestors.push(`/${segments.slice(0, index).join("/")}`);
  }
  return ancestors;
}

export function validateNumberInput(
  value: string,
  input: NumberTaskInput,
): string | undefined {
  if (!value.trim()) {
    return input.required ? `${input.label} is required.` : undefined;
  }
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    return `${input.label} must be a number.`;
  }
  if (input.minimum !== undefined && numberValue < input.minimum) {
    return `${input.label} must be at least ${input.minimum}.`;
  }
  if (input.maximum !== undefined && numberValue > input.maximum) {
    return `${input.label} must be at most ${input.maximum}.`;
  }
  return undefined;
}

function parseExecution(value: unknown): ItemTaskExecution {
  if (value === undefined) {
    return { type: "powershell" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Manifest property “execution” must be an object.");
  }
  const type = requiredText((value as Record<string, unknown>).type, "execution.type");
  if (type !== "powershell" && type !== "javascript" && type !== "spe-remoting") {
    throw new Error(
      "Manifest property “execution.type” must be “javascript”, “powershell”, or “spe-remoting”.",
    );
  }
  return { type };
}

function parseTaskInputs(value: unknown): readonly ItemTaskInput[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("Manifest property “inputs” must be an array.");
  }
  const ids = new Set<string>();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Manifest input ${index + 1} must be an object.`);
    }
    const candidate = entry as Record<string, unknown>;
    const id = requiredText(candidate.id, `inputs[${index}].id`);
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/u.test(id)) {
      throw new Error(`Manifest input ID “${id}” is invalid.`);
    }
    if (ids.has(id.toLowerCase())) {
      throw new Error(`Manifest input ID “${id}” is duplicated.`);
    }
    ids.add(id.toLowerCase());
    const type = requiredText(candidate.type, `inputs[${index}].type`);
    const base = {
      id,
      label: optionalText(candidate.label) ?? id,
      description: optionalText(candidate.description),
      required: candidate.required === true,
    };
    if (type === "text") {
      return {
        ...base,
        type,
        defaultValue: optionalString(candidate.default, `inputs[${index}].default`),
        placeholder: optionalText(candidate.placeholder),
      } satisfies TextTaskInput;
    }
    if (type === "number") {
      const minimum = optionalNumber(candidate.minimum, `inputs[${index}].minimum`);
      const maximum = optionalNumber(candidate.maximum, `inputs[${index}].maximum`);
      const defaultValue = optionalNumber(candidate.default, `inputs[${index}].default`);
      if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
        throw new Error(`Manifest input “${id}” has minimum greater than maximum.`);
      }
      if (defaultValue !== undefined && (
        (minimum !== undefined && defaultValue < minimum) ||
        (maximum !== undefined && defaultValue > maximum)
      )) {
        throw new Error(`Manifest input “${id}” has a default outside its allowed range.`);
      }
      return {
        ...base,
        type,
        defaultValue,
        minimum,
        maximum,
        placeholder: optionalText(candidate.placeholder),
      } satisfies NumberTaskInput;
    }
    if (type === "boolean") {
      if (candidate.default !== undefined && typeof candidate.default !== "boolean") {
        throw new Error(`Manifest property “inputs[${index}].default” must be a boolean.`);
      }
      return {
        ...base,
        type,
        defaultValue: candidate.default === true,
      } satisfies BooleanTaskInput;
    }
    if (type === "pick") {
      const options = parsePickOptions(candidate.options, index);
      const defaultValue = optionalScalar(candidate.default, `inputs[${index}].default`);
      if (defaultValue !== undefined && !options.some((option) => option.value === defaultValue)) {
        throw new Error(`Manifest input “${id}” has a default that is not one of its options.`);
      }
      return { ...base, type, defaultValue, options } satisfies PickTaskInput;
    }
    throw new Error(
      `Manifest property “inputs[${index}].type” must be “text”, “number”, “pick”, or “boolean”.`,
    );
  });
}

function parsePickOptions(
  value: unknown,
  inputIndex: number,
): readonly PickTaskInputOption[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Manifest property “inputs[${inputIndex}].options” must be a non-empty array.`);
  }
  return value.map((entry, optionIndex) => {
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
      return { label: String(entry), value: entry };
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Manifest pick option ${optionIndex + 1} is invalid.`);
    }
    const candidate = entry as Record<string, unknown>;
    return {
      label: requiredText(candidate.label, `inputs[${inputIndex}].options[${optionIndex}].label`),
      value: requiredScalar(candidate.value, `inputs[${inputIndex}].options[${optionIndex}].value`),
      description: optionalText(candidate.description),
    };
  });
}

function parseMatchRules(value: unknown): ItemTaskMatchRules {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Manifest property “matches” is required.");
  }
  const candidate = value as Record<string, unknown>;
  const matches = {
    templateIds: stringArray(candidate.templateIds, "matches.templateIds"),
    itemIds: stringArray(candidate.itemIds, "matches.itemIds"),
    parentPaths: stringArray(candidate.parentPaths, "matches.parentPaths"),
    ancestorPaths: stringArray(candidate.ancestorPaths, "matches.ancestorPaths"),
  };
  if (Object.values(matches).every((entries) => entries.length === 0)) {
    throw new Error("At least one item-matching rule is required.");
  }
  return matches;
}

function normalizePath(value: string): string {
  const normalized = value.trim().replace(/\\/gu, "/").replace(/\/{2,}/gu, "/");
  if (!normalized.startsWith("/")) {
    return `/${normalized}`.replace(/\/$/u, "") || "/";
  }
  return normalized.replace(/\/$/u, "") || "/";
}

function normalizeId(value: string): string {
  return value.replace(/[{}-]/gu, "").toLowerCase();
}

function requiredText(value: unknown, property: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Manifest property “${property}” must be a non-empty string.`);
  }
  return value.trim();
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalString(value: unknown, property: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Manifest property “${property}” must be a string.`);
  }
  return value;
}

function optionalNumber(value: unknown, property: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Manifest property “${property}” must be a finite number.`);
  }
  return value;
}

function optionalScalar(value: unknown, property: string): ItemTaskInputValue | undefined {
  return value === undefined ? undefined : requiredScalar(value, property);
}

function requiredScalar(value: unknown, property: string): ItemTaskInputValue {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    throw new Error(`Manifest property “${property}” must be a string, number, or boolean.`);
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error(`Manifest property “${property}” must be finite.`);
  }
  return value;
}

function stringArray(value: unknown, property: string): readonly string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error(`Manifest property “${property}” must be an array of non-empty strings.`);
  }
  return value.map((entry) => String(entry).trim());
}
