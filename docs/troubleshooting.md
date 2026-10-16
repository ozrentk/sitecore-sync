# Troubleshooting and support

[Documentation index](README.md) · [Project overview](../README.md)

## Start with logs

Run **XM Cloud Sync: Show Logs** to open the extension's diagnostic log. It records comparison loading, caching, errors, retry attempts, and cooldown waits without recording client secrets, access tokens, request bodies, or query parameters.

For publish polling, use **XM Cloud Sync: Show Publish Output**. For saved propagation evidence, use **XM Cloud Sync: Show Latest Publish Trace**. Item tasks write to **XM Cloud Tasks**.

When reporting a problem, include the extension and VS Code versions, command/action, connection label, locale, numbered version, expected result, exact safe error and reproducible steps. Review logs, screenshots and diagnostic JSON before sharing: item content may contain sensitive data even when authentication credentials are redacted. Track known issues in [BACKLOG.md](../BACKLOG.md); contributor investigation instructions are in [CONTRIBUTING.md](../CONTRIBUTING.md).

## Connection or Edge token test fails

Use **Configure Connection…**, review the field-level validation and run **Test connection**. Edge catalog mismatches and the **Use token anyway** decision are explained in [connection settings](connections.md#validate-optional-monitoring-and-edge-settings). Do not paste secrets into an issue or diagnostic report.

## Fields appear empty or read-only

Check the selected locale and numbered version, then the Content/Standard Template/system visibility controls. **Show all fields** restores Browse visibility. Version 0 and fallback evidence have different meanings; see [languages and fallback](languages-and-fallback.md). Unsupported field types, Sources and representations remain inspectable in the [item editor](item-editor.md#field-support).

## General Link properties (B31)

During 0.45.0 verification, the General Link destination-focus expansion integration assertion repeatedly failed; normal interactive reproduction is unverified. Try the explicit properties chevron and report whether mouse and keyboard navigation behave differently. No fix is claimed. The accepted release exception and its test-coverage limits are documented in [releases](releases.md#known-verification-exception-for-v0450); B31 remains open in the backlog.

## A save, transfer or publish has an uncertain outcome

Do not assume a failed response means the remote write did not happen. Use [Check save outcome](item-editor.md#save-conflicts-and-recovery), [queue recovery](operations.md#recover-and-retry), or [publishing recovery](publishing.md#trace-evidence-and-recovery), according to the operation. Inspect [MCP mutation records](mcp.md#mutation-records-and-recovery) before retrying an agent mutation.

## An asset preview is unavailable

See the [supported preview formats, hosts and limits](item-editor.md#read-only-fields-and-previews). Private/gateway URLs, redirects, unsupported SVG, TLS trust problems and oversized responses are distinct from empty fields. Original XML and metadata remain available. Do not disable certificate verification to work around a trust failure.

## MCP is unavailable

Keep the local trusted VS Code window open and run **XM Cloud Sync: Start MCP Access** for the intended connections. Reconnect the client if its tool list is stale. After restarting access, mutations are disabled until explicitly enabled again. Follow the [MCP setup and launcher guide](mcp.md).

## Request retries and privacy

Connection secrets, access tokens, and Authoring API requests remain in the extension host and are never exposed to the webview.

Sitecore OAuth and Authoring GraphQL traffic passes through a shared request client. For retryable reads, a transient network failure or HTTP 408, 429, 500, 502, 503, or 504 response is retried up to three times after the initial attempt. Retries use exponential backoff starting near 500 ms with jitter. When Sitecore supplies `Retry-After` as seconds or an HTTP date, that delay takes precedence and also pauses other requests to the same endpoint origin. Retry waits can be cancelled. Permanent client and authorization responses, GraphQL errors, and missing items are returned immediately instead of being retried.

Mutations are not retried automatically. See the relevant operation guide before retrying manually. Asset preview HTTP reads have their own [no-retry policy](item-editor.md#read-only-fields-and-previews).
