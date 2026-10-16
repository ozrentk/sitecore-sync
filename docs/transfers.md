# Transfer content between environments

[Documentation index](README.md) · [Project overview](../README.md)

Start in [Compare](browse-and-compare.md#switch-to-compare-and-back). Transfers enter the shared [Operations queue](operations.md); selecting a field or tree does not execute a transfer by itself.

## Transfer a subtree

Right-click an item and choose **Tree Transfer Left > Right** or **Tree Transfer Right > Left**. Choose **Add missing content** to preserve matching target items, **Synchronize from source** to replace matching items while retaining target-only descendants, or **Exact mirror** to replace the complete target subtree and delete target-only descendants. The last selected type is remembered globally and offered first next time.

Every tree transfer confirmation states that transferred items include all source languages and versions, regardless of the selected comparison language. Before confirmation, a cancellable structural preflight enumerates both subtrees and reports source and target counts plus how many items will be added, overwritten, or removed. Exact mirror uses a short **Replace target tree?** warning that states the target subtree will be deleted and recreated, then reports matching, source-only, and target-only item counts. There is no separate production-target checkbox. After confirmation, the extension adds the subtree and its transfer type to the workspace's FIFO queue. Field Diff arrows add field-value transfers to the same queue. Duplicate pending requests are not added twice.

## Transfer a field value

When both sides contain a field with different values, the arrows above and below its **Value** indicator add a confirmed field transfer in either direction. Processing uses one Authoring `updateItem` mutation. An inherited or Standard Value becomes an explicit stored target value; fallback-derived values are not eligible.

Field transfers re-read both endpoints, reject changed source or target state, issue one non-retried Authoring mutation, and verify the result. Finished work refreshes affected loaded comparison data.

## Processing and progress

Subtree rows show six phases: queued, freshness checking, content export, chunk copying, Sitecore import, and verification. Chunk copying uses the actual Content Transfer count, for example `copying chunks (4/6, chunk 7/23)`. The Sitecore phase reports completed transfer blobs and elapsed phase time, for example `Sitecore (5/6, blob 0/1 imported, 8m 15s)`. Item Transfer polling starts near two-second intervals, backs off to 5, 10, and finally 15 seconds for long-running imports, and applies small jitter. Field-value rows show four phases from queued through verification. Detailed subtree progress is persisted with the queue record and remains visible on failure.

Subtree processing uses Content Transfer and Item Transfer with `KeepExistingItem`, `OverrideExistingItem`, or `OverrideExistingTree` according to the selected transfer type, preserving IDs and transferring every language and numbered version. It is disabled for the same XM Cloud environment and the complete `/sitecore` root. Same-path/different-ID conflicts block add-missing and synchronize transfers; exact mirror resolves them by removing the target identities and writing the source identities. Only explicit `TransferState: Finished` is success; unknown consumed history remains pending and is polled over as many windows as necessary.

## Deployment changes during a transfer

When deployment information is available for both sides, the processor records the latest source and destination deployment IDs at subtree start. It checks those IDs during long-running Content and Item Transfer polling, throttled to at most once every 15 seconds, and persists the baselines for restart recovery. If either ID changes, the transfer fails, the queue pauses, and retry discards the old remote checkpoint and starts a fresh transfer. Missing permissions and temporary monitoring errors are logged but never block or fail a transfer.

Configure credentials in [deployment monitoring](connections.md#deployment-monitoring). See [queue recovery](operations.md#recover-and-retry) before retrying an operation with an uncertain remote outcome.
