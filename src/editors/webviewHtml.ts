import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';

export function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(18).toString('base64');
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.css'));
  const csp = [`default-src 'none'`, `script-src 'nonce-${nonce}'`, `style-src ${webview.cspSource} 'unsafe-inline'`, `img-src ${webview.cspSource} data:`, `font-src ${webview.cspSource}`, `connect-src 'none'`, `worker-src 'none'`, `frame-src 'none'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`].join('; ');
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><link rel="stylesheet" href="${style}"><title>JSON(L) Preview</title></head><body><div id="app" aria-busy="true"></div><div id="live" class="sr-only" aria-live="polite" aria-atomic="true"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
}
