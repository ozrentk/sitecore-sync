import * as vscode from 'vscode';
import { actionIconSvg, iconForAction } from './actionIcons';

/** Add bundled chrome assets without broadening script policy or enabling scripts. */
export function withActionIcons(webview: vscode.Webview, html: string, extensionUri: vscode.Uri): string {
  const shared = vscode.Uri.joinPath(extensionUri, 'media', 'shared');
  const runtime = vscode.Uri.joinPath(extensionUri, 'out', 'webview');
  const roots = webview.options.localResourceRoots ?? [];
  const required = webview.options.enableScripts ? [shared, runtime] : [shared];
  webview.options = { ...webview.options, localResourceRoots: [...roots, ...required.filter(uri => !roots.some(root => root.toString() === uri.toString()))] };
  const css = webview.asWebviewUri(vscode.Uri.joinPath(shared, 'actionIcons.css'));
  html = html.replace('</head>', `<link rel="stylesheet" href="${css}"></head>`);
  if (!webview.options.enableScripts) {
    return html.replace(/(<a\b[^>]*class="button"[^>]*>)([^<]*)(<\/a>)/g, (_match, open: string, label: string, close: string) => {
      const icon = iconForAction(label);
      return `${open}${icon ? actionIconSvg(icon) : ''}${label}${close}`;
    });
  }
  const nonce = /<script\s+nonce="([a-zA-Z0-9]+)"/.exec(html)?.[1];
  const script = webview.asWebviewUri(vscode.Uri.joinPath(runtime, 'actionIcons.js'));
  return html.replace('</body>', `<script${nonce ? ` nonce="${nonce}"` : ''} src="${script}"></script></body>`);
}
