import * as vscode from "vscode";

export interface PublishingFormRuntime {
  createWebviewPanel(
    viewType: string,
    title: string,
    showOptions: vscode.ViewColumn,
    options: vscode.WebviewPanelOptions & vscode.WebviewOptions,
  ): vscode.WebviewPanel;
  readFile(uri: vscode.Uri): Thenable<Uint8Array>;
}

export const defaultPublishingFormRuntime: PublishingFormRuntime = {
  createWebviewPanel: (viewType, title, showOptions, options) =>
    vscode.window.createWebviewPanel(viewType, title, showOptions, options),
  readFile: (uri) => vscode.workspace.fs.readFile(uri),
};
