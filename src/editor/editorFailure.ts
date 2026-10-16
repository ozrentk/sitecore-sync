import { AuthoringGraphQlError } from "../sitecore/authoringClient";
import { EditorValidationError } from "./itemEditorModel";

export function editorFailure(error: unknown, stage: string, pending: boolean): string {
  let detail = "The operation failed; no safe server details are available.";
  const message = error instanceof Error ? error.message : "";
  if (error instanceof EditorValidationError) detail = message;
  else if (error instanceof AuthoringGraphQlError) {
    detail = { permission: "Sitecore rejected the request because of access permissions.",
      locked: "Sitecore rejected the request because the item requires an appropriate lock or checkout.",
      validation: "Sitecore rejected the GraphQL request contract or input values.",
      other: "Sitecore returned a GraphQL error. Raw response text was omitted to protect sensitive data." }[error.reason];
  } else if (/^(?:update Authoring item|Sitecore Authoring item-details query|Sitecore Authoring non-Standard fields query|Authentication) failed \(\d{3}\)\.$/u.test(message)) {
    const status = /\d{3}/u.exec(message)![0];
    detail = `Sitecore request failed (HTTP ${status}).${status === "401" || status === "403" ? " Check this connection's credentials and write permissions." : ""}`;
  } else if (message === "No custom document found") detail = "VS Code lost the editor document registration. Keep the draft and reopen the item after reloading the updated extension.";
  else if (message === "Authoring did not confirm the requested numbered version; reconcile before retrying.") detail = "Sitecore's update response did not confirm the requested numbered version.";
  else if (message === "Authoring API did not confirm the updated item.") detail = "Sitecore's update response did not confirm the requested item and locale.";
  else if (message === "Connection target changed. This draft cannot be saved to a different server.") detail = message;
  else if (message === "Connection credentials are unavailable.") detail = message;
  else if (message === "Editor inputs could not be synchronized. Keep the tab open and retry.") detail = message;
  else if (error instanceof Error && ["AbortError", "TimeoutError", "Canceled", "CancellationError"].includes(error.name)) detail = "The operation was cancelled or timed out.";
  return `${stage}: ${detail} Draft preserved.${pending ? " The remote outcome is unconfirmed; use Check save outcome before any retry." : ""}`;
}
