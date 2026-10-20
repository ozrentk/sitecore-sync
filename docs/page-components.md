# Page components

In Browse or Compare, right-click a page and choose **View components…**.
Save the environment's separate **CM Preview** token in Connection settings first.
The extension uses the clicked side's connection and language.

The read-only panel shows Preview's nested placeholders and component occurrences,
including standard partial-design wrappers. Expand or collapse sections to inspect
the layout. Each component shows its immediate datasource reference; Details
contains the full reference, instance UID and effective parameter object.
Datasource references do not open an editor or recursively load referenced items.

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
