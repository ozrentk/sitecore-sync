# Operations and recovery

[Documentation index](README.md) · [Project overview](../README.md)

## Run and pause the queue

Open **Operations** in the activity view and select Play to process transfer and publishing records one at a time in insertion order. Pause stops before the next operation or at an operation-specific safe boundary; an already-issued request is allowed to reach that boundary. Queue contents, order, processing state, publishing runs, and remote checkpoints survive VS Code restarts. Completed records move to **Recent Operations** after their secret-free journal is written; the newest 30 are retained and the newest 10 are shown initially. A failure remains at the queue head, pauses processing, and can be retried or removed.

Transfers and publishing share this queue. See [transfer phases](transfers.md#processing-and-progress) and [publishing evidence](publishing.md#trace-evidence-and-recovery) for operation-specific progress.

## Replay and operation sequences

Completed or failed rows can be replayed with current runtime state, or used to create and extend a reusable **Operation Sequence**. Sequences are ordered definitions rather than another queue: **Run Sequence** starts one explicitly and only one sequence may run at a time. A paused sequence releases Operations so standalone work or another sequence can run. Sequence failures show **Paused on operation** and offer Retry, Skip, or Stop; running and paused definitions remain immutable and can be duplicated for future changes. The newest ten terminal runs appear under **Recent Sequence Runs**.

## Recover and retry

A failed operation stays at the queue head and pauses processing. Inspect its status and journal before choosing Retry or removing it. Retry behavior depends on the operation and saved checkpoint; it is not permission to blindly repeat a mutation with an unknown outcome.

Publishing has separate **Retry failed verification**, **Check status again**, **Publish again…**, and tracking-abandonment actions; see [trace evidence and recovery](publishing.md#trace-evidence-and-recovery). Abandoning local tracking cannot cancel a remote Sitecore publish.

For a transfer interrupted by a deployment change, see [transfer recovery behavior](transfers.md#deployment-changes-during-a-transfer). [Item-editor save recovery](item-editor.md#save-conflicts-and-recovery) and [MCP mutation records](mcp.md#mutation-records-and-recovery) have their own workflows and are not interchangeable with queue retry.

## Status and cancellation

Play processes records in order. Pause stops at the next supported safe boundary, not necessarily in the middle of an issued request. Use the operation-specific cancellation or recovery action where offered. Cancelled monitoring does not prove that a remote write or publish was cancelled. Logs and persistent records should be checked before attempting the work again.
