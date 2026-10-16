import { createVisual } from "./richTextVisual";
import { isolatedStyles } from "./richTextStyles";
import { richCommands } from "../src/editor/richTextCommands";
import type { RichLinkDestination } from "../src/editor/richTextLinks";
import { frameSelection } from "../src/editor/richTextFrameProtocol";

declare const frameSession: string;
const nonce = document.currentScript?.nonce ?? "";
const themeStyle = document.createElement("style"); themeStyle.nonce = nonce; document.head.append(themeStyle);
const commands = [...richCommands, "link", "insertTable", "caption", "rowBefore", "rowAfter", "columnBefore", "columnAfter", "deleteRow", "deleteColumn", "mergeCells", "splitCell"];
let editor: ReturnType<typeof createVisual> | undefined;
let tableMenuOpen = false;
let sequence = 0; let lastRequest = 0; let scheduled = false; let queue = Promise.resolve();
const send = (message: Record<string, unknown>) => parent.postMessage({ channel: "rich-text-frame", session: frameSession, ...message }, "*");
function snapshot() {
  if (!editor) return undefined;
  const visibleCommands = tableMenuOpen ? commands : [...richCommands, "link"];
  return { raw: editor.read(), selection: editor.selection(), statuses: Object.fromEntries(visibleCommands.map(name => [name, editor!.status(name)])), sequence: ++sequence };
}
function update() {
  if (scheduled) return; scheduled = true;
  requestAnimationFrame(() => { scheduled = false; send({ type: "state", state: snapshot() }); });
}
window.addEventListener("message", event => {
  const message = event.data;
  if (event.source !== parent || !message || message.channel !== "rich-text-host" || message.session !== frameSession || !Number.isSafeInteger(message.id) || message.id <= lastRequest || typeof message.operation !== "string") return;
  lastRequest = message.id;
  queue = queue.then(async () => {
    try {
      let result: unknown;
      if (message.operation === "init") {
        if (editor || typeof message.value !== "string" || message.value.length > 262144) throw new Error("Invalid editor initialization.");
        editor = createVisual(document.getElementById("editor")!, message.value, {
          change: () => send({ type: "state", state: snapshot() }), selection: update,
          history: action => send({ type: "history", action }), error: error => send({ type: "error", error }),
        }, [isolatedStyles(nonce)]);
      } else {
        if (!editor) throw new Error("Visual editor is not ready.");
        switch (message.operation) {
          case "command": if (typeof message.value !== "string" || !commands.includes(message.value)) throw new Error("Unknown command."); editor.command(message.value); break;
          case "beginLink": result = editor.beginLink(); break;
          case "cancelLink": editor.cancelLink(); break;
          case "applyLink": {
            const value = message.value;
            if (value !== "remove" && (!value || !((value.kind === "url" && typeof value.href === "string" && value.href.length <= 8192) || (value.kind === "sitecore" && typeof value.itemId === "string" && value.itemId.length <= 38)))) throw new Error("Invalid link destination.");
            editor.applyLink(value as RichLinkDestination | "remove"); break;
          }
          case "focus": editor.focus(); break;
          case "theme": {
            const value = message.value;
            const color = (item: unknown): item is string => typeof item === "string" && item.length <= 80 && /^[#a-z\d(),.%\s-]+$/iu.test(item) && CSS.supports("color", item);
            if (!value || !color(value.foreground) || !color(value.background) || !["light", "dark"].includes(value.scheme)) throw new Error("Invalid theme colors.");
            themeStyle.textContent = `@layer rt-defaults{html{color-scheme:${value.scheme}}body{color:${value.foreground};background:${value.background}}`; break;
          }
          case "tableMenu": if (typeof message.value !== "boolean") throw new Error("Invalid menu state."); tableMenuOpen = message.value; break;
          case "restore": {
            const selection = message.value;
            if (!frameSelection(selection)) throw new Error("Invalid selection.");
            editor.restore(selection); break;
          }
          case "freeze": result = await editor.freeze(); break;
          case "editable": if (typeof message.value !== "boolean") throw new Error("Invalid editable state."); editor.editable(message.value); break;
          default: throw new Error("Unsupported frame operation.");
        }
      }
      send({ type: "reply", id: message.id, result, state: snapshot() });
    } catch (error) { send({ type: "reply", id: message.id, error: error instanceof Error ? error.message : "Visual operation failed." }); }
  });
});
// No source links/forms/resources enter this DOM. Retain a second navigation fence.
document.addEventListener("click", event => { if ((event.target as Element).closest?.("a")) event.preventDefault(); }, true);
document.addEventListener("submit", event => event.preventDefault(), true);
document.addEventListener("keydown", event => {
  if (event.key === "Escape") { event.preventDefault(); send({ type: "escape" }); }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); send({ type: "save" }); }
});
send({ type: "ready" });
