import type { VsCodeApi, WebviewRequest } from './protocol.js';

declare function acquireVsCodeApi<T = unknown>(): T;

export const vscode = acquireVsCodeApi<VsCodeApi>();
export function send(message: WebviewRequest): void { vscode.postMessage(message); }
