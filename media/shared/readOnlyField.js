const richTextStyleNonce = document.currentScript?.nonce || "";
/* Shared read-only display. Raw values never become editor inputs. */
globalThis.renderReadOnlyField = function (field, options = {}) {
  const box = document.createElement("div"); box.className = "readonly-field";
  const raw = field.raw ?? field.value;
  const presentation = field.presentation || { kind: "raw", status: typeof raw !== "string" ? "unavailable" : raw === "" ? "empty" : "populated" };
  const compact = ["image", "file"].includes(presentation.kind) && options.information;
  const information = compact || box;
  const note = text => { const p = document.createElement("p"); p.className = "readonly-note"; p.textContent = text; box.append(p); return p; };
  if (!options.sourceMode) note(compact ? "Read-only" : `Read-only${field.reason ? `: ${field.reason}` : ""}`);
  const sourceLocation = options.sourceMode ? "The complete HTML is available in HTML mode." : "Original HTML is available below.";
  if (compact) {
    compact.querySelector(".field-stored-value")?.remove();
    const reason = document.createElement("p"); reason.textContent = field.reason || "Editing is not supported for this field type."; compact.append(reason);
  }
  if (presentation.status === "unavailable") { note("Field value unavailable or unreadable."); return box; }
  if (presentation.status === "empty") { note("Empty value"); return box; }
  if (presentation.provider) {
    const provider = document.createElement("p"); provider.textContent = presentation.provider; information.append(provider);
  }
  if (presentation.notice) note(presentation.notice);
  if (presentation.metadata?.length) {
    const list = document.createElement("dl"); list.className = "asset-metadata";
    for (const [key, value] of presentation.metadata) {
      const term = document.createElement("dt"); term.textContent = key;
      const detail = document.createElement("dd"); detail.textContent = value || "(empty)"; list.append(term, detail);
    }
    information.append(list);
  }
  if (presentation.kind === "richtext") {
    const preview = document.createElement("iframe"); preview.className = "richtext-preview";
    preview.title = "Read-only Rich Text preview";
    preview.setAttribute("sandbox", "");
    preview.referrerPolicy = "no-referrer";
    preview.setAttribute("aria-label", "Read-only Rich Text preview");
    // Parse inertly, then rebuild static content in an opaque-origin sandbox.
    // Never allow navigation, scripts, forms or resource attributes into the frame.
    if (raw.length <= 262144) {
      const template = document.createElement("template"); template.innerHTML = raw;
      const content = document.createElement("div");
      const styles = ["body{margin:16px;font:14px system-ui;overflow-wrap:anywhere} table{border-collapse:collapse} td,th{border:1px solid #888;padding:4px} pre{white-space:pre-wrap}"];
      const allowed = new Set("p br strong b em i u s del ins sub sup h1 h2 h3 h4 h5 h6 ul ol li blockquote pre code table thead tbody tfoot tr th td hr div span".split(" "));
      const discard = new Set("script style iframe object embed svg math form input button textarea select link meta base template noscript".split(" "));
      let count = 0; let truncated = false;
      const copy = (from, to, depth) => {
        if (depth > 60 || ++count > 10000) { truncated = true; return; }
        if (from.nodeType === Node.TEXT_NODE) { to.append(document.createTextNode(from.textContent)); return; }
        if (from.nodeType !== Node.ELEMENT_NODE) return;
        const tag = from.localName;
        if (tag === "style") { styles.push(from.textContent); return; }
        if (discard.has(tag)) return;
        if (tag === "img") { const placeholder = document.createElement("span"); placeholder.textContent = `[Image: ${from.getAttribute("alt") || "embedded asset"}]`; to.append(placeholder); return; }
        const target = allowed.has(tag) ? document.createElement(tag) : document.createElement("span");
        for (const key of ["class", "id", "dir", "lang", "colspan", "rowspan"]) {
          if (from.hasAttribute(key)) target.setAttribute(key, from.getAttribute(key));
        }
        if (from.hasAttribute("style")) {
          const marker = `rt-${count}`; target.setAttribute("data-preview-style", marker);
          const sheet = new CSSStyleSheet();
          sheet.replaceSync(`x{${from.getAttribute("style")}}`);
          const declaration = sheet.cssRules[0]?.style?.cssText || "";
          styles.push(`[data-preview-style="${marker}"]{${declaration}}`);
        }
        for (const child of from.childNodes) copy(child, target, depth + 1);
        to.append(target);
      };
      for (const child of template.content.childNodes) copy(child, content, 0);
      const policy = `default-src 'none'; script-src 'none'; style-src 'nonce-${richTextStyleNonce}'; img-src 'none'; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';`;
      const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><style nonce="${richTextStyleNonce}">${styles.join("\n").replace(/</gu, "\\3c ")}</style></head><body>${content.innerHTML}</body></html>`;
      preview.src = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
      box.append(preview);
      if (!content.textContent.trim()) note("The stored HTML is populated but has no displayable text in this preview.");
      if (truncated) note(`Preview limited to bounded content. ${sourceLocation}`);
      note(`Isolated preview. Scripts, links and external resources are blocked. ${sourceLocation}`);
    } else note(`Preview unavailable: HTML exceeds the preview size limit. ${sourceLocation}`);
  }
  if (["image", "file"].includes(presentation.kind) && (presentation.source || presentation.mediaId)) {
    const status = note(options.requestAsset ? "Preview not loaded." : "Asset preview is available in the item editor when the stored URL is supported.");
    const button = document.createElement("button"); button.type = "button";
    button.textContent = !presentation.source ? "Resolve media reference" : presentation.kind === "image" ? "Load preview" : "Check file reference";
    if (options.requestAsset) {
      box.append(button);
      button.addEventListener("click", event => {
        event.stopPropagation(); button.disabled = true; status.textContent = "Loading asset…";
        options.requestAsset(result => {
          if (!box.isConnected) return;
          status.textContent = result.error || (result.dataUri ? "" : "File reference verified.");
          button.hidden = !result.error;
          button.disabled = false;
          if (result.reference) note(result.reference);
          if (result.dataUri && /^data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,[a-z\d+/]+={0,2}$/iu.test(result.dataUri)) {
            const image = document.createElement("img"); image.className = "asset-preview"; image.alt = presentation.alt || "Asset preview";
            image.addEventListener("error", () => { image.remove(); status.textContent = "Preview could not be decoded. Metadata and original value remain available."; });
            image.src = result.dataUri; box.insertBefore(image, status);
          }
          if (result.open && options.openAsset) {
            const open = document.createElement("button"); open.type = "button"; open.textContent = "Open asset";
            open.addEventListener("click", event => { event.stopPropagation(); options.openAsset(); }); box.insertBefore(open, status);
          }
        });
      });
    }
  }
  if (options.sourceMode) return box;
  const source = document.createElement("details"); source.className = "readonly-source";
  source.open = presentation.kind === "raw" || Boolean(presentation.notice);
  const title = document.createElement("summary"); title.textContent = presentation.kind === "richtext" ? "HTML source (unchanged)" : "Stored value (unchanged)";
  const value = document.createElement("pre"); value.textContent = raw;
  source.append(title, value); information.append(source);
  // Inspection controls must not launch the parent field's text-diff action.
  box.addEventListener("click", event => { if (event.target.closest("button, summary")) event.stopPropagation(); });
  return box;
};
