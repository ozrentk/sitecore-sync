/** Display-only CSS profile. Never rewrite the authoritative HTML with these values. */
const properties = new Set(("color background-color font-family font-size font-weight font-style font-variant text-align text-decoration text-decoration-color text-decoration-line text-decoration-style text-transform text-indent letter-spacing word-spacing line-height white-space vertical-align border border-color border-style border-width border-top border-right border-bottom border-left border-radius border-collapse border-spacing padding padding-top padding-right padding-bottom padding-left margin margin-top margin-right margin-bottom margin-left width max-width min-width height max-height min-height list-style-type list-style-position").split(" "));
export function supportedStyleProperty(property: string, value: string): boolean {
  return properties.has(property) && value.length <= 256 && !/(?:url|var|attr|expression)\s*\(|[\\@{}]/iu.test(value)
    && [...value.matchAll(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/giu)].every(match => Math.abs(Number(match[0])) <= 4096);
}
export function supportedStyleSelector(selector: string): boolean {
  // Keep ordinary tag/class/ID selectors, combinators and small selector lists.
  // Exclude pseudo elements/functions, attribute matching and escaped selectors.
  return selector.length <= 256 && selector.split(",").length <= 16 && /^[a-z\d_.#*\s,>+~-]+$/iu.test(selector);
}
