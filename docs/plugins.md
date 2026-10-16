# Item task plug-ins

[Documentation index](README.md) · [Project overview](../README.md)

Right-click an item in Browse or Compare and choose **Run task…** to run a matching workspace JavaScript or PowerShell plug-in. Create each plug-in beneath `.xm-cloud-sync/tasks/<task-name>/` with a `task.json` manifest and a script contained in the same directory. Tasks can match an item by template ID, item ID, exact immediate-parent path, or exact ancestor path; rules within a manifest are OR conditions. When both comparison sides match, the picker identifies the side, connection, language, and path.

```json
{
  "id": "validate-product",
  "name": "Validate product",
  "description": "Checks product content.",
  "script": "validate-product.js",
  "execution": {
    "type": "javascript"
  },
  "inputs": [
    {
      "id": "market",
      "type": "pick",
      "label": "Market",
      "required": true,
      "options": [
        { "label": "United Kingdom", "value": "uk" },
        { "label": "Germany", "value": "de" }
      ]
    }
  ],
  "matches": {
    "templateIds": ["{TEMPLATE-ID}"],
    "itemIds": [],
    "parentPaths": [],
    "ancestorPaths": ["/sitecore/content/Products"]
  }
}
```

Inputs support `text`, `number`, `pick`, and `boolean`. Common properties are `id`, `type`, `label`, optional `description`, `required`, and `default`. Text inputs can provide `placeholder`; number inputs can provide `minimum` and `maximum`; pick inputs require scalar options or `{ "label", "value", "description" }` objects. Collected values are available as `context.inputs.<id>`.

## JavaScript tasks

JavaScript is the recommended execution type for XM Cloud content automation. Set `execution.type` to `javascript` and use a `.js`, `.cjs`, or `.mjs` script that exports an asynchronous `run(context, sitecore, log)` function. The script runs in an isolated Node child process. Its `sitecore` object sends a restricted set of operations back to the extension, where the existing authenticated Authoring API client executes them. Client secrets and access tokens never enter the task process.

```js
exports.run = async function run(context, sitecore, log) {
  const item = await sitecore.items.get({
    itemId: context.item.itemId,
    language: context.language,
    version: context.item.version
  });

  log.info(`Updating ${item.path}`);
  const updated = await sitecore.items.update({
    itemId: item.itemId,
    language: item.language,
    version: item.version,
    fields: {
      Title: "Updated title"
    }
  });

  return { status: "ok", message: `Updated ${updated.path}.` };
};
```

The brokered item API supports:

- `sitecore.items.get({ itemId | path, language?, version? })` — returns complete item details.
- `sitecore.items.getChildren({ itemId | path, language? })` — returns the item and its immediate children.
- `sitecore.items.create({ name, templateId, parent, language?, fields? })` — creates an item and returns complete details. `parent` accepts an item ID or path.
- `sitecore.items.update({ itemId, language?, version, fields })` — updates named string field values and returns refreshed details. A version is required to avoid accidentally updating a different version.
- `sitecore.items.delete({ itemId | path, permanently? })` — deletes to the recycle bin by default; permanent deletion must be explicit.

All operations are scoped to the browsed connection or clicked comparison side and the `master` database. A task cannot request another saved connection. Omitting `language` uses the clicked language. Authoring mutations are not retried automatically. Cancellation terminates the worker and aborts any in-flight Authoring request. The task can return `{ "status": "ok", "message": "Done." }` or `{ "status": "error", "message": "Reason." }`; returning a string is shorthand for a successful message. See `examples/item-task-javascript` for a read-only working plug-in.

`examples/modal-slide-in-authoring` contains the JavaScript port of the modal slide-in inspection and update task. It retains the configured product-page rendering lookup and changes only the selected button's linked Table items. The update task can update, create, and recycle Table items and keeps the TableContainer multilist synchronized. The task deliberately reports an error instead of guessing when an existing Table child needs a new language version, because adding item versions is not yet part of the brokered API.

## Local PowerShell tasks

Local PowerShell is the default execution type. Its script receives `-ContextPath` and `-ResultPath`. Context JSON includes schema version, task identity, collected inputs, comparison side, connection identity without credentials, language, parent and ancestor paths, and complete item details including template, versions, and fields. Standard output and error stream live to **XM Cloud Tasks**. The script can write `{"status":"ok","message":"Done."}` or `{"status":"error","message":"Reason."}` to the result path; a non-zero exit code is always failure. See `examples/item-task` for a working plug-in that can be copied into a workspace.

## SPE remoting

Set `execution.type` to `spe-remoting` for a server-side Sitecore PowerShell Extensions task. Before asking for task inputs or credentials, the extension checks whether the selected PowerShell host can discover the local `SPE` remoting module. If it is missing, execution stops and the notification can copy `Install-Module -Name SPE -Scope CurrentUser` or open the SPE package page. The extension uses the clicked side's connection URL and language, asks for a Sitecore username and password only on first use, and stores the credential per connection in VS Code Secret Storage. A read-only authentication probe must succeed before the actual task script is sent; authentication failure offers credential replacement. Deleting the connection also deletes its SPE credential. The workspace script executes inside Sitecore and receives one `Context` object parameter. SPE Remoting must also be enabled and authorized on the CM environment.

## Trust and execution boundaries

Tasks run only on an explicit click and only in trusted workspaces. JavaScript tasks run in a dedicated child process supplied by the extension. Local tasks use `pwsh -NoLogo -NoProfile -NonInteractive`, falling back to Windows PowerShell when PowerShell 7 is unavailable. SPE remoting tasks use Windows PowerShell on Windows for compatibility with the SPE client module. Scripts run under the machine's normal PowerShell execution policy. Temporary context and result files are deleted after execution. Sitecore credentials are never included in the manifest, context file, command line, or logs.
