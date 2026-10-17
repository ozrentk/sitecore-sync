/** Canonical new markup; imported spelling and attributes remain in retained tokens. */
export const richMarkTags: Readonly<Record<string, string>> = { bold: "strong", italic: "em", underline: "u", strike: "s", subscript: "sub", superscript: "sup" };
export const richMarkNames = Object.keys(richMarkTags);
const importedMarks: Readonly<Record<string, string>> = { strong: "bold", b: "bold", em: "italic", i: "italic", u: "underline", s: "strike", strike: "strike", sub: "subscript", sup: "superscript" };
export function richMarkType(tag: string): string | undefined {
  return Object.hasOwn(importedMarks, tag) ? importedMarks[tag] : undefined;
}
