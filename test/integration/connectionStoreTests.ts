import {
  deepStrictEqual,
  match,
  rejects,
  strictEqual,
} from "node:assert/strict";
import type { XmCloudConnection } from "../../src/connections/connection";
import { ConnectionStore } from "../../src/connections/connectionStore";
import {
  type IntegrationTest,
  MemoryMemento,
  MemorySecretStorage,
} from "./testSupport";

const connectionsKey = "sitecoreXmCloudSync.connections.v1";
const favoritePathsKey = "sitecoreXmCloudSync.favoritePaths.v1";
const verifiedSitesKey = "sitecoreXmCloudSync.verifiedSites.v1";

export const connectionStoreTests: readonly IntegrationTest[] = [
  {
    name: "ConnectionStore filters malformed state and sorts persisted connections",
    async execute(): Promise<void> {
      const alpha = connection("alpha", "Alpha");
      const bravo = connection("bravo", "bravo");
      const memento = new MemoryMemento({
        [connectionsKey]: [bravo, null, { id: "invalid" }, alpha],
        [favoritePathsKey]: [
          { connectionId: alpha.id, path: "/sitecore/content/Z" },
          null,
          { connectionId: 42, path: "/sitecore/content/Invalid" },
        ],
        [verifiedSitesKey]: [
          {
            connectionId: alpha.id,
            sites: [
              { name: "Primary", rootPath: "/sitecore/content/Alpha", rootItemId: "root-id" },
              { name: "Invalid" },
            ],
          },
          { connectionId: 42, sites: [] },
        ],
      });
      const secrets = new MemorySecretStorage();
      const store = new ConnectionStore(memento, secrets);
      try {
        deepStrictEqual(store.list().map((entry) => entry.id), ["alpha", "bravo"]);
        strictEqual(store.get("bravo")?.name, "bravo");
        strictEqual(store.hasName("ALPHA"), true);
        deepStrictEqual(store.listFavoritePaths(alpha.id), ["/sitecore/content/Z"]);
        deepStrictEqual(store.listVerifiedSites(alpha.id), [
          { name: "Primary", rootPath: "/sitecore/content/Alpha", rootItemId: "root-id" },
        ]);
        strictEqual(store.hasVerifiedSiteCatalog(alpha.id), true);
      } finally {
        store.dispose();
        secrets.dispose();
      }
    },
  },
  {
    name: "ConnectionStore adds and reloads metadata without persisting its secret",
    async execute(): Promise<void> {
      const memento = new MemoryMemento();
      const secrets = new MemorySecretStorage();
      const store = new ConnectionStore(memento, secrets);
      let changes = 0;
      const subscription = store.onDidChange(() => {
        changes += 1;
      });
      try {
        const added = await store.add({
          name: "Primary CM",
          serverUrl: "https://cm.example.com",
          clientId: "client-id",
          clientSecret: "client-secret",
        });

        match(added.id, /^[0-9a-f-]{36}$/u);
        match(added.createdAt, /^\d{4}-\d{2}-\d{2}T/u);
        strictEqual(changes, 1);
        strictEqual(await store.getClientSecret(added.id), "client-secret");
        strictEqual(JSON.stringify(memento.get(connectionsKey)).includes("client-secret"), false);

        const reloaded = new ConnectionStore(memento, secrets);
        try {
          deepStrictEqual(reloaded.list(), [added]);
          strictEqual(await reloaded.getClientSecret(added.id), "client-secret");
        } finally {
          reloaded.dispose();
        }
      } finally {
        subscription.dispose();
        store.dispose();
        secrets.dispose();
      }
    },
  },
  {
    name: "ConnectionStore rolls back a secret when adding metadata fails",
    async execute(): Promise<void> {
      const memento = new MemoryMemento();
      memento.updateOverride = async () => {
        throw new Error("Memento unavailable");
      };
      const secrets = new MemorySecretStorage();
      const store = new ConnectionStore(memento, secrets);
      let changes = 0;
      const subscription = store.onDidChange(() => {
        changes += 1;
      });
      try {
        await rejects(
          store.add({
            name: "Failed CM",
            serverUrl: "https://failed.example.com",
            clientId: "client-id",
            clientSecret: "new-secret",
          }),
          /Memento unavailable/u,
        );

        strictEqual(store.list().length, 0);
        strictEqual(changes, 0);
        strictEqual(secrets.stores.length, 1);
        strictEqual(secrets.deletes.length, 1);
        strictEqual(await secrets.get(secrets.stores[0]?.key ?? "missing"), undefined);
      } finally {
        subscription.dispose();
        store.dispose();
        secrets.dispose();
      }
    },
  },
  {
    name: "ConnectionStore rolls back deployment secrets after metadata failure",
    async execute(): Promise<void> {
      const memento = new MemoryMemento();
      const secrets = new MemorySecretStorage();
      const store = new ConnectionStore(memento, secrets);
      try {
        const added = await store.add({
          name: "Primary CM",
          serverUrl: "https://cm.example.com",
          clientId: "client-id",
          clientSecret: "client-secret",
        });
        await store.configureDeploymentMonitoring(
          added.id,
          "old-deployment-client",
          "old-deployment-secret",
          "old-environment",
        );
        memento.updateOverride = async () => {
          throw new Error("Memento unavailable");
        };

        await rejects(
          store.configureDeploymentMonitoring(
            added.id,
            "new-deployment-client",
            "new-deployment-secret",
            "new-environment",
          ),
          /Memento unavailable/u,
        );

        strictEqual(await store.getDeploymentClientSecret(added.id), "old-deployment-secret");
        strictEqual(store.get(added.id)?.deploymentClientId, "old-deployment-client");
        strictEqual(store.get(added.id)?.deploymentEnvironmentId, "old-environment");

        const freshConnection = connection("fresh", "Fresh CM");
        const freshMemento = new MemoryMemento({ [connectionsKey]: [freshConnection] });
        freshMemento.updateOverride = async () => {
          throw new Error("Memento unavailable");
        };
        const freshSecrets = new MemorySecretStorage();
        const freshStore = new ConnectionStore(freshMemento, freshSecrets);
        try {
          await rejects(
            freshStore.configureDeploymentMonitoring(
              freshConnection.id,
              "new-deployment-client",
              "new-deployment-secret",
              "new-environment",
            ),
            /Memento unavailable/u,
          );
          strictEqual(
            await freshStore.getDeploymentClientSecret(freshConnection.id),
            undefined,
          );
          strictEqual(freshSecrets.deletes.length, 1);
        } finally {
          freshStore.dispose();
          freshSecrets.dispose();
        }
      } finally {
        store.dispose();
        secrets.dispose();
      }
    },
  },
  {
    name: "ConnectionStore validates, normalizes, de-duplicates, and reloads related metadata",
    async execute(): Promise<void> {
      const memento = new MemoryMemento();
      const secrets = new MemorySecretStorage();
      const store = new ConnectionStore(memento, secrets);
      let changes = 0;
      const subscription = store.onDidChange(() => {
        changes += 1;
      });
      try {
        const added = await store.add({
          name: "Primary CM",
          serverUrl: "https://cm.example.com",
          clientId: "client-id",
          clientSecret: "client-secret",
        });
        strictEqual(await store.addFavoritePath(added.id, "\\sitecore\\content\\Home\\"), true);
        strictEqual(await store.addFavoritePath(added.id, "/sitecore/content/home"), false);
        await rejects(
          store.addFavoritePath(added.id, "/outside/sitecore"),
          /must begin with \/sitecore/u,
        );
        await rejects(
          store.addFavoritePath("missing", "/sitecore/content/Home"),
          /connection no longer exists/u,
        );
        await store.storeVerifiedSites(added.id, [
          { name: "Primary", rootPath: "/sitecore/content/Home", rootItemId: "root-id" },
        ]);
        await rejects(
          store.storeVerifiedSites("missing", []),
          /connection no longer exists/u,
        );

        deepStrictEqual(store.listFavoritePaths(added.id), ["/sitecore/content/Home"]);
        deepStrictEqual(store.listVerifiedSites(added.id), [
          { name: "Primary", rootPath: "/sitecore/content/Home", rootItemId: "root-id" },
        ]);
        strictEqual(changes, 3);

        const reloaded = new ConnectionStore(memento, secrets);
        try {
          deepStrictEqual(reloaded.listFavoritePaths(added.id), ["/sitecore/content/Home"]);
          strictEqual(reloaded.hasVerifiedSiteCatalog(added.id), true);
        } finally {
          reloaded.dispose();
        }
      } finally {
        subscription.dispose();
        store.dispose();
        secrets.dispose();
      }
    },
  },
  {
    name: "ConnectionStore removes connection metadata and every associated secret",
    async execute(): Promise<void> {
      const memento = new MemoryMemento();
      const secrets = new MemorySecretStorage();
      const store = new ConnectionStore(memento, secrets);
      try {
        const added = await store.add({
          name: "Primary CM",
          serverUrl: "https://cm.example.com",
          clientId: "client-id",
          clientSecret: "client-secret",
        });
        await store.configureDeploymentMonitoring(
          added.id,
          "deployment-client",
          "deployment-secret",
          "environment-id",
        );
        await store.storeSpeCredential(added.id, "sitecore\\admin", "password");
        await store.storeEdgeToken(added.id, "edge-token");
        await store.addFavoritePath(added.id, "/sitecore/content/Home");
        await store.storeVerifiedSites(added.id, [
          { name: "Primary", rootPath: "/sitecore/content/Home" },
        ]);

        await store.remove(added.id);

        strictEqual(store.get(added.id), undefined);
        deepStrictEqual(store.listFavoritePaths(added.id), []);
        deepStrictEqual(store.listVerifiedSites(added.id), []);
        strictEqual(store.hasVerifiedSiteCatalog(added.id), false);
        strictEqual(await store.getClientSecret(added.id), undefined);
        strictEqual(await store.getDeploymentClientSecret(added.id), undefined);
        strictEqual(await store.getSpeCredential(added.id), undefined);
        strictEqual(await store.getEdgeToken(added.id), undefined);
        strictEqual(secrets.deletes.length, 4);
      } finally {
        store.dispose();
        secrets.dispose();
      }
    },
  },
];

function connection(id: string, name: string): XmCloudConnection {
  return {
    id,
    name,
    serverUrl: `https://${id}.example.com`,
    clientId: `${id}-client`,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}
