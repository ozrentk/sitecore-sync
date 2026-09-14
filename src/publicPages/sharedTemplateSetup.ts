import { validatePublicPageTemplate } from "./publicPageUrl";

export interface SharedTemplateSetup {
  readonly askTemplate: () => Promise<string | undefined>;
  readonly saveTemplate: (template: string) => Promise<void>;
  readonly offerHomepage: () => Promise<boolean>;
  readonly openHomepage: (template: string) => Promise<void>;
}

export async function configureSharedTemplate(setup: SharedTemplateSetup): Promise<void> {
  const template = await setup.askTemplate();
  if (template === undefined) { return; }
  const value = template.trim();
  const error = validatePublicPageTemplate(value);
  if (error) { throw new Error(error); }
  await setup.saveTemplate(value);
  if (value && await setup.offerHomepage()) { await setup.openHomepage(value); }
}
