import { parseFragment, type DefaultTreeAdapterTypes as P } from "parse5";

/** Format changed Visual output. Inline boundary spacing is deliberately normalized. */
export function formatManagedHtml(raw: string): string {
  if (raw.length > 262144) return raw;
  const root = parseFragment(raw, { sourceCodeLocationInfo: true });
  const containers = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "div", "span", "a",
    "strong", "b", "em", "i", "u", "s", "strike", "del", "sub", "sup",
    "table", "caption", "colgroup", "thead", "tbody", "tfoot", "tr", "td", "th", "ul", "ol", "li", "blockquote"]);
  const edgeWhitespace = /^(?:\s|&nbsp;|&#0*160;|&#x0*a0;)+|(?:\s|&nbsp;|&#0*160;|&#x0*a0;)+$/giu;
  const countNodes = (node: P.ParentNode): number => node.childNodes.reduce((count, child) => count + 1 + ("childNodes" in child ? countNodes(child) : 0), 0);
  function render(node: P.ChildNode, depth: number): string {
    const location = node.sourceCodeLocation;
    if (!location) throw new Error("Cannot format an implied HTML node.");
    const token = raw.slice(location.startOffset, location.endOffset);
    const indent = "  ".repeat(depth);
    if (node.nodeName === "#text") {
      const text = token.replace(edgeWhitespace, "").replace(/[\t\r\n ]+/gu, " ");
      return text ? indent + text : "";
    }
    // Preserve opaque content and whitespace-sensitive subtrees byte-for-byte.
    if (!("tagName" in node) || !containers.has(node.tagName) ||
      node.attrs.some(attr => attr.name === "style" && /white-space\s*:/iu.test(attr.value))) return indent + token;
    const elementLocation = node.sourceCodeLocation;
    if (!elementLocation?.startTag || !elementLocation.endTag) throw new Error("Cannot format implicit element boundaries.");
    const open = raw.slice(elementLocation.startTag.startOffset, elementLocation.startTag.endOffset);
    const close = raw.slice(elementLocation.endTag.startOffset, elementLocation.endTag.endOffset);
    const children = node.childNodes.map(child => render(child, depth + 1)).filter(Boolean);
    return indent + open + "\n" + (children.length ? children.join("\n") + "\n" : "") + indent + close;
  }
  try {
    const result = root.childNodes.map(node => render(node, 0)).filter(Boolean).join("\n");
    // Layout text also counts toward the visual admission budget.
    return result.length <= 262144 && countNodes(parseFragment(result)) <= 5000 ? result : raw;
  } catch {
    return raw;
  }
}
