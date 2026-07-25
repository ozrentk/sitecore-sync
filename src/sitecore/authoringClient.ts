import type { XmCloudConnection } from "../connections/connection";
import { randomUUID } from "node:crypto";
import { print } from "graphql";
import {
  createItemMutation,
  deleteItemMutation,
  itemDetailsQuery,
  languagesQuery,
  nonStandardFieldIdsQuery,
  testConnectionQuery,
  treeLevelQuery,
  updateItemMutation,
} from "./graphql/authoringQueries";
import { SitecoreHttpClient, type SitecoreHttpLogger } from "./sitecoreHttpClient";

const tokenEndpoint = "https://auth.sitecorecloud.io/oauth/token";
const audience = "https://api.sitecorecloud.io";
const requestTimeoutMilliseconds = 30_000;

interface TokenResponse {
  readonly access_token?: unknown;
  readonly expires_in?: unknown;
}

interface AccessToken {
  readonly value: string;
  readonly expiresInSeconds: number;
}

interface GraphQlError {
  readonly message?: unknown;
}

export interface ContentTransferResult {
  readonly state: "Finished" | "Pending";
  readonly transferId: string;
  readonly sourceItemId: string;
  readonly sourceChildIds: readonly string[];
  readonly chunkSets: readonly {
    readonly chunkSetId: string;
    readonly chunkCount: number;
    readonly contentTransferFileName: string;
  }[];
  readonly itemTransferIds: readonly string[];
  readonly destinationItemId?: string;
  readonly destinationChildIds?: readonly string[];
  readonly destinationVersions?: readonly { readonly language: string; readonly version: number }[];
}

export type ContentTransferProgress =
  | { readonly stage: "exportingContent" }
  | { readonly stage: "copyingChunks"; readonly current: number; readonly total: number }
  | { readonly stage: "sitecore"; readonly completed: number; readonly total: number }
  | { readonly stage: "verifying" };

export type ContentTransferMergeStrategy =
  | "KeepExistingItem"
  | "OverrideExistingItem"
  | "OverrideExistingTree";

interface TestQueryResponse {
  readonly data?: {
    readonly sites?: readonly {
      readonly name?: unknown;
      readonly rootPath?: unknown;
      readonly rootItem?: { readonly itemId?: unknown } | null;
    }[];
  };
  readonly errors?: readonly GraphQlError[];
}

export interface AuthoringSite {
  readonly name: string;
  readonly rootPath: string;
  readonly rootItemId?: string;
}

export interface ConnectionTestResult {
  readonly sites: readonly AuthoringSite[];
  readonly duplicateSiteCount: number;
  readonly elapsedMilliseconds: number;
}

interface SiteQueryResult {
  readonly sites: readonly AuthoringSite[];
  readonly duplicateSiteCount: number;
}

interface RawAuthoringTreeItem {
  readonly itemId?: unknown;
  readonly name?: unknown;
  readonly displayName?: unknown;
  readonly path?: unknown;
  readonly hasChildren?: unknown;
}

interface TreeLevelQueryResponse {
  readonly data?: {
    readonly item?: (RawAuthoringTreeItem & {
      readonly children?: {
        readonly nodes?: readonly RawAuthoringTreeItem[];
        readonly pageInfo?: {
          readonly hasNextPage?: unknown;
          readonly endCursor?: unknown;
        };
      };
    }) | null;
  };
  readonly errors?: readonly GraphQlError[];
}

interface RawPageInfo {
  readonly hasNextPage?: unknown;
  readonly endCursor?: unknown;
}

interface RawLanguage {
  readonly name?: unknown;
  readonly displayName?: unknown;
  readonly englishName?: unknown;
  readonly nativeName?: unknown;
}

interface LanguagesQueryResponse {
  readonly data?: {
    readonly languages?: {
      readonly nodes?: readonly RawLanguage[];
      readonly pageInfo?: RawPageInfo;
    };
  };
  readonly errors?: readonly GraphQlError[];
}

interface RawItemField {
  readonly fieldId?: unknown;
  readonly name?: unknown;
  readonly label?: unknown;
  readonly value?: unknown;
  readonly containsFallbackValue?: unknown;
  readonly containsInheritedValue?: unknown;
  readonly containsStandardValue?: unknown;
  readonly templateField?: {
    readonly type?: unknown;
    readonly typeKey?: unknown;
    readonly versioning?: unknown;
    readonly sortOrder?: unknown;
    readonly section?: {
      readonly name?: unknown;
      readonly sortOrder?: unknown;
    };
  };
}

interface RawItemDetails {
  readonly itemId?: unknown;
  readonly name?: unknown;
  readonly displayName?: unknown;
  readonly path?: unknown;
  readonly hasChildren?: unknown;
  readonly version?: unknown;
  readonly language?: { readonly name?: unknown };
  readonly template?: { readonly templateId?: unknown; readonly name?: unknown };
  readonly versions?: readonly {
    readonly language?: { readonly name?: unknown };
    readonly version?: unknown;
  }[];
  readonly fields?: {
    readonly nodes?: readonly RawItemField[];
    readonly pageInfo?: RawPageInfo;
  };
}

interface ItemDetailsQueryResponse {
  readonly data?: { readonly item?: RawItemDetails | null };
  readonly errors?: readonly GraphQlError[];
}

interface NonStandardFieldIdsQueryResponse {
  readonly data?: {
    readonly item?: {
      readonly fields?: {
        readonly nodes?: readonly { readonly fieldId?: unknown }[];
        readonly pageInfo?: RawPageInfo;
      };
    } | null;
  };
  readonly errors?: readonly GraphQlError[];
}

interface ItemMutationResponse {
  readonly data?: {
    readonly createItem?: { readonly item?: RawMutatedItem | null } | null;
    readonly updateItem?: { readonly item?: RawMutatedItem | null } | null;
  };
  readonly errors?: readonly GraphQlError[];
}

interface RawMutatedItem {
  readonly itemId?: unknown;
  readonly path?: unknown;
  readonly version?: unknown;
  readonly language?: { readonly name?: unknown };
}

interface DeleteItemMutationResponse {
  readonly data?: {
    readonly deleteItem?: { readonly successful?: unknown } | null;
  };
  readonly errors?: readonly GraphQlError[];
}

export interface AuthoringTreeItem {
  readonly itemId: string;
  readonly name: string;
  readonly displayName: string;
  readonly path: string;
  readonly hasChildren: boolean;
}

export interface AuthoringTreeLevel {
  readonly item: AuthoringTreeItem;
  readonly children: readonly AuthoringTreeItem[];
}

export type AuthoringItemLocator =
  | { readonly path: string }
  | { readonly itemId: string };

export interface CreateAuthoringItemInput {
  readonly name: string;
  readonly templateId: string;
  readonly parent: string;
  readonly language: string;
  readonly fields?: Readonly<Record<string, string>>;
}

export interface UpdateAuthoringItemInput {
  readonly itemId: string;
  readonly language: string;
  readonly version: number;
  readonly fields: Readonly<Record<string, string>>;
}

export type DeleteAuthoringItemInput = AuthoringItemLocator & {
  readonly permanently?: boolean;
};

interface CachedToken {
  readonly value: string;
  readonly expiresAt: number;
}

export class AuthoringContentClient {
  private readonly tokens = new Map<string, CachedToken>();
  private readonly http: SitecoreHttpClient;

  constructor(log: SitecoreHttpLogger) {
    this.http = new SitecoreHttpClient(log);
  }

  async transferSubtree(
    source: XmCloudConnection,
    sourceSecret: string,
    destination: XmCloudConnection,
    destinationSecret: string,
    itemPath: string,
    expectedSourceItemId: string,
    sourceLanguage: string,
    destinationLanguage: string,
    mergeStrategy: ContentTransferMergeStrategy,
    signal: AbortSignal,
    onCheckpoint?: (checkpoint: ContentTransferResult) => Promise<void>,
    onProgress?: (progress: ContentTransferProgress) => Promise<void>,
    onPoll?: () => Promise<void>,
  ): Promise<ContentTransferResult> {
    const sourceToken = await this.getAccessToken(source, sourceSecret, signal);
    const destinationToken = await this.getAccessToken(destination, destinationSecret, signal);
    const sourceItem = await this.loadTreeLevel(
      source,
      sourceSecret,
      { path: itemPath },
      sourceLanguage,
      signal,
    );
    if (normalizeGuid(sourceItem.item.itemId) !== normalizeGuid(expectedSourceItemId)) {
      throw new Error(
        `Source freshness validation failed: ${itemPath} now resolves to item ${sourceItem.item.itemId}.`,
      );
    }

    const destinationParentPath = itemPath.slice(0, itemPath.lastIndexOf("/"));
    const destinationParent = await this.loadTreeLevel(
      destination,
      destinationSecret,
      { path: destinationParentPath },
      destinationLanguage,
      signal,
    );
    const existingDestination = destinationParent.children.find(
      (item) => item.path.localeCompare(itemPath, undefined, { sensitivity: "base" }) === 0,
    );
    if (
      existingDestination &&
      mergeStrategy !== "OverrideExistingTree" &&
      normalizeGuid(existingDestination.itemId) !== normalizeGuid(sourceItem.item.itemId)
    ) {
      throw new Error(
        `The destination path already exists with a different item ID (${existingDestination.itemId}).`,
      );
    }

    await onProgress?.({ stage: "exportingContent" });

    const transferId = randomUUID();
    const sourceTransferBase = new URL("/sitecore/api/content/transfer/v1/transfers", source.serverUrl);
    const destinationTransferBase = new URL(
      "/sitecore/api/content/transfer/v1/transfers",
      destination.serverUrl,
    );
    const itemTransferBase = new URL(
      "/sitecore/shell/api/v3/ItemsTransfer/",
      destination.serverUrl,
    );
    const completedChunkSets: Array<{
      chunkSetId: string;
      chunkCount: number;
      contentTransferFileName: string;
    }> = [];
    const itemTransferIds: string[] = [];
    const destinationBlobNames: string[] = [];

    await this.requestWithoutBody(
      sourceTransferBase,
      sourceToken,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          TransferId: transferId,
          Configuration: {
            DataTrees: [{
              ItemPath: itemPath,
              Scope: "ItemAndDescendants",
              MergeStrategy: mergeStrategy,
            }],
            Database: "master",
          },
        }),
      },
      "create content transfer",
      signal,
      false,
    );

    try {
      const status = await this.pollJson(
        new URL(`${sourceTransferBase.pathname}/${transferId}/status`, source.serverUrl),
        sourceToken,
        "poll content transfer",
        (payload) => {
          const state = stringProperty(payload, "State", "state");
          if (state === "Failed") {
            throw new Error("The source content transfer entered the Failed state.");
          }
          return state === "Completed";
        },
        signal,
        300,
        onPoll,
      );
      const chunkSets = arrayProperty(status, "ChunkSetsMetadata", "chunkSetsMetadata");
      if (chunkSets.length === 0) {
        throw new Error("The completed content transfer did not contain chunk-set metadata.");
      }

      const totalChunkCount = chunkSets.reduce<number>(
        (total, rawChunkSet) => total + requiredNumberProperty(
          rawChunkSet,
          "ChunkCount",
          "chunkCount",
        ),
        0,
      );
      let copiedChunkCount = 0;
      await onProgress?.({
        stage: "copyingChunks",
        current: copiedChunkCount,
        total: totalChunkCount,
      });

      for (const rawChunkSet of chunkSets) {
        const chunkSetId = requiredStringProperty(rawChunkSet, "ChunkSetId", "chunkSetId");
        const chunkCount = requiredNumberProperty(rawChunkSet, "ChunkCount", "chunkCount");
        for (let chunkId = 0; chunkId < chunkCount; chunkId += 1) {
          const sourceChunkUrl = new URL(
            `${sourceTransferBase.pathname}/${transferId}/chunksets/${chunkSetId}/chunks/${chunkId}`,
            source.serverUrl,
          );
          const chunkResponse = await this.http.request(
            sourceChunkUrl,
            { method: "GET", headers: { authorization: `Bearer ${sourceToken}` } },
            { name: "retrieve content-transfer chunk", signal, retryable: true },
          );
          await assertSuccessfulResponse(chunkResponse, "Retrieve content-transfer chunk");
          const disposition = chunkResponse.headers.get("content-disposition") ?? "";
          const mediaMatch = /(?:^|;)\s*IsMedia\s*=\s*"?(true|false)"?/iu.exec(disposition);
          if (!mediaMatch) {
            throw new Error("A content-transfer chunk did not specify IsMedia.");
          }
          const chunk = await chunkResponse.arrayBuffer();
          const destinationChunkUrl = new URL(
            `${destinationTransferBase.pathname}/${transferId}/chunksets/${chunkSetId}/chunks/${chunkId}`,
            destination.serverUrl,
          );
          destinationChunkUrl.searchParams.set("isMedia", mediaMatch[1].toLowerCase());
          await this.requestWithoutBody(
            destinationChunkUrl,
            destinationToken,
            {
              method: "PUT",
              headers: { "content-type": "application/octet-stream" },
              body: chunk,
            },
            "save content-transfer chunk",
            signal,
            true,
          );
          copiedChunkCount += 1;
          await onProgress?.({
            stage: "copyingChunks",
            current: copiedChunkCount,
            total: totalChunkCount,
          });
        }

        const completion = await this.requestJsonObject(
          new URL(
            `${destinationTransferBase.pathname}/${transferId}/chunksets/${chunkSetId}/complete`,
            destination.serverUrl,
          ),
          destinationToken,
          { method: "POST" },
          "complete content-transfer chunk set",
          signal,
          false,
        );
        const blobName = requiredStringProperty(
          completion,
          "ContentTransferFileName",
          "contentTransferFileName",
        );
        destinationBlobNames.push(blobName);
        completedChunkSets.push({
          chunkSetId,
          chunkCount,
          contentTransferFileName: blobName,
        });
      }
    } finally {
      await this.requestWithoutBody(
        new URL(`${sourceTransferBase.pathname}/${transferId}`, source.serverUrl),
        sourceToken,
        { method: "DELETE" },
        "delete source content transfer",
        signal,
        false,
      );
    }

    let checkpoint: ContentTransferResult = {
      state: "Pending",
      transferId,
      sourceItemId: normalizeGuid(sourceItem.item.itemId),
      sourceChildIds: sourceItem.children.map((child) => normalizeGuid(child.itemId)),
      chunkSets: completedChunkSets,
      itemTransferIds,
    };
    await onCheckpoint?.(checkpoint);

    const sitecorePhaseStartedAt = Date.now();
    for (const [blobIndex, blobName] of destinationBlobNames.entries()) {
      await onProgress?.({
        stage: "sitecore",
        completed: blobIndex,
        total: destinationBlobNames.length,
      });
      const blobListUrl = new URL("sources/blobs", itemTransferBase);
      await this.pollJson(
        blobListUrl,
        destinationToken,
        "poll item-transfer blob",
        (payload) => {
          const serialized = JSON.stringify(payload);
          return serialized.includes(blobName) && /Uploaded/iu.test(serialized);
        },
        signal,
        150,
        onPoll,
      );

      const startUrl = new URL("transfers/databases/master/sources", itemTransferBase);
      startUrl.searchParams.set("blobName", blobName);
      const startResponse = await this.http.request(
        startUrl,
        { method: "POST", headers: { authorization: `Bearer ${destinationToken}` } },
        { name: "start item transfer", signal, retryable: false },
      );
      await assertSuccessfulResponse(startResponse, "Start item transfer");
      const location = startResponse.headers.get("location");
      if (!location) {
        throw new Error("The Item Transfer API did not return a location header.");
      }
      const itemTransferId = location.split("/").filter(Boolean).at(-1);
      if (!itemTransferId) {
        throw new Error("The Item Transfer API returned an invalid location header.");
      }
      const decodedItemTransferId = decodeURIComponent(itemTransferId);
      if (decodedItemTransferId !== blobName) {
        throw new Error(
          `The Item Transfer API location identified ${decodedItemTransferId}, expected ${blobName}.`,
        );
      }
      itemTransferIds.push(decodedItemTransferId);
      checkpoint = { ...checkpoint, itemTransferIds: [...itemTransferIds] };
      await onCheckpoint?.(checkpoint);
      const itemTransferStatus = await this.pollItemTransfer(
        new URL(`transfers/${encodeURIComponent(decodedItemTransferId)}`, itemTransferBase),
        destinationToken,
        decodedItemTransferId,
        signal,
        sitecorePhaseStartedAt,
        onPoll,
      );
      if (!itemTransferStatus) {
        return checkpoint;
      }
      await onProgress?.({
        stage: "sitecore",
        completed: blobIndex + 1,
        total: destinationBlobNames.length,
      });
    }

    await onProgress?.({ stage: "verifying" });
    const destinationItem = await this.loadTreeLevel(
      destination,
      destinationSecret,
      { itemId: sourceItem.item.itemId },
      destinationLanguage,
      signal,
    );
    const sourceChildIds = sourceItem.children.map((child) => normalizeGuid(child.itemId));
    const destinationChildIds = destinationItem.children.map((child) => normalizeGuid(child.itemId));
    for (const childId of sourceChildIds) {
      if (!destinationChildIds.includes(childId)) {
        throw new Error(`Destination verification did not find transferred child ${childId}.`);
      }
    }
    if (
      mergeStrategy === "OverrideExistingTree" &&
      destinationChildIds.some((childId) => !sourceChildIds.includes(childId))
    ) {
      throw new Error(
        "Destination verification found a target-only direct child after the exact-mirror transfer.",
      );
    }

    // Destination .raif blobs are intentionally retained. Sitecore exposes imported items
    // before its background database synchronization is complete, and deleting a blob too
    // early leaves descendant field data pointing at missing Azure storage. Automated cleanup
    // can be reintroduced only when the API exposes a reliably observable Finished state.
    return {
      state: "Finished",
      transferId,
      sourceItemId: normalizeGuid(sourceItem.item.itemId),
      sourceChildIds,
      chunkSets: completedChunkSets,
      itemTransferIds,
      destinationItemId: normalizeGuid(destinationItem.item.itemId),
      destinationChildIds,
    };
  }

  async resumeSubtreeTransfer(
    destination: XmCloudConnection,
    destinationSecret: string,
    destinationLanguage: string,
    checkpoint: ContentTransferResult,
    signal: AbortSignal,
    sitecorePhaseStartedAt: number,
    onCheckpoint?: (checkpoint: ContentTransferResult) => Promise<void>,
    onProgress?: (progress: ContentTransferProgress) => Promise<void>,
    onPoll?: () => Promise<void>,
  ): Promise<ContentTransferResult> {
    const destinationToken = await this.getAccessToken(destination, destinationSecret, signal);
    const itemTransferBase = new URL(
      "/sitecore/shell/api/v3/ItemsTransfer/",
      destination.serverUrl,
    );
    const itemTransferIds = [...checkpoint.itemTransferIds];
    let currentCheckpoint = checkpoint;
    for (const chunkSet of checkpoint.chunkSets) {
      const blobName = chunkSet.contentTransferFileName;
      if (itemTransferIds.includes(blobName)) {
        continue;
      }
      const blobListUrl = new URL("sources/blobs", itemTransferBase);
      await this.pollJson(
        blobListUrl,
        destinationToken,
        "poll item-transfer blob",
        (payload) => {
          const serialized = JSON.stringify(payload);
          return serialized.includes(blobName) && /Uploaded/iu.test(serialized);
        },
        signal,
        150,
        onPoll,
      );
      const startUrl = new URL("transfers/databases/master/sources", itemTransferBase);
      startUrl.searchParams.set("blobName", blobName);
      const startResponse = await this.http.request(
        startUrl,
        { method: "POST", headers: { authorization: `Bearer ${destinationToken}` } },
        { name: "resume item transfer", signal, retryable: false },
      );
      await assertSuccessfulResponse(startResponse, "Resume item transfer");
      const location = startResponse.headers.get("location");
      const itemTransferId = location?.split("/").filter(Boolean).at(-1);
      if (!itemTransferId || decodeURIComponent(itemTransferId) !== blobName) {
        throw new Error("The resumed Item Transfer API returned an invalid location header.");
      }
      itemTransferIds.push(blobName);
      currentCheckpoint = { ...currentCheckpoint, itemTransferIds: [...itemTransferIds] };
      await onCheckpoint?.(currentCheckpoint);
    }

    for (const [itemTransferIndex, itemTransferId] of itemTransferIds.entries()) {
      await onProgress?.({
        stage: "sitecore",
        completed: itemTransferIndex,
        total: checkpoint.chunkSets.length,
      });
      const status = await this.pollItemTransfer(
        new URL(`transfers/${encodeURIComponent(itemTransferId)}`, itemTransferBase),
        destinationToken,
        itemTransferId,
        signal,
        sitecorePhaseStartedAt,
        onPoll,
      );
      if (!status) {
        return { ...currentCheckpoint, state: "Pending" };
      }
      await onProgress?.({
        stage: "sitecore",
        completed: itemTransferIndex + 1,
        total: checkpoint.chunkSets.length,
      });
    }

    await onProgress?.({ stage: "verifying" });
    const destinationItem = await this.loadTreeLevel(
      destination,
      destinationSecret,
      { itemId: currentCheckpoint.sourceItemId },
      destinationLanguage,
      signal,
    );
    const destinationChildIds = destinationItem.children.map((child) =>
      normalizeGuid(child.itemId)
    );
    for (const childId of currentCheckpoint.sourceChildIds) {
      if (!destinationChildIds.includes(childId)) {
        throw new Error(`Destination verification did not find transferred child ${childId}.`);
      }
    }
    return {
      ...currentCheckpoint,
      state: "Finished",
      destinationItemId: normalizeGuid(destinationItem.item.itemId),
      destinationChildIds,
    };
  }

  private async requestWithoutBody(
    url: URL,
    token: string,
    init: RequestInit,
    name: string,
    signal: AbortSignal,
    retryable: boolean,
  ): Promise<void> {
    const response = await this.http.request(
      url,
      { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } },
      { name, signal, retryable },
    );
    await assertSuccessfulResponse(response, name);
  }

  private async requestJsonObject(
    url: URL,
    token: string,
    init: RequestInit,
    name: string,
    signal: AbortSignal,
    retryable: boolean,
  ): Promise<unknown> {
    const response = await this.http.request(
      url,
      { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } },
      { name, signal, retryable },
    );
    await assertSuccessfulResponse(response, name);
    return readJson<unknown>(response, name);
  }

  private async pollJson(
    url: URL,
    token: string,
    name: string,
    complete: (payload: unknown) => boolean,
    signal: AbortSignal,
    maxAttempts = 60,
    onPoll?: () => Promise<void>,
  ): Promise<unknown> {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await onPoll?.();
      const payload = await this.requestJsonObject(
        url,
        token,
        { method: "GET" },
        name,
        signal,
        true,
      );
      if (complete(payload)) {
        return payload;
      }
      await abortableDelay(2_000, signal);
    }
    throw new Error(`${name} did not complete within ${maxAttempts * 2} seconds.`);
  }

  private async pollItemTransfer(
    url: URL,
    token: string,
    transferId: string,
    signal: AbortSignal,
    sitecorePhaseStartedAt: number,
    onPoll?: () => Promise<void>,
  ): Promise<unknown | undefined> {
    const pollingWindowEndsAt = Date.now() + 120_000;
    while (Date.now() < pollingWindowEndsAt) {
      await onPoll?.();
      const response = await this.http.request(
        url,
        { method: "GET", headers: { authorization: `Bearer ${token}` } },
        { name: "poll item transfer", signal, retryable: true },
      );
      if (response.status === 404) {
        const listUrl = new URL(".", url);
        listUrl.searchParams.set("page", "1");
        listUrl.searchParams.set("pageSize", "50");
        const list = await this.requestJsonObject(
          listUrl,
          token,
          { method: "GET" },
          "list item transfers while polling",
          signal,
          true,
        );
        const matchingTransfer = arrayProperty(list, "Transfers", "transfers").find((entry) =>
          ["Id", "id", "SourceName", "sourceName"].some(
            (name) => stringProperty(entry, name) === transferId,
          ));
        if (matchingTransfer) {
          const listedState = stringProperty(
            matchingTransfer,
            "TransferState",
            "transferState",
          );
          if (listedState === "Failed" || listedState === "Discarded") {
            throw new Error(`Item transfer ${transferId} entered the ${listedState} state.`);
          }
          const blobState = stringProperty(matchingTransfer, "BlobState", "blobState");
          if (blobState === "TransferredWithErrors") {
            throw new Error(
              `Item transfer ${transferId} completed with validation errors.`,
            );
          }
          if (listedState === "Finished") {
            return matchingTransfer;
          }
        }
      } else {
        await assertSuccessfulResponse(response, "Poll item transfer");
        const payload = await readJson<unknown>(response, "Item Transfer API");
        const state = stringProperty(payload, "TransferState", "transferState");
        if (state === "Failed" || state === "Discarded") {
          throw new Error(`Item transfer ${transferId} entered the ${state} state.`);
        }
        const blobState = stringProperty(payload, "BlobState", "blobState");
        if (blobState === "TransferredWithErrors") {
          throw new Error(`Item transfer ${transferId} completed with validation errors.`);
        }
        if (state === "Finished") {
          return payload;
        }
      }
      const remainingWindow = pollingWindowEndsAt - Date.now();
      if (remainingWindow <= 0) {
        break;
      }
      const elapsed = Math.max(0, Date.now() - sitecorePhaseStartedAt);
      await abortableDelay(
        Math.min(remainingWindow, jitteredItemTransferPollingDelay(elapsed)),
        signal,
      );
    }
    return undefined;
  }

  async loadTreeLevel(
    connection: XmCloudConnection,
    clientSecret: string,
    locator: AuthoringItemLocator,
    language: string,
    signal: AbortSignal,
  ): Promise<AuthoringTreeLevel> {
    const accessToken = await this.getAccessToken(connection, clientSecret, signal);
    const children: AuthoringTreeItem[] = [];
    const seenCursors = new Set<string>();
    let item: AuthoringTreeItem | undefined;
    let after: string | undefined;

    do {
      const page = await this.queryTreeLevelPage(
        connection.serverUrl,
        accessToken,
        locator,
        language,
        after,
        signal,
      );
      item ??= page.item;
      children.push(...page.children);
      after = page.nextCursor;
      if (after && seenCursors.has(after)) {
        throw new Error("Authoring API returned the same children-page cursor twice.");
      }
      if (after) {
        seenCursors.add(after);
      }
    } while (after !== undefined);

    return { item, children };
  }

  async loadLanguages(
    connection: XmCloudConnection,
    clientSecret: string,
    signal: AbortSignal,
  ): Promise<readonly AuthoringLanguage[]> {
    const accessToken = await this.getAccessToken(connection, clientSecret, signal);
    const languages = new Map<string, AuthoringLanguage>();
    const seenCursors = new Set<string>();
    let after: string | undefined;

    do {
      const payload = await this.postGraphQl<LanguagesQueryResponse>(
        connection.serverUrl,
        accessToken,
        "Sitecore Authoring languages query",
        "XmCloudSyncLanguages",
        print(languagesQuery),
        { databaseName: "master", pageSize: 100, after: after ?? null },
        signal,
      );
      const collection = payload.data?.languages;
      if (!collection) {
        throw new Error("Authoring API response did not contain the languages collection.");
      }
      for (const raw of collection.nodes ?? []) {
        if (typeof raw.name !== "string") {
          throw new Error("Authoring API returned an invalid language.");
        }
        languages.set(raw.name.toLowerCase(), {
          name: raw.name,
          displayName: typeof raw.displayName === "string" ? raw.displayName : raw.name,
          englishName: typeof raw.englishName === "string" ? raw.englishName : raw.name,
          nativeName: typeof raw.nativeName === "string" ? raw.nativeName : raw.name,
        });
      }
      after = nextCursor(collection.pageInfo, "languages");
      assertNewCursor(after, seenCursors, "languages");
    } while (after !== undefined);

    return [...languages.values()].sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
    );
  }

  async loadItemDetails(
    connection: XmCloudConnection,
    clientSecret: string,
    itemId: string,
    language: string,
    signal: AbortSignal,
  ): Promise<AuthoringItemDetails> {
    return this.loadItem(
      connection,
      clientSecret,
      { itemId },
      language,
      undefined,
      signal,
    );
  }

  async loadItem(
    connection: XmCloudConnection,
    clientSecret: string,
    locator: AuthoringItemLocator,
    language: string,
    version: number | undefined,
    signal: AbortSignal,
  ): Promise<AuthoringItemDetails> {
    const accessToken = await this.getAccessToken(connection, clientSecret, signal);
    const where = {
      database: "master",
      ...locator,
      language,
      ...(version === undefined ? {} : { version }),
    };
    const [rawDetails, nonStandardFieldIds] = await Promise.all([
      this.loadItemDetailsPages(connection.serverUrl, accessToken, where, signal),
      this.loadNonStandardFieldIds(connection.serverUrl, accessToken, where, signal),
    ]);
    return parseItemDetails(rawDetails, nonStandardFieldIds);
  }

  async updateFieldValue(
    connection: XmCloudConnection,
    clientSecret: string,
    itemId: string,
    language: string,
    version: number,
    fieldName: string,
    value: string,
    signal: AbortSignal,
  ): Promise<void> {
    await this.mutateItemFields(
      connection,
      clientSecret,
      { itemId, language, version, fields: { [fieldName]: value } },
      signal,
    );
  }

  async createItem(
    connection: XmCloudConnection,
    clientSecret: string,
    input: CreateAuthoringItemInput,
    signal: AbortSignal,
  ): Promise<AuthoringItemDetails> {
    const accessToken = await this.getAccessToken(connection, clientSecret, signal);
    const payload = await this.postGraphQl<ItemMutationResponse>(
      connection.serverUrl,
      accessToken,
      "create Authoring item",
      "XmCloudSyncCreateItem",
      print(createItemMutation),
      {
        input: {
          name: input.name,
          templateId: input.templateId,
          parent: input.parent,
          language: input.language,
          fields: createFieldEntries(input.fields),
        },
      },
      signal,
      false,
    );
    const createdItem = parseMutatedItem(payload.data?.createItem?.item, "created");
    return this.loadItemDetails(
      connection,
      clientSecret,
      createdItem.itemId,
      createdItem.language,
      signal,
    );
  }

  async updateItemFields(
    connection: XmCloudConnection,
    clientSecret: string,
    input: UpdateAuthoringItemInput,
    signal: AbortSignal,
  ): Promise<AuthoringItemDetails> {
    const updatedItem = await this.mutateItemFields(connection, clientSecret, input, signal);
    return this.loadItemDetails(
      connection,
      clientSecret,
      updatedItem.itemId,
      updatedItem.language,
      signal,
    );
  }

  private async mutateItemFields(
    connection: XmCloudConnection,
    clientSecret: string,
    input: UpdateAuthoringItemInput,
    signal: AbortSignal,
  ): Promise<{ readonly itemId: string; readonly language: string }> {
    const accessToken = await this.getAccessToken(connection, clientSecret, signal);
    const payload = await this.postGraphQl<ItemMutationResponse>(
      connection.serverUrl,
      accessToken,
      "update Authoring item",
      "XmCloudSyncUpdateItem",
      print(updateItemMutation),
      {
        input: {
          database: "master",
          itemId: input.itemId,
          language: input.language,
          version: input.version,
          fields: fieldEntries(input.fields),
        },
      },
      signal,
      false,
    );
    const updatedItem = parseMutatedItem(payload.data?.updateItem?.item, "updated");
    if (normalizeGuid(updatedItem.itemId) !== normalizeGuid(input.itemId)) {
      throw new Error("Authoring API did not confirm the updated item.");
    }
    return updatedItem;
  }

  async deleteItem(
    connection: XmCloudConnection,
    clientSecret: string,
    input: DeleteAuthoringItemInput,
    signal: AbortSignal,
  ): Promise<void> {
    const accessToken = await this.getAccessToken(connection, clientSecret, signal);
    const payload = await this.postGraphQl<DeleteItemMutationResponse>(
      connection.serverUrl,
      accessToken,
      "delete Authoring item",
      "XmCloudSyncDeleteItem",
      print(deleteItemMutation),
      {
        input: {
          ...input,
          permanently: input.permanently === true,
        },
      },
      signal,
      false,
    );
    if (payload.data?.deleteItem?.successful !== true) {
      throw new Error("Authoring API did not confirm that the item was deleted.");
    }
  }

  private async loadItemDetailsPages(
    serverUrl: string,
    accessToken: string,
    where: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<RawItemDetails> {
    const fields: RawItemField[] = [];
    const seenCursors = new Set<string>();
    let item: RawItemDetails | undefined;
    let after: string | undefined;
    do {
      const payload = await this.postGraphQl<ItemDetailsQueryResponse>(
        serverUrl,
        accessToken,
        "Sitecore Authoring item-details query",
        "XmCloudSyncItemDetails",
        print(itemDetailsQuery),
        { where, pageSize: 100, after: after ?? null },
        signal,
      );
      if (!payload.data?.item) {
        throw new Error("The requested Authoring item was not found.");
      }
      item ??= payload.data.item;
      fields.push(...(payload.data.item.fields?.nodes ?? []));
      after = nextCursor(payload.data.item.fields?.pageInfo, "item fields");
      assertNewCursor(after, seenCursors, "item fields");
    } while (after !== undefined);
    return { ...item, fields: { nodes: fields } };
  }

  private async loadNonStandardFieldIds(
    serverUrl: string,
    accessToken: string,
    where: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<ReadonlySet<string>> {
    const fieldIds = new Set<string>();
    const seenCursors = new Set<string>();
    let after: string | undefined;
    do {
      const payload = await this.postGraphQl<NonStandardFieldIdsQueryResponse>(
        serverUrl,
        accessToken,
        "Sitecore Authoring non-Standard fields query",
        "XmCloudSyncNonStandardFieldIds",
        print(nonStandardFieldIdsQuery),
        { where, pageSize: 100, after: after ?? null },
        signal,
      );
      const item = payload.data?.item;
      if (!item) {
        throw new Error("The requested Authoring item was not found while classifying fields.");
      }
      const fields = item.fields;
      if (!fields) {
        return fieldIds;
      }
      for (const field of fields.nodes ?? []) {
        if (typeof field.fieldId !== "string") {
          throw new Error("Authoring API returned an invalid non-Standard field ID.");
        }
        fieldIds.add(normalizeGuid(field.fieldId));
      }
      after = nextCursor(fields.pageInfo, "non-Standard fields");
      assertNewCursor(after, seenCursors, "non-Standard fields");
    } while (after !== undefined);
    return fieldIds;
  }

  private async postGraphQl<T extends { readonly errors?: readonly GraphQlError[] }>(
    serverUrl: string,
    accessToken: string,
    requestName: string,
    operationName: string,
    query: string,
    variables: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
    retryable = true,
  ): Promise<T> {
    const endpoint = new URL("/sitecore/api/authoring/graphql/v1/", serverUrl);
    const response = await this.http.request(
      endpoint,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ operationName, query, variables }),
      },
      { name: requestName, signal, retryable },
    );
    const payload = await readJson<T>(response, "Authoring GraphQL endpoint");
    if (!response.ok) {
      throw new Error(`${requestName} failed (${response.status}).`);
    }
    throwForGraphQlErrors(payload.errors);
    return payload;
  }

  clear(): void {
    this.tokens.clear();
    this.http.clear();
  }

  async testConnection(
    connection: XmCloudConnection,
    clientSecret: string,
    cancellationSignal?: AbortSignal,
  ): Promise<ConnectionTestResult> {
    const startedAt = performance.now();
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new DOMException("Connection test timed out.", "AbortError")),
      requestTimeoutMilliseconds,
    );
    const cancellationHandler = (): void =>
      controller.abort(new DOMException("Connection test cancelled.", "AbortError"));
    if (cancellationSignal?.aborted) {
      cancellationHandler();
    } else {
      cancellationSignal?.addEventListener("abort", cancellationHandler, { once: true });
    }

    try {
      const accessToken = await this.requestAccessToken(
        connection.clientId,
        clientSecret,
        controller.signal,
      );
      const siteResult = await this.querySites(
        connection.serverUrl,
        accessToken.value,
        controller.signal,
      );

      return {
        sites: siteResult.sites,
        duplicateSiteCount: siteResult.duplicateSiteCount,
        elapsedMilliseconds: Math.round(performance.now() - startedAt),
      };
    } finally {
      clearTimeout(timeout);
      cancellationSignal?.removeEventListener("abort", cancellationHandler);
    }
  }

  private async getAccessToken(
    connection: XmCloudConnection,
    clientSecret: string,
    signal: AbortSignal,
  ): Promise<string> {
    const cached = this.tokens.get(connection.id);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const token = await this.requestAccessToken(connection.clientId, clientSecret, signal);
    this.tokens.set(connection.id, {
      value: token.value,
      expiresAt: Date.now() + Math.max(token.expiresInSeconds - 60, 30) * 1_000,
    });
    return token.value;
  }

  private async requestAccessToken(
    clientId: string,
    clientSecret: string,
    signal: AbortSignal,
  ): Promise<AccessToken> {
    const body = new URLSearchParams({
      audience,
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    });

    const response = await this.http.request(
      tokenEndpoint,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      },
      { name: "Sitecore OAuth token request", signal, retryable: true },
    );

    const payload = await readJson<TokenResponse>(response, "OAuth token endpoint");
    if (!response.ok) {
      throw new Error(`Authentication failed (${response.status}).`);
    }
    if (typeof payload.access_token !== "string" || payload.access_token.length === 0) {
      throw new Error("Authentication response did not contain an access token.");
    }

    return {
      value: payload.access_token,
      expiresInSeconds:
        typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in)
          ? payload.expires_in
          : 300,
    };
  }

  private async queryTreeLevelPage(
    serverUrl: string,
    accessToken: string,
    locator: AuthoringItemLocator,
    language: string,
    after: string | undefined,
    signal: AbortSignal,
  ): Promise<{
    readonly item: AuthoringTreeItem;
    readonly children: readonly AuthoringTreeItem[];
    readonly nextCursor?: string;
  }> {
    const endpoint = new URL("/sitecore/api/authoring/graphql/v1/", serverUrl);
    const response = await this.http.request(
      endpoint,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          operationName: "XmCloudSyncTreeLevel",
          query: print(treeLevelQuery),
          variables: {
            where: { database: "master", language, ...locator },
            pageSize: 100,
            after: after ?? null,
          },
        }),
      },
      { name: "Sitecore Authoring tree query", signal, retryable: true },
    );

    const payload = await readJson<TreeLevelQueryResponse>(
      response,
      "Authoring GraphQL endpoint",
    );
    if (!response.ok) {
      throw new Error(`Authoring API request failed (${response.status}).`);
    }
    throwForGraphQlErrors(payload.errors);
    if (!payload.data?.item) {
      const identifier = "path" in locator ? locator.path : locator.itemId;
      throw new Error(`Authoring item “${identifier}” was not found.`);
    }

    const item = parseTreeItem(payload.data.item);
    const children = (payload.data.item.children?.nodes ?? []).map(parseTreeItem);
    const pageInfo = payload.data.item.children?.pageInfo;
    const hasNextPage = pageInfo?.hasNextPage === true;
    const endCursor = pageInfo?.endCursor;
    if (hasNextPage && typeof endCursor !== "string") {
      throw new Error("Authoring API reported another children page without a cursor.");
    }

    return {
      item,
      children,
      ...(hasNextPage ? { nextCursor: endCursor as string } : {}),
    };
  }

  private async querySites(
    serverUrl: string,
    accessToken: string,
    signal: AbortSignal,
  ): Promise<SiteQueryResult> {
    const endpoint = new URL("/sitecore/api/authoring/graphql/v1/", serverUrl);
    const response = await this.http.request(
      endpoint,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          operationName: "XmCloudSyncTestConnection",
          query: print(testConnectionQuery),
        }),
      },
      { name: "Sitecore Authoring sites query", signal, retryable: true },
    );

    const payload = await readJson<TestQueryResponse>(response, "Authoring GraphQL endpoint");
    if (!response.ok) {
      throw new Error(`Authoring API request failed (${response.status}).`);
    }
    throwForGraphQlErrors(payload.errors);
    if (!Array.isArray(payload.data?.sites)) {
      throw new Error("Authoring API response did not contain the expected sites collection.");
    }

    const validSites = payload.data.sites
      .map((site): AuthoringSite | undefined => {
        if (typeof site.name !== "string" || typeof site.rootPath !== "string") {
          return undefined;
        }

        const rootItemId = site.rootItem?.itemId;
        return {
          name: site.name,
          rootPath: site.rootPath,
          ...(typeof rootItemId === "string" ? { rootItemId } : {}),
        };
      })
      .filter((site): site is AuthoringSite => site !== undefined);

    const uniqueSites = new Map<string, AuthoringSite>();
    for (const site of validSites) {
      const key = JSON.stringify([site.name, site.rootPath, site.rootItemId ?? null]);
      if (!uniqueSites.has(key)) {
        uniqueSites.set(key, site);
      }
    }

    return {
      sites: [...uniqueSites.values()].sort((left, right) =>
        left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
      ),
      duplicateSiteCount: validSites.length - uniqueSites.size,
    };
  }
}

export interface AuthoringLanguage {
  readonly name: string;
  readonly displayName: string;
  readonly englishName: string;
  readonly nativeName: string;
}

export type AuthoringFieldScope = "VERSIONED" | "UNVERSIONED" | "SHARED";

export interface AuthoringItemField {
  readonly fieldId: string;
  readonly name: string;
  readonly label: string;
  readonly value: string;
  readonly type: string;
  readonly typeKey: string;
  readonly scope: AuthoringFieldScope;
  readonly sortOrder: number;
  readonly sectionName: string;
  readonly sectionSortOrder: number;
  readonly isStandardTemplate: boolean;
  readonly containsFallbackValue: boolean;
  readonly containsInheritedValue: boolean;
  readonly containsStandardValue: boolean;
  readonly textual: boolean;
}

export interface AuthoringItemDetails {
  readonly itemId: string;
  readonly name: string;
  readonly displayName: string;
  readonly path: string;
  readonly hasChildren: boolean;
  readonly language: string;
  readonly version: number;
  readonly template: { readonly templateId: string; readonly name: string };
  readonly availableVersions: readonly { readonly language: string; readonly version: number }[];
  readonly fields: readonly AuthoringItemField[];
}

function parseTreeItem(value: RawAuthoringTreeItem): AuthoringTreeItem {
  if (
    typeof value.itemId !== "string" ||
    typeof value.name !== "string" ||
    typeof value.path !== "string"
  ) {
    throw new Error("Authoring API returned an invalid content-tree item.");
  }

  return {
    itemId: value.itemId,
    name: value.name,
    displayName: typeof value.displayName === "string" ? value.displayName : value.name,
    path: value.path,
    hasChildren: value.hasChildren === true,
  };
}

function parseItemDetails(
  value: RawItemDetails,
  nonStandardFieldIds: ReadonlySet<string>,
): AuthoringItemDetails {
  if (
    typeof value.itemId !== "string" ||
    typeof value.name !== "string" ||
    typeof value.path !== "string" ||
    typeof value.language?.name !== "string" ||
    typeof value.version !== "number" ||
    typeof value.template?.templateId !== "string" ||
    typeof value.template.name !== "string"
  ) {
    throw new Error("Authoring API returned invalid item details.");
  }

  const fields = (value.fields?.nodes ?? []).map((field): AuthoringItemField => {
    const definition = field.templateField;
    if (
      typeof field.fieldId !== "string" ||
      typeof field.name !== "string" ||
      typeof field.value !== "string" ||
      typeof definition?.type !== "string" ||
      typeof definition.typeKey !== "string" ||
      !isFieldScope(definition.versioning)
    ) {
      throw new Error("Authoring API returned an invalid item field.");
    }
    return {
      fieldId: field.fieldId,
      name: field.name,
      label: typeof field.label === "string" && field.label ? field.label : field.name,
      value: field.value,
      type: definition.type,
      typeKey: definition.typeKey,
      scope: definition.versioning,
      sortOrder: typeof definition.sortOrder === "number" ? definition.sortOrder : 0,
      sectionName: typeof definition.section?.name === "string" ? definition.section.name : "",
      sectionSortOrder:
        typeof definition.section?.sortOrder === "number" ? definition.section.sortOrder : 0,
      isStandardTemplate: !nonStandardFieldIds.has(normalizeGuid(field.fieldId)),
      containsFallbackValue: field.containsFallbackValue === true,
      containsInheritedValue: field.containsInheritedValue === true,
      containsStandardValue: field.containsStandardValue === true,
      textual: isTextualField(definition.typeKey, definition.type),
    };
  });

  fields.sort((left, right) =>
    left.sectionSortOrder - right.sectionSortOrder ||
    left.sortOrder - right.sortOrder ||
    left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
  );

  const availableVersions = (value.versions ?? [])
    .filter(
      (version): version is { readonly language: { readonly name: string }; readonly version: number } =>
        typeof version.language?.name === "string" && typeof version.version === "number",
    )
    .map((version) => ({ language: version.language.name, version: version.version }));

  return {
    itemId: value.itemId,
    name: value.name,
    displayName: typeof value.displayName === "string" ? value.displayName : value.name,
    path: value.path,
    hasChildren: value.hasChildren === true,
    language: value.language.name,
    version: value.version,
    template: { templateId: value.template.templateId, name: value.template.name },
    availableVersions,
    fields,
  };
}

function fieldEntries(
  fields: Readonly<Record<string, string>> | undefined,
): readonly { readonly name: string; readonly value: string; readonly reset: false }[] {
  return Object.entries(fields ?? {}).map(([name, value]) => ({ name, value, reset: false }));
}

function createFieldEntries(
  fields: Readonly<Record<string, string>> | undefined,
): readonly { readonly name: string; readonly value: string }[] {
  return Object.entries(fields ?? {}).map(([name, value]) => ({ name, value }));
}

function parseMutatedItem(
  value: RawMutatedItem | null | undefined,
  operation: "created" | "updated",
): { readonly itemId: string; readonly language: string } {
  if (
    !value ||
    typeof value.itemId !== "string" ||
    typeof value.language?.name !== "string"
  ) {
    throw new Error(`Authoring API did not confirm the ${operation} item.`);
  }
  return { itemId: value.itemId, language: value.language.name };
}

function nextCursor(pageInfo: RawPageInfo | undefined, collectionName: string): string | undefined {
  if (pageInfo?.hasNextPage !== true) {
    return undefined;
  }
  if (typeof pageInfo.endCursor !== "string") {
    throw new Error(`Authoring API reported another ${collectionName} page without a cursor.`);
  }
  return pageInfo.endCursor;
}

function assertNewCursor(
  cursor: string | undefined,
  seenCursors: Set<string>,
  collectionName: string,
): void {
  if (!cursor) {
    return;
  }
  if (seenCursors.has(cursor)) {
    throw new Error(`Authoring API returned the same ${collectionName} cursor twice.`);
  }
  seenCursors.add(cursor);
}

function normalizeGuid(value: string): string {
  return value.replace(/[{}-]/g, "").toLowerCase();
}

function isFieldScope(value: unknown): value is AuthoringFieldScope {
  return value === "VERSIONED" || value === "UNVERSIONED" || value === "SHARED";
}

function isTextualField(typeKey: string, type: string): boolean {
  const normalized = `${typeKey} ${type}`.toLowerCase();
  return ["text", "html", "rich", "layout", "json", "xml", "code"].some((token) =>
    normalized.includes(token),
  );
}

function throwForGraphQlErrors(errors: readonly GraphQlError[] | undefined): void {
  if (!errors?.length) {
    return;
  }

  const messages = errors
    .map((error) => error.message)
    .filter((message): message is string => typeof message === "string")
    .join("; ");
  throw new Error(messages || "Authoring API returned a GraphQL error.");
}

function property(value: unknown, ...names: readonly string[]): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Readonly<Record<string, unknown>>;
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(record, name)) {
      return record[name];
    }
  }
  return undefined;
}

function stringProperty(value: unknown, ...names: readonly string[]): string | undefined {
  const candidate = property(value, ...names);
  return typeof candidate === "string" ? candidate : undefined;
}

function requiredStringProperty(value: unknown, ...names: readonly string[]): string {
  const candidate = stringProperty(value, ...names);
  if (!candidate) {
    throw new Error(`Transfer API response did not contain ${names[0]}.`);
  }
  return candidate;
}

function requiredNumberProperty(value: unknown, ...names: readonly string[]): number {
  const candidate = property(value, ...names);
  if (typeof candidate !== "number" || !Number.isInteger(candidate) || candidate < 0) {
    throw new Error(`Transfer API response did not contain a valid ${names[0]}.`);
  }
  return candidate;
}

function arrayProperty(value: unknown, ...names: readonly string[]): readonly unknown[] {
  const candidate = property(value, ...names);
  return Array.isArray(candidate) ? candidate : [];
}

async function assertSuccessfulResponse(response: Response, operation: string): Promise<void> {
  if (response.ok) {
    return;
  }
  const details = (await response.text()).trim().slice(0, 1_000);
  throw new Error(
    `${operation} failed (${response.status})${details ? `: ${details}` : "."}`,
  );
}

function jitteredItemTransferPollingDelay(elapsedMilliseconds: number): number {
  const baseDelay = elapsedMilliseconds < 60_000
    ? 2_000
    : elapsedMilliseconds < 5 * 60_000
      ? 5_000
      : elapsedMilliseconds < 10 * 60_000
        ? 10_000
        : 15_000;
  return Math.round(baseDelay * (0.9 + Math.random() * 0.2));
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    throw signal.reason;
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(signal.reason);
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      signal.removeEventListener("abort", onAbort);
      onAbort();
    }
  });
}

async function readJson<T>(response: Response, endpointName: string): Promise<T> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Error(`${endpointName} returned an unexpected content type (${contentType || "unknown"}).`);
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new Error(`${endpointName} returned invalid JSON.`);
  }
}
