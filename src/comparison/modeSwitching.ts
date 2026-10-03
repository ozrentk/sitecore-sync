import type { ContentEndpoint, ContentSessionState } from "./contentSession";

export const modePreferencesKey = "sitecoreXmCloudSync.modePreferences.v1";
export interface ComparisonPartner {
  readonly connectionId: string;
  readonly language: string;
  readonly languagesLocked: boolean;
}
export interface ModePreferences {
  readonly partners: Readonly<Record<string, ComparisonPartner>>;
  readonly retainedSide?: "left" | "right";
}
const isModePreferencesObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 2048;

/** Whitelist persisted metadata; never carry credentials or arbitrary stored fields. */
export function readModePreferences(value: unknown): ModePreferences {
  if (!isModePreferencesObject(value)) return { partners: {} };
  const partners = isModePreferencesObject(value.partners) ? Object.entries(value.partners).filter(([id, partner]) =>
    text(id) && isModePreferencesObject(partner) && text(partner.connectionId) && text(partner.language) && typeof partner.languagesLocked === "boolean",
  ).slice(-256).map(([id, partner]) => {
    const p = partner as unknown as ComparisonPartner;
    return [id, { connectionId: p.connectionId, language: p.language, languagesLocked: p.languagesLocked }];
  }) : [];
  return { partners: Object.fromEntries(partners),
    retainedSide: value.retainedSide === "left" || value.retainedSide === "right" ? value.retainedSide : undefined };
}

export function navigationEndpoint(endpoint: ContentEndpoint, value: unknown): ContentEndpoint {
  if (!isModePreferencesObject(value)) return endpoint;
  return { ...endpoint,
    rootPath: text(value.rootPath) && value.rootPath.startsWith("/") ? value.rootPath : endpoint.rootPath,
    selectedItemId: text(value.selectedItemId) ? value.selectedItemId : undefined };
}

export interface ModeSwitchChoices {
  current(): boolean;
  partner(): Promise<string | undefined>;
  languages(connectionId: string): Promise<readonly string[]>;
  language(connectionId: string, languages: readonly string[]): Promise<string | undefined>;
  unlock(): Promise<boolean>;
}

/** Preparation never mutates the live session, including when a picker is cancelled. */
export async function prepareCompare(source: ContentEndpoint, saved: ComparisonPartner | undefined,
  connectionIds: readonly string[], choices: ModeSwitchChoices): Promise<ContentSessionState | undefined> {
  if (!choices.current() || !connectionIds.includes(source.connectionId)) return undefined;
  const remembered = saved && connectionIds.includes(saved.connectionId) ? saved : undefined;
  const partnerId = remembered?.connectionId ?? await choices.partner();
  if (!choices.current() || !partnerId || !connectionIds.includes(partnerId)) return undefined;
  const resolveLanguage = async (id: string, requested: string): Promise<string | undefined> => {
    const languages = await choices.languages(id);
    if (!choices.current()) return undefined;
    const available = languages.find(language => language.toLowerCase() === requested.toLowerCase());
    const selected = available ?? await choices.language(id, languages);
    return choices.current() && selected && languages.includes(selected) ? selected : undefined;
  };
  const leftLanguage = await resolveLanguage(source.connectionId, source.language);
  if (!leftLanguage) return undefined;
  const rightLanguage = await resolveLanguage(partnerId, remembered?.language ?? leftLanguage);
  if (!rightLanguage || !choices.current()) return undefined;
  let languagesLocked = remembered?.languagesLocked ?? false;
  if (languagesLocked && leftLanguage.toLowerCase() !== rightLanguage.toLowerCase()) {
    if (!await choices.unlock() || !choices.current()) return undefined;
    languagesLocked = false;
  }
  return { mode: "compare", left: { ...source, language: leftLanguage },
    right: { connectionId: partnerId, language: rightLanguage, rootPath: "/" }, languagesLocked };
}
