import * as vscode from "vscode";
import type { XmCloudConnection } from "./connection";
import type { ConnectionStore } from "./connectionStore";
import type { AuthoringSite } from "../sitecore/authoringClient";

export type ConnectionTestStatus = "unknown" | "testing" | "success" | "failure";

interface TestState {
  readonly status: ConnectionTestStatus;
  readonly message?: string;
  readonly sites?: readonly AuthoringSite[];
}

export class ConnectionTreeItem extends vscode.TreeItem {
  constructor(
    readonly connection: XmCloudConnection,
    testState: TestState,
    favoriteCount: number,
  ) {
    super(
      connection.name,
      testState.sites?.length || favoriteCount
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );

    this.id = connection.id;
    this.description = connection.serverUrl;
    this.contextValue = "xmCloudConnection";
    this.iconPath = iconForStatus(testState.status);

    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.appendMarkdown(`**${escapeMarkdown(connection.name)}**\n\n`);
    tooltip.appendMarkdown(`${escapeMarkdown(connection.serverUrl)}\n\n`);
    tooltip.appendMarkdown(`Client ID: \`${escapeMarkdown(connection.clientId)}\``);
    if (testState.message) {
      tooltip.appendMarkdown(`\n\n${escapeMarkdown(testState.message)}`);
    }
    this.tooltip = tooltip;
  }
}

export class SiteTreeItem extends vscode.TreeItem {
  constructor(readonly site: AuthoringSite) {
    super(site.name, vscode.TreeItemCollapsibleState.None);
    this.description = site.rootPath;
    this.contextValue = "xmCloudSite";
    this.iconPath = new vscode.ThemeIcon("globe");

    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.appendMarkdown(`**${escapeMarkdown(site.name)}**\n\n`);
    tooltip.appendMarkdown(`Root path: \`${escapeMarkdown(site.rootPath)}\``);
    if (site.rootItemId) {
      tooltip.appendMarkdown(`\n\nRoot item ID: \`${escapeMarkdown(site.rootItemId)}\``);
    }
    this.tooltip = tooltip;
  }
}

export class FavoriteTreeItem extends vscode.TreeItem {
  constructor(
    readonly connection: XmCloudConnection,
    readonly path: string,
  ) {
    super(`☆ ${path.split("/").filter(Boolean).at(-1) ?? path}`, vscode.TreeItemCollapsibleState.None);
    this.description = path;
    this.contextValue = "xmCloudFavorite";
    this.tooltip = `${connection.name}\n${path}`;
    this.command = {
      command: "xmCloudSync.openFavorite",
      title: "Open Favorite in Comparison",
      arguments: [this],
    };
  }
}

type ConnectionNode = ConnectionTreeItem | SiteTreeItem | FavoriteTreeItem;

function iconForStatus(status: ConnectionTestStatus): vscode.ThemeIcon {
  switch (status) {
    case "testing":
      return new vscode.ThemeIcon("sync~spin");
    case "success":
      return new vscode.ThemeIcon("pass-filled", new vscode.ThemeColor("testing.iconPassed"));
    case "failure":
      return new vscode.ThemeIcon("error", new vscode.ThemeColor("testing.iconFailed"));
    case "unknown":
      return new vscode.ThemeIcon("cloud");
  }
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}\[\]()#+\-.!]/g, "\\$&");
}

export class ConnectionTreeProvider
  implements vscode.TreeDataProvider<ConnectionNode>, vscode.Disposable
{
  private readonly changeEmitter = new vscode.EventEmitter<ConnectionNode | undefined | void>();
  private readonly testStates = new Map<string, TestState>();
  private readonly storeSubscription: vscode.Disposable;

  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(private readonly store: ConnectionStore) {
    this.storeSubscription = store.onDidChange(() => this.changeEmitter.fire());
  }

  getTreeItem(element: ConnectionNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ConnectionNode): ConnectionNode[] {
    if (element instanceof SiteTreeItem || element instanceof FavoriteTreeItem) {
      return [];
    }

    if (element instanceof ConnectionTreeItem) {
      const favorites = this.store.listFavoritePaths(element.connection.id).map(
        (path) => new FavoriteTreeItem(element.connection, path),
      );
      const sites = (this.testStates.get(element.connection.id)?.sites ?? []).map(
        (site) => new SiteTreeItem(site),
      );
      return [...favorites, ...sites];
    }

    return this.store.list().map(
      (connection) =>
        new ConnectionTreeItem(
          connection,
          this.testStates.get(connection.id) ?? { status: "unknown" },
          this.store.listFavoritePaths(connection.id).length,
        ),
    );
  }

  setTestState(
    connectionId: string,
    status: ConnectionTestStatus,
    message?: string,
    sites?: readonly AuthoringSite[],
  ): void {
    this.testStates.set(connectionId, { status, message, sites });
    this.changeEmitter.fire();
  }

  dispose(): void {
    this.storeSubscription.dispose();
    this.changeEmitter.dispose();
  }
}
