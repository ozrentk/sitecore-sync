/* Shared read-only display. Raw values never become editor inputs. */
globalThis.renderReadOnlyField = function (field, options = {}) {
  const box = document.createElement("div"); box.className = "readonly-field";
  const raw = field.raw ?? field.value;
  const presentation = field.presentation || { kind: "raw", status: typeof raw !== "string" ? "unavailable" : raw === "" ? "empty" : "populated" };
  const note = text => { const p = document.createElement("p"); p.className = "readonly-note"; p.textContent = text; box.append(p); return p; };
  note(`Read-only${field.reason ? `: ${field.reason}` : ""}`);
  if (presentation.status === "unavailable") { note("Field value unavailable or unreadable."); return box; }
  if (presentation.status === "empty") { note("Empty value"); return box; }
  if (presentation.provider) note(presentation.provider);
  if (presentation.notice) note(presentation.notice);
  if (presentation.metadata?.length) {
    const list = document.createElement("dl"); list.className = "asset-metadata";
    for (const [key, value] of presentation.metadata) {
      const term = document.createElement("dt"); term.textContent = key;
      const detail = document.createElement("dd"); detail.textContent = value || "(empty)"; list.append(term, detail);
    }
    box.append(list);
  }
  if (presentation.kind === "richtext") {
    const preview = document.createElement("div"); preview.className = "richtext-preview";
    preview.setAttribute("aria-label", "Read-only Rich Text preview");
    // Template contents are inert: no network, scripts, custom elements or active DOM.
    // Rebuild a small formatting-only tree; never attach parsed nodes or attributes.
    if (raw.length <= 262144) {
      const template = document.createElement("template"); template.innerHTML = raw;
      const allowed = new Set("p br strong b em i u s del ins sub sup h1 h2 h3 h4 h5 h6 ul ol li blockquote pre code table thead tbody tfoot tr th td hr div span".split(" "));
      const discard = new Set("script style iframe object embed svg math form input button textarea select link meta base template noscript".split(" "));
      let count = 0; let truncated = false;
      const copy = (from, to, depth) => {
        if (depth > 60 || ++count > 10000) { truncated = true; return; }
        if (from.nodeType === Node.TEXT_NODE) { to.append(document.createTextNode(from.textContent)); return; }
        if (from.nodeType !== Node.ELEMENT_NODE) return;
        const tag = from.localName;
        if (discard.has(tag)) return;
        if (tag === "img") { const placeholder = document.createElement("span"); placeholder.textContent = `[Image: ${from.getAttribute("alt") || "embedded asset"}]`; to.append(placeholder); return; }
        const target = allowed.has(tag) ? document.createElement(tag) : document.createElement("span");
        for (const child of from.childNodes) copy(child, target, depth + 1);
        to.append(target);
      };
      for (const child of template.content.childNodes) copy(child, preview, 0);
      box.append(preview);
      if (!preview.textContent.trim()) note("The stored HTML is populated but has no displayable text in this preview.");
      if (truncated) note("Preview limited to bounded content; the complete original HTML is available below.");
      note("Formatting-only preview. Links, embedded media, scripts and styles are inactive; original HTML is available below.");
    } else note("Preview unavailable: HTML exceeds the preview size limit. Original HTML is available below.");
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
          if (result.dataUri && /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z\d+/]+={0,2}$/iu.test(result.dataUri)) {
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
  const source = document.createElement("details"); source.className = "readonly-source";
  source.open = presentation.kind === "raw" || Boolean(presentation.notice);
  const title = document.createElement("summary"); title.textContent = presentation.kind === "richtext" ? "HTML source (unchanged)" : "Stored value (unchanged)";
  const value = document.createElement("pre"); value.textContent = raw;
  source.append(title, value); box.append(source);
  // Inspection controls must not launch the parent field's text-diff action.
  box.addEventListener("click", event => { if (event.target.closest("button, summary")) event.stopPropagation(); });
  return box;
};
