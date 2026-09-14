export interface ConnectionAddedActions {
  readonly sharedTemplate: () => unknown;
  readonly notify: (message: string, ...actions: string[]) => Promise<string | undefined>;
  readonly testConnection: () => Promise<void>;
  readonly configureTemplate: () => Promise<void>;
}

// Called only after the connection and its secret have been saved successfully.
export async function notifyConnectionAdded(name: string, actions: ConnectionAddedActions): Promise<void> {
  const template = actions.sharedTemplate();
  const missingTemplate = typeof template !== "string" || !template.trim();
  const choice = await actions.notify(
    `Added XM Cloud connection “${name}”.${missingTemplate ? " Set up the shared public-page URL template now?" : ""}`,
    "Test Connection",
    ...(missingTemplate ? ["Set up URL template", "Not now"] : []),
  );
  if (choice === "Test Connection") { await actions.testConnection(); }
  if (missingTemplate && choice === "Set up URL template") { await actions.configureTemplate(); }
}
