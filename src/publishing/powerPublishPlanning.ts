import type { PublishBatch, ReferenceEdge } from "./publishingTypes";

export function powerPublishBatches(
  selectedItemIds: readonly string[],
  rootItemId: string,
  edges: readonly ReferenceEdge[],
  maximumBatchItems: number,
): readonly PublishBatch[] {
  assertMaximumBatchItems(maximumBatchItems);
  const rootKey = normalizeId(rootItemId);
  const itemByKey = new Map(
    selectedItemIds.map((itemId) => [normalizeId(itemId), itemId]),
  );
  itemByKey.delete(rootKey);
  const components = stronglyConnectedComponents([...itemByKey.keys()], edges);
  const componentByItem = new Map<string, number>();
  components.forEach((component, index) => {
    component.forEach((itemId) => componentByItem.set(itemId, index));
  });
  const dependencies = components.map(() => new Set<number>());
  for (const edge of edges) {
    const source = componentByItem.get(normalizeId(edge.sourceItemId));
    const target = componentByItem.get(normalizeId(edge.targetItemId));
    if (source !== undefined && target !== undefined && source !== target) {
      dependencies[source].add(target);
    }
  }

  const remaining = new Set(components.map((_component, index) => index));
  const planned: Array<{ readonly layer: number; readonly itemIds: readonly string[] }> = [];
  let layer = 1;
  while (remaining.size) {
    const ready = [...remaining].filter((component) =>
      [...dependencies[component]].every((dependency) => !remaining.has(dependency))
    );
    if (!ready.length) {
      throw new Error("Unable to construct an acyclic Power Publish component plan.");
    }
    let chunk: string[] = [];
    const flush = (): void => {
      if (chunk.length) {
        planned.push({ layer, itemIds: chunk });
        chunk = [];
      }
    };
    for (const component of ready) {
      const componentItems = components[component]
        .map((itemId) => itemByKey.get(itemId))
        .filter((itemId): itemId is string => Boolean(itemId));
      if (componentItems.length > maximumBatchItems) {
        flush();
        planned.push({ layer, itemIds: componentItems });
      } else {
        if (chunk.length + componentItems.length > maximumBatchItems) {
          flush();
        }
        chunk.push(...componentItems);
      }
      remaining.delete(component);
    }
    flush();
    layer += 1;
  }
  const dependencyBatchCount = planned.length;
  const batches: readonly PublishBatch[] = [
    ...planned.map((batch, index) => ({
      itemIds: batch.itemIds,
      label: `Dependency layer ${batch.layer} · batch ${index + 1}/${dependencyBatchCount}`,
    })),
    {
      itemIds: [rootItemId],
      label: "Root batch",
    },
  ];
  validatePowerPublishBatches(batches, selectedItemIds, rootItemId, edges);
  return batches;
}

export function powerRepairBatches(
  originalBatches: readonly PublishBatch[],
  itemIds: readonly string[],
  maximumBatchItems: number,
): readonly PublishBatch[] {
  assertMaximumBatchItems(maximumBatchItems);
  const remaining = new Map(itemIds.map((itemId) => [normalizeId(itemId), itemId]));
  const batches: PublishBatch[] = [];
  for (const original of originalBatches) {
    const selected = original.itemIds.flatMap((itemId) => {
      const key = normalizeId(itemId);
      const selectedItem = remaining.get(key);
      if (selectedItem) {
        remaining.delete(key);
        return [selectedItem];
      }
      return [];
    });
    if (selected.length) {
      batches.push({
        itemIds: selected,
        label: `Repair · ${original.label}`,
      });
    }
  }
  const leftovers = [...remaining.values()];
  for (let index = 0; index < leftovers.length; index += maximumBatchItems) {
    batches.push({
      itemIds: leftovers.slice(index, index + maximumBatchItems),
      label: `Repair observed items · batch ${Math.floor(index / maximumBatchItems) + 1}`,
    });
  }
  return batches;
}

export function validatePowerPublishBatches(
  batches: readonly PublishBatch[],
  selectedItemIds: readonly string[],
  rootItemId: string,
  edges: readonly ReferenceEdge[],
): void {
  const rootKey = normalizeId(rootItemId);
  const selectedKeys = new Set([
    ...selectedItemIds.map(normalizeId),
    rootKey,
  ]);
  const batchByItem = new Map<string, number>();
  batches.forEach((batch, batchIndex) => {
    for (const itemId of batch.itemIds) {
      const key = normalizeId(itemId);
      if (!selectedKeys.has(key)) {
        throw new Error(`Power Publish planned unselected item ${itemId}.`);
      }
      if (batchByItem.has(key)) {
        throw new Error(`Power Publish planned item ${itemId} more than once.`);
      }
      batchByItem.set(key, batchIndex);
    }
  });
  for (const itemId of selectedItemIds) {
    if (!batchByItem.has(normalizeId(itemId))) {
      throw new Error(`Power Publish omitted selected item ${itemId}.`);
    }
  }
  const finalBatch = batches.at(-1);
  if (
    !finalBatch ||
    finalBatch.itemIds.length !== 1 ||
    normalizeId(finalBatch.itemIds[0]) !== rootKey
  ) {
    throw new Error("Power Publish did not isolate the selected root in its final batch.");
  }
  for (const edge of edges) {
    const sourceKey = normalizeId(edge.sourceItemId);
    const targetKey = normalizeId(edge.targetItemId);
    if (targetKey === rootKey) {
      continue;
    }
    const sourceBatch = batchByItem.get(sourceKey);
    const targetBatch = batchByItem.get(targetKey);
    if (
      sourceBatch !== undefined &&
      targetBatch !== undefined &&
      targetBatch > sourceBatch
    ) {
      throw new Error(
        `Power Publish ordered dependency ${edge.targetItemId} after ${edge.sourceItemId}.`,
      );
    }
  }
}

function stronglyConnectedComponents(
  itemIds: readonly string[],
  edges: readonly ReferenceEdge[],
): readonly (readonly string[])[] {
  const included = new Set(itemIds);
  const adjacency = new Map(itemIds.map((itemId) => [itemId, new Set<string>()]));
  for (const edge of edges) {
    const source = normalizeId(edge.sourceItemId);
    const target = normalizeId(edge.targetItemId);
    if (included.has(source) && included.has(target)) {
      adjacency.get(source)?.add(target);
    }
  }
  let nextIndex = 0;
  const indexes = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  const visit = (itemId: string): void => {
    indexes.set(itemId, nextIndex);
    lowLinks.set(itemId, nextIndex);
    nextIndex += 1;
    stack.push(itemId);
    onStack.add(itemId);
    for (const target of adjacency.get(itemId) ?? []) {
      if (!indexes.has(target)) {
        visit(target);
        lowLinks.set(itemId, Math.min(
          lowLinks.get(itemId) ?? 0,
          lowLinks.get(target) ?? 0,
        ));
      } else if (onStack.has(target)) {
        lowLinks.set(itemId, Math.min(
          lowLinks.get(itemId) ?? 0,
          indexes.get(target) ?? 0,
        ));
      }
    }
    if (lowLinks.get(itemId) !== indexes.get(itemId)) {
      return;
    }
    const component: string[] = [];
    let current: string | undefined;
    do {
      current = stack.pop();
      if (current) {
        onStack.delete(current);
        component.push(current);
      }
    } while (current && current !== itemId);
    components.push(component);
  };
  for (const itemId of itemIds) {
    if (!indexes.has(itemId)) {
      visit(itemId);
    }
  }
  return components;
}

function assertMaximumBatchItems(value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("Power Publish maximum batch size must be a positive integer.");
  }
}

function normalizeId(value: string): string {
  return value.replace(/[{}-]/gu, "").toLowerCase();
}
