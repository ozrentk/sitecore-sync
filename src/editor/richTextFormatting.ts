import { parseFragment, type DefaultTreeAdapterTypes as P } from "parse5";

/** Add layout whitespace only between block/structural elements; never touch inline text or tokens. */
export function formatManagedHtml(raw: string): string {
  const root = parseFragment(raw, { sourceCodeLocationInfo: true });
  const blocks = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "table", "ul", "ol", "blockquote", "hr", "div"]);
  const containers = new Set(["table", "thead", "tbody", "tfoot", "tr", "ul", "ol", "li", "blockquote", "td", "th"]);
  const edits: { position: number; value: string }[] = [];
  function visit(parent: P.ParentNode, depth: number): void {
    const tag = "tagName" in parent ? parent.tagName : "";
    if ("attrs" in parent && parent.attrs.some(attr => attr.name === "style" && /white-space\s*:/iu.test(attr.value))) return;
    const elements = parent.childNodes.filter((node): node is P.Element => "tagName" in node);
    const onlyBlocks = elements.length > 0 && parent.childNodes.every(node => "tagName" in node || node.nodeName === "#text" && /^\s*$/u.test((node as P.TextNode).value));
    const layout = onlyBlocks && (!tag ? elements.every(node => blocks.has(node.tagName)) : containers.has(tag) && elements.every(node => blocks.has(node.tagName) || ["caption", "colgroup", "col", "thead", "tbody", "tfoot", "tr", "td", "th", "li"].includes(node.tagName)));
    if (layout) {
      let cursor = "tagName" in parent ? parent.sourceCodeLocation?.startTag?.endOffset : 0;
      for (let i = 0; i < elements.length; i++) {
        const location = elements[i].sourceCodeLocation;
        if (location && cursor === location.startOffset && (tag || i > 0)) edits.push({ position: location.startOffset, value: "\n" + "  ".repeat(depth) });
        cursor = location?.endOffset;
      }
      if (tag && "tagName" in parent && cursor === parent.sourceCodeLocation?.endTag?.startOffset) edits.push({ position: cursor!, value: "\n" + "  ".repeat(Math.max(0, depth - 1)) });
    }
    if (!tag || containers.has(tag)) for (const element of elements) visit(element, depth + 1);
  }
  visit(root, 0);
  let result = raw;
  for (const edit of edits.sort((a, b) => b.position - a.position)) result = result.slice(0, edit.position) + edit.value + result.slice(edit.position);
  const countNodes = (node: P.ParentNode): number => node.childNodes.reduce((count, child) => count + 1 + ("childNodes" in child ? countNodes(child) : 0), 0);
  // Added layout text must not push an otherwise editable document past admission limits.
  return result.length <= 262144 && countNodes(root) + edits.length <= 5000 ? result : raw;
}
