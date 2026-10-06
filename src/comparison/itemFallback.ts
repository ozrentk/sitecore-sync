import type { AuthoringItemDetails, AuthoringItemLocator } from "../sitecore/authoringClient";

/** Configuration evidence, not proof of Authoring's effective item or per-field source. */
export interface ItemFallbackObservation {
  readonly status: "candidate" | "disabled" | "no-source" | "unavailable";
  readonly chain: readonly string[];
  readonly candidate?: { readonly language: string; readonly version: number };
}

type ReadItem = (locator: AuthoringItemLocator, language: string) => Promise<AuthoringItemDetails>;
const itemFallbackId = "fd4e2050186c43758b99e8a85dd7436e";
const languageFallbackId = "892975ac496f4ac98826087095c68e1d";
const languageTemplateId = "f68f13a63395426ab9a1fa2dc60d94eb";
const id = (value: string) => value.replace(/[{}-]/gu, "").toLowerCase();
const locale = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/iu;
const guid = /^(?:\{[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\}|[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/iu;

/** Follow only stored language links. Never substitute candidate fields for server-returned values. */
export async function observeItemFallback(
  exact: AuthoringItemDetails, read: ReadItem, signal: AbortSignal,
): Promise<ItemFallbackObservation | undefined> {
  if (exact.version !== 0) return undefined;
  const chain = [exact.language];
  const result = (status: ItemFallbackObservation["status"]): ItemFallbackObservation => ({ status, chain: [...chain] });
  if (exact.availableVersions.some(version => version.language.toLowerCase() === exact.language.toLowerCase() && version.version > 0)) {
    return result("unavailable");
  }
  const checkedRead = async (locator: AuthoringItemLocator, language: string): Promise<AuthoringItemDetails> => {
    signal.throwIfAborted();
    const item = await read(locator, language);
    signal.throwIfAborted();
    if (item.language.toLowerCase() !== language.toLowerCase()
      || ("itemId" in locator ? id(item.itemId) !== id(locator.itemId) : item.path.toLowerCase() !== locator.path.toLowerCase())
      || !Number.isInteger(item.version) || item.version < 0) throw new Error("Invalid fallback observation.");
    return item;
  };
  try {
    const seen = new Set<string>();
    let language = exact.language;
    let definition: AuthoringItemDetails | undefined;
    for (let depth = 0; depth < 16; depth += 1) {
      signal.throwIfAborted();
      if (!locale.test(language) || seen.has(language.toLowerCase())) return result("unavailable");
      seen.add(language.toLowerCase());
      definition ??= await checkedRead({ path: `/sitecore/system/Languages/${language}` }, "en");
      if (id(definition.template.templateId) !== languageTemplateId || definition.version < 1
        || definition.name.toLowerCase() !== language.toLowerCase()) return result("unavailable");
      const links = definition.fields.filter(field => id(field.fieldId) === languageFallbackId);
      const link = links[0];
      if (links.length !== 1 || !link || link.scope !== "SHARED" || link.containsFallbackValue) return result("unavailable");
      const target = link.value.trim();
      if (!target) return result("no-source");
      definition = undefined;
      if (guid.test(target)) {
        definition = await checkedRead({ itemId: target }, "en");
        if (definition.path.toLowerCase() !== `/sitecore/system/languages/${definition.name.toLowerCase()}`
          || id(definition.template.templateId) !== languageTemplateId || definition.version < 1) return result("unavailable");
        language = definition.name;
      } else language = target;
      if (!locale.test(language) || seen.has(language.toLowerCase())) return result("unavailable");
      chain.push(language);
      const candidate = await checkedRead({ itemId: exact.itemId }, language);
      if (candidate.version === 0) continue;
      const flags = candidate.fields.filter(field => id(field.fieldId) === itemFallbackId);
      const flag = flags[0];
      if (flags.length !== 1 || !flag || flag.scope !== "SHARED" || flag.containsFallbackValue
        || (flag.value !== "1" && flag.value !== "0" && flag.value !== "")) return result("unavailable");
      if (flag.value !== "1") return result("disabled");
      return { ...result("candidate"), candidate: { language: candidate.language, version: candidate.version } };
    }
    return result("unavailable");
  } catch {
    signal.throwIfAborted();
    // Optional configuration failures must not hide a successful effective-fields observation.
    return result("unavailable");
  }
}
