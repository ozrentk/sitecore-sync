# Connections and settings

[Documentation index](README.md) · [Project overview](../README.md)

## Prerequisites

- Install the extension in VS Code 1.100.0 or newer; see [installation and updates](releases.md#install-or-update).
- Have the CM server URL for the XM Cloud environment you want to use.
- Create an environment automation client in Sitecore Deploy and have its client ID and client secret available.

## Add and test a connection

1. Open the **XM Cloud Sync** activity view.
2. In **Connections**, select **Add Connection**.
3. In **Add Connection**, enter **Name**, **CM server URL**, **Client ID**, and **Client secret**.
4. Use **Test connection** to validate the entered credentials without saving. A modal shows success, failure, or cancellation/timeout.
5. Select **Add connection**.

## Edit settings and credentials

Right-click a saved connection and choose **Configure Connection…** to review or edit all of these values. Existing deployment, public URL and traced-publishing commands open the corresponding dashboard section.

Validation appears beside the relevant fields. **Save changes** applies the form, **Cancel** closes it without saving, and **Reload saved values** discards the draft. Closing the tab also discards unsaved values. Stored secrets never populate the webview. **Client secret**, **Organization client secret**, and **Experience Edge token** each use one masked field: enter a new value to replace the saved secret on Save, or leave it empty to keep the saved value. Disabling an optional credential section removes its saved secret when saved. Other credentials remain unchanged. Server or authoring-credential changes are blocked while the connection is referenced by comparisons or operations. Saved favorites and existing language overrides are retained.

## Validate optional monitoring and Edge settings

Deployment tests match the CM host to its environment. Changes to deployment credentials or environment are validated again on Save. Edge endpoint, token or default-site changes require a successful Edge request and a scope review against the connection's Authoring site catalog. A valid Edge token can return a different site catalog from Authoring. The dashboard shows both catalogs in a warning; saving requires **Use token anyway** when they differ. Failed token requests still block saving. Edge tests query the Delivery endpoint first and identify Edge request failures separately from a failed CM/Authoring comparison; HTTP status and safe endpoint/schema/network hints appear beside the relevant field. Run-specific publishing options remain in the publishing form.

Secrets are stored in VS Code `SecretStorage`. OAuth access tokens are kept in memory only. Publishing defaults are configured under **Configure Connection… → Traced publishing**; the per-run route, assertions and publish options are explained in [publishing](publishing.md#configure-a-run).

## Deployment monitoring

Deployment monitoring is optional. The extension first tries the connection's existing credentials; if they already have Deploy API access, no setup is needed. Otherwise subtree transfers continue normally without monitoring. To enable the additional guard explicitly, open **Configure Connection… → Deployment monitoring** and enter an organization automation client with Deploy API access. The extension matches the saved CM hostname to its deployment environment and stores the additional secret in `SecretStorage`.

## Discover sites

After saving a successfully tested connection (or using the saved connection’s play button), expand the connection to see every configured site returned by the Authoring API, including its root path and root item ID. The success notification also provides a searchable **Show Sites** list. This API list can include sites that are not shown as ordinary site tiles in Channels.

If the Authoring API returns identical site records, the extension displays the site once and reports the number of duplicate records omitted. Records are considered identical only when their name, root path, and root item ID all match exactly.

Selecting a connection reveals a trash action beside **Add Connection** and **Open Comparison**. A connection used by an open Browse or Compare view cannot be deleted.

## Public-page URLs

Use **Configure Connection… → Public URLs** to edit the shared template, clearly labelled **All connections**, and each site’s base URLs. **XM Cloud Sync: Configure Public Page URLs** opens this section after choosing a connection; the template still applies to every connection and site. Supported optional placeholders are `{publicBaseUrl}`, `{deploymentBaseUrl}`, `{language}`, `{country}`, and `{route}`. Language and region are inferred from the selected Sitecore language tag: `en-US` becomes `en` and `US`; `zh-Hant-TW` becomes `zh` and `TW`. A language without a region, such as `en`, leaves country unavailable; omit `{country}` or use an optional override. Existing explicit mappings continue to override inference.

URL changes are saved with the dashboard. Site discovery comes from **Test connection**; exact site names may also be entered manually. Existing optional language overrides remain intact.

If the template uses `{publicBaseUrl}` or `{deploymentBaseUrl}`, assign those origins in the same **Public URLs** section. **XM Cloud Sync: Configure Connection/Site Public URL Values** is another entry point to it. The shared template changes only when edited and saved. The deployment value can be a configured Vercel origin. Settings `xmCloudSync.publicPageUrlTemplate` and `xmCloudSync.publicPageValues` allow advanced editing, including optional language/country overrides and a default site for ambiguous roots.

**Open public page** uses the browsed connection or the clicked Compare side. The Field Diff summaries offer **Open left page** and **Open right page**, with the URL in each tooltip. Opening launches the resolved URL directly in the default browser without an additional confirmation. Pages are recognized from a device layout assignment or a rendering assignment in shared/final presentation fields, including final-layout deltas whose layout is inherited from Standard Values. If Authoring returns neither assignment, page detection is unavailable. If neither the item nor an eligible ancestor has detected page presentation, the public-page link is omitted; Item Details and Field Diff do not show a missing-presentation warning. Datasources resolve through the nearest page ancestor within their site; shared datasources outside page ancestry are unsupported. Ancestry does not prove exclusive usage. Traced/Power Publish reuse this resolver for their editable initial application URL. Without a template, existing publishing URL behavior is preserved.

Route calculation currently uses the existing Home-relative, slug-based suggestion. Custom routing, aliases and rewrites may require editing the publishing URL or adapting the shared template; automatic Vercel discovery is not performed. Presentation inheritance is described in [Sitecore's layout documentation](https://doc.sitecore.com/xp/en/users/104/sitecore-experience-platform/edit-the-layout-of-an-item.html).

## Next steps

[Browse your content](browse-and-compare.md) or configure a [publishing run](publishing.md).
