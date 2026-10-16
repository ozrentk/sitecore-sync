import { literalMatches, validSearchResult, type SearchInput, type ReplaceInput, type SearchResult } from "../src/editor/richTextSearchInput";
import type { createVisual } from "./richTextVisual";
import type { RichLinkDestination } from "../src/editor/richTextLinks";
import { frameState, frameLinkInfo } from "../src/editor/richTextFrameProtocol";

declare const __RICH_TEXT_FRAME_SCRIPT__: string;
const parentNonce = document.currentScript?.nonce ?? "";
type Core = ReturnType<typeof createVisual>;
type Callbacks = Parameters<typeof createVisual>[2] & { escape?(): void; save?(): void; find?(replace: boolean): void };
type Status = ReturnType<Core["status"]>;
function createFrame(element: HTMLElement, initial: string, callbacks: Callbacks) {
  const session = Array.from(crypto.getRandomValues(new Uint8Array(24)), byte => byte.toString(16).padStart(2, "0")).join("");
  const nonce = parentNonce || session;
  const frame = document.createElement("iframe"); frame.className = "richtext-editing-frame";
  frame.inert = true;
  frame.title = "Rich Text visual editor"; frame.setAttribute("sandbox", "allow-scripts"); frame.referrerPolicy = "no-referrer";
  let disposed = false; let current = initial; let selection: ReturnType<Core["selection"]> = { from: 1, to: 1 };
  let sequence = 0; let requestId = 0; let statuses: Record<string, Status> = {}; let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const readyTimer = setTimeout(() => readyReject(new Error("Visual frame did not load. HTML remains available.")), 10000);
  const update = (state: unknown): boolean => {
    if (!frameState(state, sequence)) return false;
    sequence = state.sequence; selection = state.selection; statuses = state.statuses;
    if (state.raw !== current) { current = state.raw; callbacks.change(current); }
    callbacks.selection?.();
    return true;
  };
  const receive = (event: MessageEvent) => {
    const message = event.data;
    if (disposed || event.source !== frame.contentWindow || event.origin !== "null" || !message || message.channel !== "rich-text-frame" || message.session !== session) return;
    if (message.type === "ready") { clearTimeout(readyTimer); readyResolve(); }
    else if (message.type === "state") update(message.state);
    else if (message.type === "history" && ["undo", "redo"].includes(message.action)) callbacks.history(message.action);
    else if (message.type === "escape") callbacks.escape?.();
    else if (message.type === "find" && typeof message.replace === "boolean") callbacks.find?.(message.replace);
    else if (message.type === "save") callbacks.save?.();
    else if (message.type === "error" && typeof message.error === "string" && message.error.length <= 1024) callbacks.error(message.error);
    else if (message.type === "reply" && Number.isSafeInteger(message.id)) {
      const request = pending.get(message.id); if (!request) return;
      pending.delete(message.id); clearTimeout(request.timer);
      if (typeof message.error === "string") request.reject(new Error(message.error.slice(0, 1024)));
      else if (!update(message.state)) request.reject(new Error("Invalid or stale Visual acknowledgement. Drafts are preserved."));
      else request.resolve(message.result);
    }
  };
  window.addEventListener("message", receive);
  const request = async (operation: string, value?: unknown): Promise<unknown> => {
    await ready;
    if (disposed) throw new Error("Visual editor closed.");
    const id = ++requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("Visual editor did not acknowledge the operation. Keep the draft and retry when it responds.")); }, 6000);
      pending.set(id, { resolve, reject, timer });
      frame.contentWindow!.postMessage({ channel: "rich-text-host", session, id, operation, value }, "*");
    });
  };
  const policy = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'none'; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';`;
  const css = "@layer rt-defaults,rt-stored,rt-inline;@layer rt-defaults{html{color-scheme:light dark}body{font:14px system-ui;margin:12px}#editor{min-height:120px}.tiptap{outline:none;min-height:120px}.rt-cell-text,.rt-list-text{display:inline}table{border-collapse:collapse}td,th{border:1px solid GrayText;min-width:40px;padding:4px}.selectedCell{outline:2px solid Highlight}.rt-link{text-decoration:underline}[data-opaque]{font-size:12px;color:GrayText}[data-opaque=gap]{display:none}}.rt-search-match{background:Mark;color:MarkText}.rt-search-current{background:Highlight;color:HighlightText;outline:2px solid Highlight}@media(forced-colors:active){.tiptap{color:CanvasText;background:Canvas}}";
  // No stored HTML/CSS is interpolated into the frame document. It arrives only after authentication.
  const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><style nonce="${nonce}">${css}</style><main id="editor"></main><script nonce="${nonce}">const frameSession=${JSON.stringify(session)};${__RICH_TEXT_FRAME_SCRIPT__.replace(/<\/script/giu, "<\\/script")}</script>`;
  frame.src = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`; element.append(frame);
  const theme = () => {
    const css = getComputedStyle(document.body);
    return { foreground: css.getPropertyValue("--vscode-foreground").trim() || css.color || "CanvasText", background: css.getPropertyValue("--vscode-editor-background").trim() || "Canvas", scheme: document.body.classList.contains("vscode-dark") || document.body.classList.contains("vscode-high-contrast") ? "dark" : "light" };
  };
  const initialized = request("init", initial).then(() => request("theme", theme()));
  void initialized.then(() => { if (!disposed) frame.inert = false; }, error => { if (!disposed) callbacks.error(error.message); });
  const action = (operation: string, value?: unknown) => { void initialized.then(() => request(operation, value)).catch(error => { if (!disposed) callbacks.error(error.message); }); };
  const themes = new MutationObserver(() => action("theme", theme()));
  themes.observe(document.body, { attributes: true, attributeFilter: ["class", "style"] });
  themes.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
  return {
    read: () => current,
    clearSearch: () => action("clearSearch"),
    highlightSearch: async (value: SearchInput): Promise<SearchResult> => { await initialized; const result = await request("highlightSearch", value); if (!validSearchResult(result)) throw new Error("Invalid search response."); return result; },
    search: async (value: SearchInput): Promise<SearchResult> => { await initialized; const result = await request("search", value); if (!validSearchResult(result)) throw new Error("Invalid search response."); return result; },
    replaceSearch: async (value: ReplaceInput): Promise<SearchResult> => { await initialized; const result = await request("replaceSearch", value); if (!validSearchResult(result)) throw new Error("Invalid replacement response."); return result; },
    command: (name: string) => action("command", name),
    tableMenu: (open: boolean) => action("tableMenu", open),
    status: (name: string): Status => statuses[name] ?? { enabled: false, active: false, reason: "Visual editor is loading." },
    selection: () => selection,
    restore: (value: ReturnType<Core["selection"]>) => action("restore", value),
    focus: () => action("focus"), editable: (value: boolean) => action("editable", value),
    beginLink: async (): Promise<ReturnType<Core["beginLink"]>> => { await initialized; const info = await request("beginLink"); if (!frameLinkInfo(info)) throw new Error("Invalid Visual link response."); return info; },
    applyLink: async (value: RichLinkDestination | "remove") => { await initialized; await request("applyLink", value); },
    cancelLink: () => action("cancelLink"),
    freeze: async () => {
      try { await initialized; } catch (error) {
        // Failed initialization never enabled user input; HTML can safely retain the original draft.
        if (disposed) throw error;
        return current;
      }
      await request("freeze"); return current;
    },
    dispose() {
      if (disposed) return; disposed = true; clearTimeout(readyTimer); readyReject(new Error("Visual editor closed."));
      window.removeEventListener("message", receive); themes.disconnect(); frame.remove();
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("Visual editor closed.")); } pending.clear();
    },
  };
}
Object.assign(globalThis, { createRichTextFrame: createFrame, richTextSearchTools: { literalMatches } });
