/* Raw source is authoritative. The textarea is only an LF-normalized projection. */
globalThis.htmlSourceTools = (() => {
  const limit = 1024 * 1024;
  const normalize = raw => raw.replace(/\r\n?/gu, "\n");
  function offset(raw, position) {
    let i = 0; let displayed = 0;
    while (i < raw.length && displayed < position) {
      i += raw[i] === "\r" && raw[i + 1] === "\n" ? 2 : 1; displayed++;
    }
    return i;
  }
  function replace(raw, start, end, inserted) {
    return raw.slice(0, offset(raw, start)) + inserted + raw.slice(offset(raw, end));
  }
  function reconcile(raw, displayed, before, after, inputType = "") {
    const previous = normalize(raw);
    if (previous === displayed) return raw;
    let startLimit = before?.start ?? previous.length;
    let endLimit = before?.end ?? 0;
    if (inputType.startsWith("delete") && before && before.start === before.end) {
      startLimit = Math.min(before.start, after?.start ?? before.start);
      endLimit = Math.max(before.end, startLimit + previous.length - displayed.length);
    }
    let start = 0;
    while (start < Math.min(previous.length, displayed.length, startLimit) && previous[start] === displayed[start]) start++;
    let end = previous.length; let nextEnd = displayed.length;
    while (end > Math.max(start, endLimit) && nextEnd > start && previous[end - 1] === displayed[nextEnd - 1]) { end--; nextEnd--; }
    // Typed line breaks use the nearest preceding convention (then first existing, then LF).
    const rawStart = offset(raw, start);
    const preceding = raw.slice(0, rawStart).match(/\r\n|\r|\n/gu);
    const newline = preceding?.at(-1) ?? raw.match(/\r\n|\r|\n/u)?.[0] ?? "\n";
    return replace(raw, start, end, displayed.slice(start, nextEnd).replace(/\n/gu, newline));
  }
  return { limit, normalize, offset, replace, reconcile };
})();

globalThis.createHtmlSource = (control, initial, callbacks) => {
  const tools = globalThis.htmlSourceTools;
  let raw = initial; let before; let inputType = ""; let composing = false; let disposed = false;
  const listeners = []; const waiting = new Set();
  control.value = tools.normalize(raw);
  const on = (type, listener) => { control.addEventListener(type, listener); listeners.push([type, listener]); };
  const selection = () => ({ start: control.selectionStart, end: control.selectionEnd });
  function accept(value, notify = true) {
    if (value.length > tools.limit) {
      control.value = tools.normalize(raw); callbacks.error("HTML edit exceeds 1,048,576 characters; the previous draft was kept."); return false;
    }
    callbacks.error("");
    if (value !== raw) { raw = value; if (notify) callbacks.change(raw); }
    return true;
  }
  function flush() {
    if (disposed) return raw;
    accept(tools.reconcile(raw, control.value, before, selection(), inputType));
    before = undefined; inputType = ""; return raw;
  }
  function insert(text) {
    if (control.disabled || control.readOnly || disposed) return;
    flush(); const range = selection();
    const next = tools.replace(raw, range.start, range.end, text);
    if (accept(next)) {
      control.value = tools.normalize(raw);
      const caret = range.start + tools.normalize(text).length; control.setSelectionRange(caret, caret);
    }
  }
  on("beforeinput", event => {
    if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
      event.preventDefault(); if (!composing) callbacks.history(event.inputType === "historyUndo" ? "undo" : "redo"); return;
    }
    before = selection(); inputType = event.inputType;
  });
  on("input", flush);
  on("keydown", event => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && ["z", "y"].includes(event.key.toLowerCase())) {
      event.preventDefault(); event.stopPropagation();
      if (!composing && !control.disabled) { flush(); callbacks.history(event.shiftKey || event.key.toLowerCase() === "y" ? "redo" : "undo"); }
    }
  });
  on("paste", event => { if (!event.clipboardData) return; event.preventDefault(); insert(event.clipboardData.getData("text/plain")); });
  on("copy", event => {
    if (!event.clipboardData) return;
    flush(); const range = selection(); event.preventDefault();
    event.clipboardData.setData("text/plain", raw.slice(tools.offset(raw, range.start), tools.offset(raw, range.end)));
  });
  on("cut", event => {
    if (!event.clipboardData || control.disabled || control.readOnly) return;
    flush(); const range = selection(); event.preventDefault();
    event.clipboardData.setData("text/plain", raw.slice(tools.offset(raw, range.start), tools.offset(raw, range.end))); insert("");
  });
  on("dragover", event => event.preventDefault());
  on("drop", event => { event.preventDefault(); if (event.dataTransfer?.types.includes("text/plain")) insert(event.dataTransfer.getData("text/plain")); });
  on("compositionstart", () => { composing = true; });
  on("compositionend", () => {
    composing = false; flush();
    // Chromium can deliver the final input after compositionend.
    setTimeout(() => { flush(); for (const finish of waiting) finish(); }, 0);
  });
  return {
    read: flush,
    replace(value, notify = true) { before = undefined; inputType = ""; if (accept(value, notify)) control.value = tools.normalize(raw); },
    async finishComposition() {
      control.blur();
      if (composing) await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiting.delete(finish); reject(new Error("Finish composing HTML before saving.")); }, 3500);
        const finish = () => { clearTimeout(timer); waiting.delete(finish); disposed ? reject(new Error("Source control closed.")) : resolve(); };
        waiting.add(finish);
      });
      // Blur can synchronously end composition before the final input is delivered.
      await new Promise(resolve => setTimeout(resolve, 0));
      if (disposed) throw new Error("Source control closed.");
      return flush();
    },
    dispose() { disposed = true; for (const [type, listener] of listeners) control.removeEventListener(type, listener); for (const finish of waiting) finish(); },
  };
};
