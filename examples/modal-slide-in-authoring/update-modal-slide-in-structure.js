"use strict";

const IDS = {
  modalSlideInButtonTemplate: "{6F0F698D-E5BD-4FBD-85EA-972976FA0E09}",
  tableContainerTemplate: "{408A6758-22DE-4C65-BE4A-4F9B41F826FC}",
  tableTemplate: "{B6DE3C61-BC55-4BC5-B549-4AD0C651430C}",
  kvfTemplate: "{ED9C3AC2-D382-40FC-9222-9C35225FF981}",
  productDetailCardGridRendering: "{58246F97-6619-41D9-9988-13D474AF7989}",
  buttonModal: "{CD9A7273-1730-4B9D-ACDD-5FB0DD270DB8}",
  slideInContent: "{A3866BDE-6602-4A9E-AF1B-FCC89B0A280D}",
  containerTables: "{D551A984-F971-4CC0-9A87-77F031678AE1}",
  tableTitle: "{4F1B825C-DA6D-4E8E-A303-53DB87F47B44}",
  tableAccordion: "{B65F6F91-3FF2-4E08-AAD9-C503437F79F2}",
  tableBody: "{B4632386-4A61-4B60-AF7B-F3E90FB0F3CA}",
  kvfKey: "{43561466-E956-42C6-AAF6-0A9941A51594}",
  kvfContent: "{2394CC50-12CA-4ABB-AB41-6B6ABE39FB0B}",
  detailCards: "{B2E6F59A-F3F8-4E4C-A689-5398949A9E73}"
};

const KVF_ROOT = "/sitecore/content/IAL/Settings/Checkout/Order Summary/Key Vehicle Features";
const PRODUCT_PAGES = [
  {
    label: "Station Wagon (en/gb/station-wagon)",
    path: "/sitecore/content/IAL/Grenadier/global/home/Station Wagon",
    modelPrefix: "G01"
  },
  {
    label: "Quartermaster (en/gb/quartermaster)",
    path: "/sitecore/content/IAL/Grenadier/global/home/Quartermaster",
    modelPrefix: "G09"
  }
];
const TARGET_VARIANTS = ["Fieldmaster", "Trialmaster"];
const MARKET_TO_REGION = {
  uk: "EU",
  de: "EU",
  es: "EU",
  us: "NAFTA",
  ca: "NAFTA",
  au: "ANZ",
  za: "ROW"
};
const VARIANT_TO_TRIM_CODE = {
  Fieldmaster: { EU: "PPQ", ROW: "PPR", NAFTA: "PPS", ANZ: "PPX", China: "CHC" },
  Trialmaster: { EU: "PPT", ROW: "PPU", NAFTA: "PPV", ANZ: "PPY", China: "CHB" },
  Grenadier: {
    EU: "BaseKeyFeaturesList",
    ROW: "BaseKeyFeaturesList",
    NAFTA: "BaseKeyFeaturesList",
    ANZ: "BaseKeyFeaturesList",
    China: "CHA"
  }
};

exports.run = async function run(context, sitecore, log) {
  const language = String(context.language || "");
  const market = String(context.inputs?.market || "").toLowerCase();
  const dryRun = context.task.id.startsWith("inspect-");
  const cache = new Map();
  let changeCount = 0;

  const get = async (locator, version) => {
    const key = JSON.stringify([locator, language, version ?? null]);
    if (!cache.has(key)) {
      cache.set(key, sitecore.items.get({ ...locator, language, ...(version ? { version } : {}) }));
    }
    return await cache.get(key);
  };
  const getByReference = async (reference, version) => {
    const value = String(reference || "").trim();
    if (!value) {
      throw new Error("An empty Sitecore item reference cannot be resolved.");
    }
    return await get(value.startsWith("/") ? { path: value } : { itemId: value }, version);
  };
  const tryGetByReference = async (reference, version) => {
    try {
      return await getByReference(reference, version);
    } catch {
      return undefined;
    }
  };
  const updateFields = async (item, fields) => {
    const updated = await sitecore.items.update({
      itemId: item.itemId,
      language,
      version: item.version,
      fields
    });
    invalidateItem(cache, item.itemId);
    return updated;
  };

  if (!language) {
    throw new Error("The task context does not contain a language.");
  }
  const region = MARKET_TO_REGION[market];
  if (!region) {
    throw new Error(`No region mapping found for market '${market}'.`);
  }

  const selectedButton = await get(
    { itemId: context.item.itemId },
    context.item.version
  );
  if (!sameId(selectedButton.template.templateId, IDS.modalSlideInButtonTemplate)) {
    throw new Error(`Selected item '${selectedButton.path}' is not a ModalSlideInButton.`);
  }

  log.info(`Selected button: ${selectedButton.path} ${selectedButton.itemId}`);
  log.info(`Mode: ${dryRun ? "inspect" : "apply"} | Market: ${market} | Language: ${language}`);
  log.info("");
  log.info("================================================================");
  log.info("STEP 1: Page Product Detail Cards - Slide-In Button Mapping");
  log.info("================================================================");

  const mappings = [];
  for (const page of PRODUCT_PAGES) {
    log.info(`PAGE: ${page.label}`);
    const pageItem = await tryGetByReference(page.path);
    if (!pageItem) {
      log.warn(`  Page item not found: ${page.path}`);
      continue;
    }
    const finalLayout = fieldValue(pageItem, "__Final Renderings");
    const dataSources = renderingDataSources(finalLayout, IDS.productDetailCardGridRendering);
    if (dataSources.length === 0) {
      log.warn("  No ProductDetailCardGrid rendering found on Final Layout.");
      continue;
    }
    for (const dataSource of dataSources) {
      if (!dataSource || dataSource.startsWith("query:")) {
        log.warn(`  Unsupported datasource reference: ${dataSource || "(empty)"}`);
        continue;
      }
      const dataSourceItem = await tryGetByReference(dataSource);
      if (!dataSourceItem) {
        log.warn(`  Datasource item not resolved: ${dataSource}`);
        continue;
      }
      for (const cardId of references(fieldValue(dataSourceItem, IDS.detailCards))) {
        const card = await tryGetByReference(cardId);
        if (!card) {
          log.warn(`  Missing detail card: ${cardId}`);
          continue;
        }
        const heading = fieldValue(card, "heading");
        const variant = TARGET_VARIANTS.find((candidate) =>
          heading.toLowerCase().includes(candidate.toLowerCase())
        );
        if (!variant) {
          continue;
        }
        for (const ctaId of references(fieldValue(card, "ctasSelection"))) {
          if (!sameId(ctaId, selectedButton.itemId)) {
            continue;
          }
          if (mappings.some((entry) => sameId(entry.button.itemId, selectedButton.itemId))) {
            throw new Error(
              `ModalSlideInButton '${selectedButton.name}' is linked from more than one detail card.`
            );
          }
          mappings.push({
            button: selectedButton,
            variant,
            pageLabel: page.label,
            pagePath: page.path,
            modelPrefix: page.modelPrefix
          });
          log.info(`  ${variant}: ${selectedButton.name} <- selected slide-in button`);
        }
      }
    }
  }
  if (mappings.length !== 1) {
    throw new Error(
      `Selected ModalSlideInButton '${selectedButton.path}' was resolved ${mappings.length} times; expected exactly once.`
    );
  }

  log.info("");
  log.info("================================================================");
  log.info("STEP 2: Modal Slide-In Structure");
  log.info("================================================================");

  const mapping = mappings[0];
  const tablesByType = {};
  const modalReference = fieldValue(selectedButton, IDS.buttonModal);
  if (!modalReference) {
    throw new Error(`Button '${selectedButton.name}' has no modal item.`);
  }
  const modal = await getByReference(modalReference);
  log.info(`Modal: ${modal.path}`);
  const contentReferences = references(fieldValue(modal, IDS.slideInContent));
  if (contentReferences.length === 0) {
    throw new Error(`Modal '${modal.path}' has no referenced content.`);
  }

  for (const contentId of contentReferences) {
    const container = await getByReference(contentId);
    if (!sameId(container.template.templateId, IDS.tableContainerTemplate)) {
      if (sameId(container.template.templateId, IDS.tableTemplate)) {
        log.warn(`Table '${container.path}' is referenced outside a TableContainer.`);
      }
      continue;
    }

    const tableItems = [];
    for (const tableId of references(fieldValue(container, IDS.containerTables))) {
      const table = await getByReference(tableId);
      tableItems.push({
        item: table,
        name: table.name,
        title: stripTags(fieldValue(table, IDS.tableTitle)).replace(/[\r\n]+/gu, " ").trim(),
        body: fieldValue(table, IDS.tableBody)
      });
      log.info(`  ${container.name} -> ${table.name}`);
    }

    if (container.name.endsWith(" Standard Features")) {
      assertCount(tableItems, 2, `'${container.name}' tables`);
      const empty = tableItems.filter((table) => table.name === "Table Empty");
      const base = tableItems.filter((table) => table.name.endsWith(" Base"));
      assertCount(empty, 1, `'${container.name}' Table Empty`);
      assertCount(base, 1, `'${container.name}' Base table`);
      tablesByType.standardFeaturesEmpty = empty[0];
      tablesByType.standardFeaturesBase = base[0];
    } else if (container.name.endsWith(" FeatureLists")) {
      assertCount(tableItems, 1, `'${container.name}' tables`);
      tablesByType.featureLists = tableItems[0];
    } else if (container.name.endsWith(" Packs")) {
      tablesByType.packs = { container, tables: tableItems };
    }
  }

  for (const [key, label] of Object.entries({
    standardFeaturesEmpty: "StandardFeatures_Empty",
    standardFeaturesBase: "StandardFeatures_Base",
    featureLists: "FeatureLists",
    packs: "Packs"
  })) {
    if (!tablesByType[key]) {
      throw new Error(`Required destination structure '${label}' was not found.`);
    }
  }

  log.info("");
  log.info("================================================================");
  log.info(`STEP 3: Mapping KVF source for market ${market}`);
  log.info("================================================================");

  const trimCode = VARIANT_TO_TRIM_CODE[mapping.variant]?.[region];
  if (!trimCode) {
    throw new Error(`No trim code for variant '${mapping.variant}' in region '${region}'.`);
  }
  const kvfRootLevel = await sitecore.items.getChildren({ path: KVF_ROOT, language });
  const folderCandidates = kvfRootLevel.children.filter((child) =>
    child.name.endsWith("E") && child.name.startsWith(mapping.modelPrefix)
  );
  assertCount(folderCandidates, 1, `KVF folder '${mapping.modelPrefix}*E'`);
  const kvfFolder = folderCandidates[0];
  const expectedBaseKey =
    `Grenadier.Checkout.CarConfigurator.BaseKeyFeaturesList.${kvfFolder.name}`;
  const expectedTrimKey =
    `Grenadier.Checkout.CarConfigurator.Option.FeatureList.${kvfFolder.name}.Z_TRIM_LEVELS.${trimCode}`;
  log.info(`KVF folder: ${kvfFolder.path}`);
  log.info(`Base key: ${expectedBaseKey}`);
  log.info(`Trim key: ${expectedTrimKey}`);

  const kvfLevel = await sitecore.items.getChildren({ itemId: kvfFolder.itemId, language });
  const kvfItems = [];
  for (const child of kvfLevel.children) {
    const item = await get({ itemId: child.itemId });
    if (sameId(item.template.templateId, IDS.kvfTemplate)) {
      kvfItems.push(item);
    }
  }
  const baseTargets = kvfItems.filter((item) => fieldValue(item, IDS.kvfKey) === expectedBaseKey);
  const trimTargets = kvfItems.filter((item) => fieldValue(item, IDS.kvfKey) === expectedTrimKey);
  assertCount(baseTargets, 1, `base KVF item '${expectedBaseKey}'`);
  assertCount(trimTargets, 1, `trim KVF item '${expectedTrimKey}'`);

  const baseContent = fieldValue(baseTargets[0], IDS.kvfContent);
  const trimContent = fieldValue(trimTargets[0], IDS.kvfContent);
  if (!baseContent.trim()) {
    throw new Error(`Base KVF content is empty for language '${language}'.`);
  }
  if (!trimContent.trim()) {
    throw new Error(`Trim KVF content is empty for language '${language}'.`);
  }

  const parsedLists = parseUlBlocks(trimContent);
  if (parsedLists.roots.length === 0) {
    throw new Error(`KVF trim content has no root <ul> block for language '${language}'.`);
  }
  const newBaseHtml = addTypographySpans(baseContent);
  const newFeatureListsHtml = addTypographySpans(parsedLists.roots[0].html);
  const packBlocks = parsedLists.nested.map((block) => ({
    name: packNameBefore(trimContent, block.start),
    html: block.html
  }));
  const duplicatePackNames = duplicateValues(
    packBlocks.map((block) => decodeHtml(block.name).trim().toLowerCase())
  );
  if (duplicatePackNames.length > 0) {
    throw new Error(`KVF trim content contains duplicate pack names: ${duplicatePackNames.join(", ")}.`);
  }

  const emptyBody = tablesByType.standardFeaturesEmpty.body;
  if (emptyBody.trim()) {
    log.warn(`Table Empty is unexpectedly non-empty: ${preview(emptyBody)}`);
  }

  changeCount += await compareAndMaybeUpdate(
    "Standard Features / Base",
    tablesByType.standardFeaturesBase,
    newBaseHtml,
    dryRun,
    updateFields,
    log
  );
  changeCount += await compareAndMaybeUpdate(
    "FeatureLists",
    tablesByType.featureLists,
    newFeatureListsHtml,
    dryRun,
    updateFields,
    log
  );

  const packs = tablesByType.packs;
  let container = packs.container;
  let tableReferences = references(fieldValue(container, IDS.containerTables));
  const matchedPackNames = new Set();

  for (const table of packs.tables) {
    const matched = packBlocks.find((block) =>
      block.name.localeCompare(table.title, undefined, { sensitivity: "base" }) === 0
    ) || (
      !table.title.trim()
        ? packBlocks.find((block) =>
            `Table - ${block.name}`.localeCompare(table.name, undefined, { sensitivity: "base" }) === 0
          )
        : undefined
    ) || packBlocks.find((block) => sameWordSet(table.title, block.name));

    if (matched) {
      matchedPackNames.add(matched.name.toLowerCase());
      changeCount += await compareAndMaybeUpdate(
        `Pack '${table.title || table.name}'`,
        table,
        addTypographySpans(matched.html),
        dryRun,
        updateFields,
        log
      );
      continue;
    }

    changeCount += 1;
    log.warn(`Pack '${table.title || table.name}' will be deleted; no KVF block matches it.`);
    if (!dryRun) {
      tableReferences = tableReferences.filter((id) => !sameId(id, table.item.itemId));
      container = await updateFields(container, {
        [fieldName(container, IDS.containerTables)]: tableReferences.join("|")
      });
      await sitecore.items.delete({ itemId: table.item.itemId });
      invalidateItem(cache, table.item.itemId);
      log.info(`Deleted ${table.item.path}.`);
    }
  }

  const childLevel = await sitecore.items.getChildren({ itemId: container.itemId, language });
  for (const block of packBlocks) {
    if (matchedPackNames.has(block.name.toLowerCase())) {
      continue;
    }
    changeCount += 1;
    const expectedName = `Table - ${block.name}`;
    const existingChild = childLevel.children.find((child) =>
      child.name.localeCompare(expectedName, undefined, { sensitivity: "base" }) === 0
    );
    log.warn(
      existingChild
        ? `Pack '${block.name}' requires a '${language}' version on existing item ${existingChild.itemId}.`
        : `Pack '${block.name}' table will be created.`
    );
    if (dryRun) {
      continue;
    }
    if (existingChild) {
      let existing;
      try {
        existing = await get({ itemId: existingChild.itemId });
      } catch {
        throw new Error(
          `Existing pack table '${expectedName}' has no readable '${language}' version. ` +
          "The Authoring task API cannot add an item version in 0.9.3."
        );
      }
      await updateFields(existing, packFields(existing, block));
      if (!tableReferences.some((id) => sameId(id, existing.itemId))) {
        tableReferences.push(existing.itemId);
        container = await updateFields(container, {
          [fieldName(container, IDS.containerTables)]: tableReferences.join("|")
        });
      }
      continue;
    }

    const created = await sitecore.items.create({
      name: expectedName,
      templateId: IDS.tableTemplate,
      parent: container.itemId,
      language,
      fields: {
        tableTitle: packTitle(block.name),
        tableBody: addTypographySpans(block.html),
        accordion: "1"
      }
    });
    tableReferences.push(created.itemId);
    container = await updateFields(container, {
      [fieldName(container, IDS.containerTables)]: tableReferences.join("|")
    });
    log.info(`Created ${created.path}.`);
  }

  log.info("");
  if (changeCount === 0) {
    log.info("No changes detected - nothing to publish.");
    return { status: "ok", message: `No changes are required for ${selectedButton.name}.` };
  }
  log.warn(
    dryRun
      ? `PUBLISH REQUIRED: ${changeCount} change(s) detected; this was an inspection only.`
      : `PUBLISH REQUIRED: ${changeCount} change(s) applied for ${selectedButton.path}.`
  );
  return {
    status: "ok",
    message: dryRun
      ? `Inspection found ${changeCount} change(s) for ${selectedButton.name}.`
      : `Applied ${changeCount} change(s) for ${selectedButton.name}; publishing is required.`
  };
};

async function compareAndMaybeUpdate(label, table, expectedBody, dryRun, updateFields, log) {
  log.info(`${label}: current '${preview(table.body)}'`);
  log.info(`${label}: new     '${preview(expectedBody)}'`);
  if (table.body === expectedBody) {
    log.info(`${label}: up to date.`);
    return 0;
  }
  log.warn(`${label}: content will be updated.`);
  if (!dryRun) {
    table.item = await updateFields(table.item, {
      [fieldName(table.item, IDS.tableBody)]: expectedBody
    });
    table.body = expectedBody;
    log.info(`${label}: updated.`);
  }
  return 1;
}

function packFields(item, block) {
  return {
    [fieldName(item, IDS.tableTitle)]: packTitle(block.name),
    [fieldName(item, IDS.tableBody)]: addTypographySpans(block.html),
    [fieldName(item, IDS.tableAccordion)]: "1"
  };
}

function packTitle(name) {
  return `<p style="font-size:18px;"><strong>${name}</strong></p>`;
}

function field(item, idOrName) {
  const normalized = normalizeId(idOrName);
  const name = String(idOrName).toLowerCase();
  return item.fields.find((candidate) =>
    normalizeId(candidate.fieldId) === normalized || candidate.name.toLowerCase() === name
  );
}

function fieldValue(item, idOrName) {
  return field(item, idOrName)?.value ?? "";
}

function fieldName(item, idOrName) {
  const match = field(item, idOrName);
  if (!match) {
    throw new Error(`Field '${idOrName}' was not found on ${item.path}.`);
  }
  return match.name;
}

function references(value) {
  return String(value || "").split(/[|\r\n]+/gu).map((entry) => entry.trim()).filter(Boolean);
}

function renderingDataSources(layout, renderingId) {
  const results = [];
  for (const tag of String(layout || "").match(/<r\b[^>]*>/giu) ?? []) {
    const id = attribute(tag, "id");
    if (id && sameId(id, renderingId)) {
      results.push(attribute(tag, "ds") || "");
    }
  }
  return results;
}

function attribute(tag, localName) {
  const expression = new RegExp(
    `(?:[A-Za-z_][\\w.-]*:)?${localName}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
    "iu"
  );
  const match = expression.exec(tag);
  return decodeHtml(match?.[1] ?? match?.[2] ?? "");
}

function parseUlBlocks(html) {
  const roots = [];
  const nested = [];
  const stack = [];
  const tags = /<\/?ul\b[^>]*>/giu;
  let match;
  while ((match = tags.exec(html)) !== null) {
    if (!match[0].startsWith("</")) {
      stack.push({ start: match.index, depth: stack.length });
      continue;
    }
    const opened = stack.pop();
    if (!opened) {
      continue;
    }
    const block = {
      start: opened.start,
      end: tags.lastIndex,
      html: html.slice(opened.start, tags.lastIndex)
    };
    if (opened.depth === 0) {
      roots.push(block);
    } else {
      nested.push(block);
    }
  }
  roots.sort((left, right) => left.start - right.start);
  nested.sort((left, right) => left.start - right.start);
  return { roots, nested };
}

function packNameBefore(html, ulStart) {
  const before = html.slice(0, ulStart);
  const liStart = before.toLowerCase().lastIndexOf("<li");
  const segment = liStart >= 0 ? before.slice(liStart) : before.slice(Math.max(0, before.length - 500));
  return decodeHtml(stripTags(segment)).replace(/\s+/gu, " ").trim();
}

function addTypographySpans(html) {
  return String(html || "")
    .replace(/<li>/giu, '<li><span class="t-lg">')
    .replace(/<\/li>/giu, "</span></li>")
    .replace(/<p>/giu, '<p><span class="t-lg">')
    .replace(/<\/p>/giu, "</span></p>");
}

function stripTags(value) {
  return decodeHtml(String(value || "").replace(/<[^>]+>/gu, ""));
}

function decodeHtml(value) {
  const named = {
    amp: "&",
    quot: '"',
    apos: "'",
    lt: "<",
    gt: ">",
    nbsp: " ",
    bdquo: "„",
    ldquo: "“",
    rdquo: "”",
    laquo: "«",
    raquo: "»"
  };
  return String(value || "").replace(/&(#x[\da-f]+|#\d+|[a-z]+);/giu, (entity, key) => {
    const lower = String(key).toLowerCase();
    if (lower.startsWith("#x")) {
      return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    }
    if (lower.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
    }
    return named[lower] ?? entity;
  });
}

function sameWordSet(left, right) {
  const normalize = (value) => decodeHtml(value)
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/gu)
    .filter((word) => word.length > 1)
    .sort()
    .join(" ");
  const first = normalize(left);
  return Boolean(first) && first === normalize(right);
}

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values.filter(Boolean)) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }
  return [...duplicates];
}

function preview(value, maximum = 500) {
  const compact = String(value || "").replace(/[\r\n\t]+/gu, " ").replace(/\s{2,}/gu, " ").trim();
  if (compact.length <= maximum) {
    return compact || "(empty)";
  }
  const half = Math.floor(maximum / 2);
  return `${compact.slice(0, half)} ... ${compact.slice(-half)}`;
}

function assertCount(values, expected, label) {
  if (values.length !== expected) {
    throw new Error(`Expected exactly ${expected} ${label}, found ${values.length}.`);
  }
}

function normalizeId(value) {
  return String(value || "").replace(/[{}-]/gu, "").toLowerCase();
}

function sameId(left, right) {
  return normalizeId(left) === normalizeId(right);
}

function invalidateItem(cache, itemId) {
  const normalized = normalizeId(itemId);
  for (const key of cache.keys()) {
    if (normalizeId(key).includes(normalized)) {
      cache.delete(key);
    }
  }
}
