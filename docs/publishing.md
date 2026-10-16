# Publish and verify content

[Documentation index](README.md) · [Project overview](../README.md)

Right-click an item in Browse, or the intended left/right item cell in Compare, and open **Publish**:

- **Standard publish…** performs an ordinary Sitecore Smart or Full publish for the selected language, with optional descendants and related items. It monitors the Sitecore operation to completion and reports through a notification and the **XM Cloud Publish** output channel.
- **Traced publish…** additionally snapshots authoring content and verifies propagation through raw Experience Edge items, optional rendered route layout, and an optional public application response.
- **Power publish…** reuses the grouped Traced Publish configuration and continues into a **collapsed scope graph**. Each graph node represents one structural Sitecore scope and exposes only references leaving that boundary. Selecting or expanding an external scope scans it on demand, so dependency discovery proceeds only where the user chooses. Selected dependency scopes publish before the selected route root, followed by the single configured route/application trace.

## Configure a run

Traced publishing uses the Experience Edge endpoint, API token and default site saved in **Configure Connection… → Traced publishing**. If these defaults are missing, starting a diagnostic publish opens that dashboard section; save the settings and start publishing again. See [connection settings](connections.md#validate-optional-monitoring-and-edge-settings) for token validation and catalog mismatches. The publishing-run form still selects the route, site, application URL and field assertions for that run. **XM Cloud Sync: Configure Traced Publishing** also opens the dashboard.

For route verification, the extension prefills an editable Sitecore route from the selected item's path relative to the chosen site's verified root path. The prefix through a conventional `Home` route-start item is omitted and remaining item-name segments are converted to URL slugs, so both `Home/Station Wagon` and `Global/Home/Station Wagon` become `/station-wagon`. This is a suggestion only: it can be changed for custom URL rules or cleared to skip route verification.

When the selected item is beneath a conventional page-local `Data` subtree, the suggested route stops at the owning page. For example, `Station Wagon/Data/…/See More` suggests `/station-wagon`.

The application URL is optional unless Browser DOM selectors are configured. When supplied, the extension makes a normal public HTTPS request and records status plus cache headers such as `Age`, `Cache-Control`, `x-vercel-cache`, and `x-vercel-id`. This requires no Vercel credentials. A successful response containing the selected text is matched; a successful response without it is **inconclusive**, not failed, because the plain probe cannot see text added by browser-side rendering or hydration. If the URL is omitted or inaccessible, only that stage is skipped or marked unavailable; Sitecore and Experience Edge tracing still run.

## Select field assertions

When a route is configured, Traced publish offers an optional searchable field picker. It includes the selected item's non-standard fields and, only when **Descendants** is selected, fields from structural descendants in the same publish tree. **Related items** can still be sent to Sitecore as ordinary publishing scope, but referenced-item fields are intentionally excluded from Traced verification. Selected values are shown explicitly in the Authoring, raw Edge, rendered-layout, and optional application-response evidence. A selected field that is absent from rendered layout data is reported as not observable and makes that stage diverge.

## Choose Power Publish scopes

Power Publish uses the same field picker and keeps assertions limited to the configured structural scope. It has no **Include related items** switch. Layout fields contribute only component datasources; supported item-link and media fields contribute their actual targets. Content and media outside the current collapsed scope appear as opt-in child scopes. Template, layout, system, unsupported, and external-URL references are omitted from the tree and retained only as aggregate evidence. Selected scopes must scan completely before queueing. A scan pauses after a 500-item or 200-unique-external-scope work chunk and can be continued without losing cached results; internal and non-publishable references do not consume the external-scope budget. Traced Publish records supported references outside its structural scope as advisory Authoring evidence only.

## Verify browser-rendered content

When an application URL is supplied, selected assertions can optionally be associated with CSS selectors for a separate **Browser DOM** stage. Selectors can be entered before the URL, but queueing requires and focuses the exact application URL whenever any selector is present. The grouped configuration page shows that URL beside the selectors so that an environment mismatch can be caught before publishing. The extension launches an isolated headless Google Chrome or Microsoft Edge instance, waits for JavaScript hydration and the selector, then checks normalized element `textContent` for the selected field value using locale-independent, case-insensitive containment. Punctuation remains significant. Matching any selected element is sufficient when a selector returns multiple elements. A found element with different text diverges; an invalid or missing selector is inconclusive. Browser profiles, cookies, and authenticated sessions are not reused. Prefer stable IDs or `data-*` attributes because browser-generated `nth-child` selectors can break when page structure changes.

Traced- and Power-publish preparation use the same editor-area configuration page rather than a chain of prompts. Publishing mode and applicable scope, verified Sitecore site, editable route, exact application URL, field assertions, and optional per-field CSS selectors are reviewed together before queueing. Fields are added through the searchable picker; only selected assertions remain in the compact list, where they can receive a CSS selector or be removed. Traced Publish loads structural descendant fields after descendants are enabled; Power Publish loads them automatically because every collapsed scope always represents its structural subtree. For Power Publish, **Publish structural descendants through Sitecore** controls execution only: enabled delegation sends each selected scope root to Sitecore with descendants, while disabled delegation sends every inspected item in the selected scopes explicitly. Power Publish continues into collapsed-scope review, while Traced Publish queues directly. First-time Experience Edge endpoint and token setup remains separate so the token can be validated and saved separately from run options; a stored token is never populated back into the webview.

## Trace evidence and recovery

If saved monitoring state becomes stale, run **XM Cloud Sync: Abandon Current Publish Tracking**. The same recovery is offered as **Abandon and Continue** when a new publish is blocked. It aborts local monitoring, marks incomplete traces as locally abandoned with unknown server status, and releases the extension lock. It cannot cancel a publishing operation that is still running in XM Cloud.

Completed Publish Traces provide contextual recovery actions when appropriate. **Retry failed verification** reruns diagnostic reads from the first failed Edge, layout, or application stage without publishing again. A Power Publish Edge divergence additionally offers **Force republish missing items**, which creates a new durable Full-publish operation containing only the missing or mismatched observed items. **Publish again…** starts the normal, newly confirmed publish flow after a publishing failure or an abandoned trace with no operation ID. **Check status again** polls only the saved operation IDs from an abandoned trace; it never starts a batch that has no operation ID. Up to ten previous attempts and their stage evidence remain expandable in the same trace.

Traced and Power operations use one progressive **Publish Trace** document. Evidence and selected-scope reference details stay collapsed until opened. Standard publish normally uses only progress notifications; the trace opens if it fails. Run **XM Cloud Sync: Show Latest Publish Trace** to reopen recent evidence or **XM Cloud Sync: Show Publish Output** for low-level polling details.

## Dependency batches and Edge verification

Power dependencies are grouped by dependency layer and sent to Sitecore in batches of up to 20 independent IDs; cyclic components remain together and the selected page root stays in a final batch. With Sitecore descendant delegation enabled, those IDs are selected collapsed-scope roots. Without delegation, they are the inspected concrete items contained by the selected scopes. The Sitecore publishing stage exposes live per-batch submission, state, processed-item, and completion progress. Every Sitecore batch completes before one aggregate Raw Experience Edge verification checks every observable item identity plus selected and graph-forming reference fields. Authoring snapshots with version `0` in the requested language are not Edge-observable and are recorded as skipped evidence instead of failures. The verifier reports incremental checked and matched counts; after its first complete pass, it rechecks only the items that have not matched, using a 30-second propagation retry window. A missing or mismatched observable item does not suppress later diagnostics; it appears in the final verification evidence. Batch operation IDs and the final Edge result are persisted for restart recovery and targeted repair.

Publish operations and their Sitecore operation IDs are persisted so monitoring can resume after VS Code restarts. Redacted JSON journals are written beneath VS Code extension storage. Publish mutations are not retried automatically.

## Publishing-status metadata

Invalid publishing-status responses identify the failed contract fields and received types without exposing response values. They leave the remote outcome unknown and do not trigger an automatic republish.

Publishing status may return null language metadata. This is treated as unavailable metadata; polling and completion/failure decisions still use the validated job state and flags. Malformed non-null language values remain errors.

## Queue and logs

Publishing records use [Operations](operations.md). See [troubleshooting](troubleshooting.md) for safe diagnostic collection.
