import type { XmCloudConnection } from "../connections/connection";
import type { AuthoringContentClient, AuthoringItemDetails } from "../sitecore/authoringClient";
import { normalizeId } from "./itemEditorModel";
import { selectionKind, selectionLimit, type SelectionIO } from "./singleSelection";
import { isGeneralLink } from "./generalLink";

/** Read Source through its template-field item, using established Item/fields APIs. */
export async function loadSelectionMetadata(client: AuthoringContentClient, connection: XmCloudConnection, secret: string,
  item: AuthoringItemDetails, signal: AbortSignal): Promise<AuthoringItemDetails> {
  const fields = [...item.fields];
  const selected = fields.map((field, index) => ({ field, index })).filter(({ field }) => (selectionKind(field) || isGeneralLink(field)) && !field.isStandardTemplate && !field.name.startsWith("__"));
  for (let start = 0; start < Math.min(selected.length, 64); start += 4) {
    await Promise.all(selected.slice(start, start + 4).map(async ({ field, index }) => {
      let selectionSource: string | undefined;
      try {
        let definition = await client.loadItem(connection, secret, { itemId: field.fieldId }, item.language, undefined, signal, false, true);
        // Shared template metadata is independent of the content locale. Authoring
        // omits all fields for a version-zero definition, so use one advertised
        // existing version and accept only explicitly SHARED Type and Source.
        if (definition.version === 0) {
          const existing = definition.availableVersions.find(v => v.language.toLowerCase() === "en") ?? definition.availableVersions[0];
          if (existing) definition = await client.loadItem(connection, secret, { itemId: field.fieldId }, existing.language, existing.version, signal, false, true);
        }
        const sources = definition.fields.filter(f => f.name === "Source");
        const types = definition.fields.filter(f => f.name === "Type");
        if (normalizeId(definition.itemId) === normalizeId(field.fieldId) && definition.path.toLowerCase().startsWith("/sitecore/templates/")
          && sources.length === 1 && types.length === 1
          && sources[0].value.length <= 8192 && types[0].value.toLowerCase() === field.type.toLowerCase() && !sources[0].containsFallbackValue && !types[0].containsFallbackValue && sources[0].scope === "SHARED" && types[0].scope === "SHARED") selectionSource = sources[0].value;
      } catch { /* Optional metadata failure makes only this control read-only. */ }
      fields[index] = { ...field, selectionSource };
    }));
    signal.throwIfAborted();
  }
  return { ...item, fields };
}
export function selectionIO(client: AuthoringContentClient, connection: XmCloudConnection, secret: string,
  language: string, signal: AbortSignal, contextItemId?: string): SelectionIO {
  return { contextItemId, item: locator => client.loadSelectionItem(connection, secret, locator, language, signal),
    children: locator => client.loadTreeLevel(connection, secret, locator, language, signal, selectionLimit) };
}
