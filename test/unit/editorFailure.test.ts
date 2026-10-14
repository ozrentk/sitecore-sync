import { test } from "node:test";
import { match, doesNotMatch } from "node:assert/strict";
import { editorFailure } from "../../src/editor/editorFailure";
import { EditorValidationError } from "../../src/editor/itemEditorModel";
import { AuthoringGraphQlError } from "../../src/sitecore/authoringClient";

test("editor errors identify write/permission failures without exposing server text", () => {
  const failure = editorFailure(new AuthoringGraphQlError("Access denied; sensitive-content=secret-value"), "Sitecore write", true);
  match(failure, /Sitecore write:.*access permissions/);
  match(failure, /remote outcome is unconfirmed/);
  doesNotMatch(failure, /secret-value|sensitive-content/);
  match(editorFailure(new Error("update Authoring item failed (403)."), "Sitecore write", true), /HTTP 403/);
});
test("editor errors preserve local validation while hiding arbitrary failures", () => {
  match(editorFailure(new EditorValidationError("Enter a whole integer or clear the field."), "Save validation", false), /Enter a whole integer/);
  doesNotMatch(editorFailure(new Error("opaque failure with token=secret-value"), "Save readback", true), /secret-value/);
  match(editorFailure(new Error("Authoring did not confirm the requested numbered version; reconcile before retrying."), "Sitecore write", true), /requested numbered version/);
  match(editorFailure(new Error("No custom document found"), "Editor operation", false), /document registration/);
});
