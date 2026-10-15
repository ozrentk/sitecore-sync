/** Read-only interpretation. Never normalize or replace the stored field value. */
export interface FieldPresentation {
  readonly kind: "image" | "file" | "richtext" | "raw";
  readonly status: "empty" | "populated" | "unavailable";
  readonly metadata?: readonly [string, string][];
  readonly provider?: string;
  readonly notice?: string;
  readonly source?: string;
  readonly alt?: string;
  readonly mediaId?: string;
}

function decode(value: string): string {
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/iu.test(value)) throw Error("entity");
  return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/giu, (_, code: string) => {
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (Object.hasOwn(named, code)) return named[code];
    const n = code.startsWith("#x") ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    if (!Number.isInteger(n) || n < 32 || n > 0x10ffff || n >= 0xd800 && n <= 0xdfff) throw Error("character");
    return String.fromCodePoint(n);
  });
}

/** Single empty XML element only; no DTD, nested content, namespaces or external entities. */
export function mediaAttributes(raw: string, kind: "image" | "file"): [string, string][] {
  if (raw.length > 262144) throw Error("size");
  const start = new RegExp(`^\\s*<${kind}(?=\\s|/|>)`, "u").exec(raw);
  if (!start) throw Error("element");
  let offset = start[0].length;
  const result: [string, string][] = []; const seen = new Set<string>();
  const token = /\s+([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/uy;
  while (true) {
    token.lastIndex = offset; const match = token.exec(raw); if (!match) break;
    const name = match[1].toLowerCase();
    if (seen.has(name) || name === "xmlns" || result.length >= 128) throw Error("attribute");
    seen.add(name); result.push([name, decode(match[2] ?? match[3])]); offset = token.lastIndex;
  }
  if (!new RegExp(`^\\s*(?:/>|>\\s*</${kind}>)\\s*$`, "u").test(raw.slice(offset))) throw Error("content");
  return result;
}

export function fieldPresentation(type: string, raw: unknown): FieldPresentation {
  const key = type.toLowerCase(); const kind = key === "rich text" ? "richtext" : key === "image" || key === "file" ? key : "raw";
  if (typeof raw !== "string") return { kind, status: "unavailable", notice: "Field value unavailable or unreadable." };
  if (raw === "") return { kind, status: "empty" };
  if (kind !== "image" && kind !== "file") return { kind, status: "populated" };
  try {
    const metadata = mediaAttributes(raw, kind); const attrs = Object.fromEntries(metadata);
    const dam = Boolean(attrs["dam-id"] || attrs["stylelabs-content-id"]);
    const media = /^(?:[\da-f]{32}|[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}|\{[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\})$/iu.test(attrs.mediaid ?? "");
    return { kind, status: "populated", metadata, alt: attrs.alt, source: attrs.src, mediaId: media ? attrs.mediaid : undefined,
      provider: dam && media ? "Mixed asset references" : dam ? "Content Hub / DAM" : media ? "Sitecore Media Library" : "Asset (provider unverified)",
      notice: attrs.src ? undefined : "Preview unavailable: no asset URL was returned. The stored reference is shown below." };
  } catch { return { kind, status: "populated", notice: "Unrecognized or malformed asset value. Original content is preserved below." }; }
}

/** Credentials may only accompany an explicit same-origin Sitecore media URL.
 * Public Content Hub paths are fetched anonymously, never gateway/private URLs. */
export function fieldAssetUrl(serverUrl: string, source: string): { url: URL; authenticated: boolean } | undefined {
  if (!source || source.length > 8192 || /[\s\\\u0000-\u001f\u007f]/u.test(source) || source.startsWith("//") || /%(?:2e|2f|5c)/iu.test(source)) return undefined;
  try {
    const server = new URL(serverUrl); const url = new URL(source.startsWith("~/") ? source.slice(1) : source, server);
    if (server.protocol !== "https:" || url.protocol !== "https:" || url.username || url.password || url.hash || url.port) return undefined;
    if ([...url.searchParams.keys()].some(k => /token|secret|password|authorization|signature|api.?key/iu.test(k))) return undefined;
    if (url.origin === server.origin && /^\/(?:-|~)\/media\/[A-Za-z0-9_./%-]+$/u.test(url.pathname)) return { url, authenticated: true };
    if (/\.(?:stylelabs\.(?:cloud|com|io)|sitecorecontenthub\.cloud)$/iu.test(url.hostname)
      && /^\/api\/public\/content\/[A-Za-z0-9_-]+\/?$/u.test(url.pathname)) return { url, authenticated: false };
  } catch { /* Unsupported URLs remain inspectable text. */ }
  return undefined;
}

export async function readFieldImage(response: Response, signal: AbortSignal): Promise<string> {
  const maximum = 8 * 1024 * 1024;
  const mime = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (!response.ok || response.redirected || !mime || !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mime)
    || Number(response.headers.get("content-length") ?? 0) > maximum || !response.body) { await response.body?.cancel(); throw Error("Preview unavailable."); }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted(); const part = await reader.read(); if (part.done) break;
      size += part.value.length; if (size > maximum) throw Error("Preview exceeds 8 MiB."); chunks.push(part.value);
    }
    signal.throwIfAborted(); if (!size) throw Error("Empty preview response.");
    const bytes = Buffer.concat(chunks);
    const signature = mime === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      : mime === "image/jpeg" ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : mime === "image/gif" ? /^GIF8[79]a$/u.test(bytes.subarray(0, 6).toString("ascii"))
      : bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
    if (!signature) throw Error("Image signature mismatch.");
    return `data:${mime};base64,${bytes.toString("base64")}`;
  } finally { signal.removeEventListener("abort", cancel); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
