"use strict";

exports.run = async function run(context, sitecore, log) {
  const item = await sitecore.items.get({
    itemId: context.item.itemId,
    language: context.language,
    version: context.item.version
  });
  const treeLevel = await sitecore.items.getChildren({
    itemId: context.item.itemId,
    language: context.language
  });

  log.info(`Item: ${item.path}`);
  log.info(`Template: ${item.template.name} (${item.template.templateId})`);
  log.info(`Fields: ${item.fields.length}`);
  log.info(`Immediate children: ${treeLevel.children.length}`);

  return {
    status: "ok",
    message: `Inspected ${item.path}.`
  };
};
