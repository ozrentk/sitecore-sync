# Page components

In Browse or Compare, right-click a page and choose **View components…**.
Save the environment's separate **CM Preview** token in Connection settings first.
The extension uses the clicked side's connection and language.

The Components tab keeps its tree beside a read-only details pane. Select a component
row to inspect its instance UID, effective parameters and the actual
datasource's name, ID, path and fields. Selection stays inside Components and does
not change Browse or another editor's drafts. Repeated components remain separate
occurrences even when they use the same datasource.

Each full-width row shows `Datasource display name [Rendering type]`. Without a declared datasource it shows `[Rendering type]`; unresolved declarations show **Datasource unavailable** and retain the expression in the tooltip and instance details. Labels wrap without truncation. A separate chevron expands child placeholders without changing selection.

Expand **References** beneath a datasource to load its Preview-exposed stored list/lookup and verified ordinary internal General Link relationships. Each field has its own group; order and repeated targets are preserved. Expand a referenced item to inspect the next level, or select its row for exact-locale Details in the same pane. Cycles stop at an ancestor already in that branch. Missing, malformed, failed and limited nodes remain visible. This is on-demand expansion, not an automatic crawl.

Field groups containing only Standard Template/system fields start collapsed. Ordinary content and mixed groups stay expanded, including content inherited from standard values. Expand any group to inspect its complete values.

Drag the divider or focus it and use Left/Right (Home/End for the limits) to resize.
The compact **Expand details / Restore split view** icon appears in the details header only after a datasource or referenced item loads. It toggles the whole-tab view without a second desktop Back control. At narrow widths, selection opens Details;
**Back to tree** or Escape returns to the tree and restores selection focus.

The full-width header contains the component count and a compact **Layout context** info disclosure, above a theme-aware divider. Device names retain their raw IDs in the disclosure/tooltip. The standard device `FE5D7FDF-89C0-4D99-9AA3-B5FBD009C9F3` is shown as **Default**, verified by a read-only device-item lookup and [Sitecore documentation](https://doc.sitecore.com/xp/en/developers/104/sitecore-experience-platform/restful-api-endpoints-for-collection-service.html). Other device names use verified Authoring metadata when available; otherwise their IDs remain visible. Missing device identity stays Unknown.

GUID and absolute-path datasources resolve to item labels using Authoring in the
requested language. Unresolved expressions, missing or inaccessible targets stay
explicit; the owning page is never substituted. Duplicate references share a
label lookup per layout load, with at most four requests in flight.

**Reveal datasource in Browse** explicitly switches to Browse and reveals the
resolved datasource path, retaining the connection and requested language. Browse
shows its usual latest version. **Edit datasource** opens or reuses the ordinary
item editor at the exact numbered version shown in Details; existing drafts and
all editor validation/save rules remain intact. Editing requires at least one supported ordinary field in an existing exact-locale content version, including page items. Layout/system fields and unverified fallback values remain read-only. These actions refer
to the selected referenced item when inspecting a reference, never its owner page.

The Details pane separately lists exact-locale relationships from Droplink, Droptree, Multilist, Treelist, Checklist,
General Link and Image/File fields appear under **Referenced items**. Select one
to inspect that item's fields in the same pane. Layout fields are not relationships
here. This is explicit, one-item-at-a-time inspection, separate from the effective Preview reference tree; cycles do not trigger background traversal. Missing references
stay unavailable. At most 100 distinct references are listed, with a visible
limit notice. Each item read is limited to 500 fields and 1 MiB of field text;
excessive details fail visibly rather than showing silently truncated fields.

Details uses exact-locale Authoring reads, with requested locale, returned locale,
numbered version and field provenance shown separately. Preview may contain
fallback content even when Authoring has no local version; no fallback source or
writable target is guessed. Shared read-only field rendering retains raw values
and the existing isolated Rich Text preview; external resources remain blocked.
Selection, refresh, locale changes and closing the tab cancel pending reads and
reject stale replies/actions. Each layout/details load has a 30-second deadline.

Change Language to reload that page's layout in another configured locale.
Refresh reads the current saved content again. Closing the panel cancels pending reads.
The panel uses discovered sites and an item-name-based route beneath Home; ambiguous
site matches prompt for a site, and sites without a recognizable Home path prompt
for a site-relative route. Preview must return the selected page identity, site,
language and master database before any tree is displayed.

## Limits and provenance

The panel represents effective Preview output. Returned locale/version does not
prove a local editable version or identify a fallback source. Source locale remains
unknown. An empty datasource means none was declared, not that the page is the datasource.
GUID/path references are not independently verified writable targets; other datasource
expressions remain unresolved. Missing and repeated instance identities are visible;
separate occurrences are never merged by UID.

Effective parameters are separate from raw shared/final presentation. Some renderings
retain empty entries and others omit them. Do not reconstruct raw parameters from this view.

The provider's implicit device is used; a returned device ID is shown in Layout context,
otherwise Unknown. No device selector is offered. Custom resolvers, nested/base partial
inheritance and recursive reference-graph completeness are not guaranteed.

Reads allow 30 seconds and 2 MiB per response. The tree is limited to 500 components
and 20 nested levels. Invalid, mismatched or excessive responses show an unavailable
state rather than a silently truncated tree. No content is saved, published or deleted
by this panel.

### Preview reference limits

The lazy tree currently supports typed Multilist and Lookup fields (including their Sitecore list/tree variants). Ordinary internal General Links additionally require agreement between their raw XML ID and typed Preview target. Missing or conflicting targets stay unresolved. Link information retains the original XML. External, email, anchor and Content Hub destinations are inert text, never item edges. Unsupported link variants remain unresolved. Image/File fields use only the stored XML mediaid and require the independently loaded target to have the matching ID and a Media Library path. Original XML stays in **Asset information**. Missing, non-media, malformed, mixed connector/media and unsupported targets remain explicit. Content Hub and asset URLs never become item edges; no asset files are fetched. Image has read-only live verification; no populated File-field sample was found, so File coverage is schema/synthetic only. Media targets can be inspected but remain non-editable. Layout fields and arbitrary custom resolver JSON are not traversed. Preview exposes fewer fields than Authoring; an empty group is not proof of complete template/reference coverage.

Direct item queries have no site argument. The root page layout is site-validated, but equivalence for arbitrary site-dependent resolvers is unverified. Where layout output includes an explicit ordered item-reference array, internal link ID or mediaid, disagreement with the direct read is shown as unresolved. Missing direct coverage and conflicting layout occurrences also remain unresolved. This comparison does not prove a transactional snapshot. Returned language/version never supplies an editable fallback source.

Each panel layout load owns its cache (connection, selected site and locale); Refresh creates a new one. Limits are 200 item reads, four requests in flight, 500 reference occurrences, 12 reference levels, 500 fields per item and 500 raw entries per field. Each HTTP read has a 30-second deadline and 2 MiB response cap, with no automatic retries. Failed reads are retained for that load; Refresh retries. Expanding loads only the selected item's references and immediate target labels; collapsing does not restart or recursively crawl them. Closing, Refresh and locale changes cancel the load. Exact Details/Edit retain their separate existing eligibility and version guards.
