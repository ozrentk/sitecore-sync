import { test } from "node:test";
import { match, throws, strictEqual } from "node:assert/strict";
import { safeSvgPreview } from "../../src/sitecore/svgPreview";

test("shape-only SVG logo retains paths, colors and local clipping", () => {
  const result = safeSvgPreview('<svg width="264" height="60" viewBox="0 0 264 60" fill="none" xmlns="http://www.w3.org/2000/svg"><g clip-path="url(#clip)"><path d="M0 0L10 10Z" fill="#0C0C0C"/></g><defs><clipPath id="clip"><rect width="264" height="60"/></clipPath></defs></svg>');
  match(result,/clip-path="url\(#clip\)"/);match(result,/fill="#0C0C0C"/);match(result,/d="M0 0L10 10Z"/);
  strictEqual(safeSvgPreview('<svg xmlns="http://www.w3.org/2000/svg"/>'),'<svg xmlns="http://www.w3.org/2000/svg"/>');
});
test("SVG preview rejects executable, external, malformed and unbounded markup", () => {
  for (const xml of [
    '<svg onload="alert(1)"/>','<svg><script>alert(1)</script></svg>',
    '<svg><foreignObject><div/></foreignObject></svg>','<svg><image href="https://evil.test/x"/></svg>',
    '<svg><use href="#path"/></svg>','<svg><path style="fill:url(https://evil.test/x)"/></svg>',
    '<svg><path fill="url(https://evil.test/x)"/></svg>','<svg><g clip-path="url(https://evil.test/x)"/></svg>',
    '<svg><animate attributeName="href"/></svg>','<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///x">]><svg/>',
    '<svg xmlns="https://evil.test"/>','<svg><path/></g>','<svg/><svg/>','<svg><svg/></svg>',
    '<svg><path id="x" id="y"/></svg>','<svg><path d="&evil;"/></svg>',
    '<svg>'+ '<g>'.repeat(65)+'</g>'.repeat(65)+'</svg>', '<svg>'+ ' '.repeat(1024*1024)+'</svg>',
  ]) throws(()=>safeSvgPreview(xml), Error, xml.slice(0,80));
});
