/** Rebuild a bounded, shape-only SVG. Never forward arbitrary SVG markup to a webview. */
export function safeSvgPreview(input: string): string {
  if (input.length > 1024 * 1024) throw Error("SVG preview exceeds 1 MiB.");
  const raw = input.replace(/^\uFEFF/u, "").replace(/^\s*<\?xml\s+version=["']1\.0["'](?:\s+encoding=["']utf-8["'])?\s*\?>/iu, "");
  const tags = new Set(["svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "defs", "clipPath"]);
  const number = /^[+\-]?(?:\d+\.?\d*|\.\d+)(?:e[+\-]?\d+)?$/iu;
  const numeric = new Set(["x", "y", "x1", "y1", "x2", "y2", "width", "height", "rx", "ry", "cx", "cy", "r", "opacity", "fill-opacity", "stroke-opacity", "stroke-width", "stroke-miterlimit", "stroke-dashoffset"]);
  const stack: string[] = []; let offset = 0; let count = 0; let closed = false; let output = "";
  const token = /\s+([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)')/uy;
  while (offset < raw.length) {
    const whitespace = /^\s*/u.exec(raw.slice(offset))![0]; offset += whitespace.length;
    if (offset === raw.length) break;
    const start = /^<(\/?)([A-Za-z][A-Za-z0-9]*)/u.exec(raw.slice(offset));
    if (!start || closed || ++count > 10000) throw Error("Unsupported SVG markup.");
    const name = start[2]; offset += start[0].length;
    if (!tags.has(name)) throw Error("SVG uses unsupported elements.");
    if (start[1]) {
      const end = /^\s*>/u.exec(raw.slice(offset));
      if (!end || stack.pop() !== name) throw Error("Malformed SVG nesting.");
      offset += end[0].length; output += `</${name}>`; if (!stack.length) closed = true; continue;
    }
    if (!stack.length && name !== "svg" || stack.length && name === "svg" || stack.length >= 64) throw Error("Unsupported SVG root or nesting.");
    let attributes = name === "svg" ? ' xmlns="http://www.w3.org/2000/svg"' : "";
    const seen = new Set<string>();
    while (true) {
      token.lastIndex = offset; const attr = token.exec(raw); if (!attr) break;
      offset = token.lastIndex; const key = attr[1]; const value = attr[2] ?? attr[3];
      if (seen.has(key) || seen.size >= 64) throw Error("Invalid SVG attributes."); seen.add(key);
      if (key === "xmlns" && name === "svg" && value === "http://www.w3.org/2000/svg") continue;
      let valid = false;
      if (numeric.has(key)) valid = number.test(value) && Number.isFinite(Number(value)) && Math.abs(Number(value)) <= 1e6;
      else if (key === "viewBox" || key === "points" || key === "stroke-dasharray") valid = value.trim().split(/[\s,]+/u).every(n => number.test(n) && Math.abs(Number(n)) <= 1e6);
      else if (key === "d") valid = /^[MmZzLlHhVvCcSsQqTtAa\d.eE,+\-\s]*$/u.test(value);
      else if (key === "fill" || key === "stroke") valid = /^(?:none|currentColor|transparent|#[\da-f]{3,8}|[a-z]+)$/iu.test(value);
      else if (key === "id") valid = /^[A-Za-z_][A-Za-z0-9_.-]*$/u.test(value);
      else if (key === "clip-path") valid = /^url\(#[A-Za-z_][A-Za-z0-9_.-]*\)$/u.test(value);
      else if (key === "transform") valid = /^(?:(?:matrix|translate|scale|rotate|skewX|skewY)\([\d.eE+,\-\s]+\)\s*)+$/u.test(value);
      else if (key === "fill-rule" || key === "clip-rule") valid = /^(?:evenodd|nonzero)$/u.test(value);
      else if (key === "stroke-linecap") valid = /^(?:butt|round|square)$/u.test(value);
      else if (key === "stroke-linejoin") valid = /^(?:miter|round|bevel)$/u.test(value);
      else if (key === "clipPathUnits") valid = /^(?:userSpaceOnUse|objectBoundingBox)$/u.test(value);
      if (!valid) throw Error("SVG uses unsupported attributes.");
      attributes += ` ${key}="${value}"`;
    }
    const end = /^\s*(\/?)>/u.exec(raw.slice(offset)); if (!end) throw Error("Malformed SVG element.");
    offset += end[0].length; output += `<${name}${attributes}${end[1]}>`;
    if (!end[1]) stack.push(name); else if (!stack.length) closed = true;
  }
  if (!closed || stack.length) throw Error("Incomplete SVG.");
  return output;
}
