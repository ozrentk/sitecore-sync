import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { parseFragment } from "parse5";
import { supportedStyleProperty, supportedStyleSelector } from "../src/editor/richTextStylePolicy";

/** Only installed inside the opaque editing frame. Original styles stay in model tokens. */
export function isolatedStyles(nonce: string): Extension {
  if (window.parent === window || location.origin !== "null") throw new Error("Styled editing requires an isolated frame.");
  const style = document.createElement("style"); style.nonce = nonce; document.head.append(style);
  let previous: PMNode | undefined; let decorated = DecorationSet.empty;
  return Extension.create({ name: "isolatedStyles", addProseMirrorPlugins: () => [new Plugin({
    props: { decorations(state) {
      if (state.doc === previous) return decorated;
      previous = state.doc;
      const rules: string[] = []; const embedded: string[] = []; const inline: string[] = []; const decorations: Decoration[] = [];
      let size = 0;
      const declarations = (source: string): string => {
        if (source.length > 8192) return "";
        const parsed = new CSSStyleSheet(); parsed.replaceSync(`x{${source}}`);
        const first = parsed.cssRules[0]; if (!(first instanceof CSSStyleRule)) return "";
        return [...first.style].filter(key => supportedStyleProperty(key, first.style.getPropertyValue(key)))
          .map(key => `${key}:${first.style.getPropertyValue(key)};`).join("");
      };
      const addRule = (rule: string, isInline = false): boolean => {
        if (rules.length >= 256 || size + rule.length > 32768) return false;
        rules.push(rule); (isInline ? inline : embedded).push(rule); size += rule.length; return true;
      };
      const attributes = (token: unknown): Record<string, string> => {
        if (typeof token !== "string" || !token) return {};
        // Parse5 never creates active DOM or fetches resources.
        const node = parseFragment(token.replace(/^<[a-z\d]+/iu, "<span")).childNodes[0]; if (!node || !("tagName" in node)) return {};
        const cls = node.attrs.find(attr => attr.name === "class")?.value ?? "";
        const css = declarations(node.attrs.find(attr => attr.name === "style")?.value ?? "");
        const name = `rt-projection-${rules.length}`;
        const projected = css && addRule(`.${name}{${css}}`, true) ? name : "";
        const id = node.attrs.find(attr => attr.name === "id")?.value;
        return { class: `${cls} ${projected}`.trim(), ...(id ? { id } : {}) };
      };
      state.doc.descendants((node, pos) => {
        if (node.type.name === "stylesheet") {
          const raw = String(node.attrs.raw); const source = parseFragment(raw).childNodes[0];
          if (source && "tagName" in source) {
            const css = source.childNodes.filter(child => child.nodeName === "#text").map(child => "value" in child ? child.value : "").join("");
            if (css.length <= 32768) {
              const sheet = new CSSStyleSheet(); sheet.replaceSync(css);
              for (const rule of sheet.cssRules) if (rule instanceof CSSStyleRule && supportedStyleSelector(rule.selectorText)) {
                const value = declarations(rule.style.cssText); if (value) addRule(`${rule.selectorText}{${value}}`);
              }
            }
          }
        } else if (!node.isText && node.attrs.open) decorations.push(Decoration.node(pos, pos + node.nodeSize, attributes(node.attrs.open)));
        for (const mark of node.marks) {
          const attrs = attributes(mark.attrs.open);
          if (attrs.class) decorations.push(Decoration.inline(pos, pos + node.nodeSize, attrs));
        }
      });
      style.textContent = `@layer rt-stored{${embedded.join("\n")}}@layer rt-inline{${inline.join("\n")}}`;
      decorated = DecorationSet.create(state.doc, decorations); return decorated;
    } },
    view: () => ({ destroy: () => style.remove() }),
  })] });
}
