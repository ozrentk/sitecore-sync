import type { AuthoringItemLocator } from "../sitecore/authoringClient";

export type NavigationInput =
  | { readonly kind: "empty" }
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "name"; readonly text: string }
  | { readonly kind: "id" | "path"; readonly locator: AuthoringItemLocator };

export function classifyNavigationInput(value: string): NavigationInput {
  const text = value.trim();
  if (!text) { return { kind: "empty" }; }
  if (text.length > 2048) { return { kind: "invalid", message: "Enter at most 2048 characters." }; }
  const id = text.startsWith("{") && text.endsWith("}") ? text.slice(1, -1) : text;
  if (/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/iu.test(id)) {
    return { kind: "id", locator: { itemId: id.replace(/-/gu, "").toLowerCase() } };
  }
  if (text.startsWith("/")) {
    if (/[\\\x00-\x1f]/u.test(text) || text.split("/").some(part => part === "." || part === "..")) {
      return { kind: "invalid", message: "Enter an absolute Sitecore path without relative segments or backslashes." };
    }
    return { kind: "path", locator: { path: text.replace(/\/{2,}/gu, "/").replace(/\/$/u, "") || "/" } };
  }
  if (/[{}]/u.test(text) || /^[a-f0-9-]{28,}$/iu.test(text)) {
    return { kind: "invalid", message: "An item ID needs 32 hexadecimal digits, optionally dashed and enclosed in braces." };
  }
  return { kind: "name", text };
}

export function isWithinPath(path: string, root: string): boolean {
  const base = root.replace(/\/$/u, "").toLowerCase();
  const candidate = path.toLowerCase();
  return candidate === base || candidate.startsWith(`${base}/`);
}
