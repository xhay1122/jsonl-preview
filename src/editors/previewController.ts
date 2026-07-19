import * as vscode from 'vscode';
import type { DocumentCoordinator, SessionHandle } from '../document/documentCoordinator.js';
import type { WorkerClient } from '../document/workerClient.js';
import type { DocumentSource } from '../document/documentSource.js';
import type { Filter, JsonNodeView, RepairCandidate, SortSpec } from '../shared/types.js';
import type { PreviewSettings } from '../shared/settings.js';
import { messageOf, PreviewError } from '../shared/errors.js';
import { webviewHtml } from './webviewHtml.js';
import { createHash, randomUUID } from 'node:crypto';

interface WebviewMessage { type: string; [key: string]: unknown }
interface RepairPreview { original: string; repaired: string }

export class RepairPreviewProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly content = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  set(uri: vscode.Uri, value: string): void {
    const key = uri.toString(); this.content.delete(key); this.content.set(key, value);
    while (this.content.size > 20) this.content.delete(this.content.keys().next().value!);
    this.emitter.fire(uri);
  }
  provideTextDocumentContent(uri: vscode.Uri): string { return this.content.get(uri.toString()) ?? ''; }
  dispose(): void { this.content.clear(); this.emitter.dispose(); }
}

function validMessage(value: unknown): value is WebviewMessage {
  if (!value || typeof value !== 'object') return false;
  try { if (JSON.stringify(value).length > 64 * 1024) return false; } catch { return false; }
  const message = value as Record<string, unknown>;
  return typeof message.type === 'string' && ['ready', 'children', 'page', 'query', 'jsonSearch', 'revealLine', 'copy', 'openTemp', 'openSource', 'format', 'repair', 'export', 'persist'].includes(message.type);
}

export class PreviewController implements vscode.Disposable {
  private session?: SessionHandle;
  private webviewReady = false;
  private disposed = false;
  private activeQueryId?: string;
  private currentQueryRevision = 0;
  private currentQueryId = 'default';
  private readonly controllerId = randomUUID();
  private refreshGeneration = 0;
  private readonly disposables: vscode.Disposable[] = [];
  constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly resource: vscode.Uri,
    private source: DocumentSource,
    private kind: 'json' | 'jsonl',
    private settings: PreviewSettings,
    private readonly coordinator: DocumentCoordinator,
    private readonly client: WorkerClient,
    private readonly extensionUri: vscode.Uri,
    private readonly repairPreview: RepairPreviewProvider,
    private readonly workspaceState: vscode.Memento,
    private readonly textDocument?: vscode.TextDocument
  ) {
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')] };
    panel.webview.html = webviewHtml(panel.webview, extensionUri);
    this.disposables.push(panel.webview.onDidReceiveMessage((message) => void this.onMessage(message)), panel.onDidDispose(() => this.dispose()));
    this.disposables.push(client.onProgress((progress) => { if (progress.sessionId === this.session?.id) void panel.webview.postMessage(progress); }));
    void this.open();
  }

  private async open(): Promise<void> {
    await this.replaceSession(this.source, this.kind, this.settings);
  }
  async refresh(source: DocumentSource, kind: 'json' | 'jsonl', settings: PreviewSettings): Promise<void> {
    await this.replaceSession(source, kind, settings);
  }
  private async replaceSession(source: DocumentSource, kind: 'json' | 'jsonl', settings: PreviewSettings): Promise<void> {
    const generation = ++this.refreshGeneration;
    if (this.activeQueryId && this.session) void this.client.cancel(this.session.id, this.activeQueryId).catch(() => undefined);
    try {
      const next = await this.coordinator.acquire(source, kind, settings);
      if (this.disposed || generation !== this.refreshGeneration) { await this.coordinator.release(next); return; }
      const previous = this.session;
      this.source = source; this.kind = kind; this.settings = settings; this.session = next;
      this.currentQueryId = 'default'; this.currentQueryRevision = 0; delete this.activeQueryId;
      if (previous) await this.coordinator.release(previous);
      if (this.webviewReady) await this.postInit();
    } catch (error) { if (!this.disposed && generation === this.refreshGeneration) await this.error(error); }
  }
  private async onMessage(value: unknown): Promise<void> {
    if (!validMessage(value)) return;
    if (value.type === 'ready') {
      this.webviewReady = true;
      if (this.session) await this.postInit();
      return;
    }
    if (!this.session) return;
    const session = this.session;
    const message = value;
    try {
      if (message.type === 'children') {
        const nodeId = typeof message.nodeId === 'string' ? message.nodeId : '';
        const offset = Math.max(0, Number(message.offset) || 0), limit = Math.max(1, Math.min(500, Number(message.limit) || 100));
        const data = await this.client.request({ type: 'json/getChildren', sessionId: session.id, revision: session.revision, nodeId, offset, limit }) as { nodes: JsonNodeView[] };
        if (this.session !== session || this.disposed) return;
        await this.panel.webview.postMessage({ type: 'children', parentId: message.parentId, generation: message.generation, offset, nodes: data.nodes });
      } else if (message.type === 'page') {
        const offset = Number.isInteger(message.offset) ? Math.max(0, Number(message.offset)) : 0;
        const queryRevision = Number.isInteger(message.queryRevision) ? Number(message.queryRevision) : 0;
        if (queryRevision < this.currentQueryRevision) return;
        this.currentQueryRevision = queryRevision;
        const data = await this.client.request({ type: 'jsonl/getPage', sessionId: session.id, revision: session.revision, queryId: this.currentQueryId, queryRevision, offset, limit: this.settings.pageSize });
        if (this.session !== session || this.disposed) return;
        await this.panel.webview.postMessage({ type: 'page', ...data, offset, queryRevision });
      } else if (message.type === 'query') {
        const queryRevision = Number.isInteger(message.queryRevision) ? Number(message.queryRevision) : 0;
        if (queryRevision < this.currentQueryRevision) return;
        this.currentQueryRevision = queryRevision;
        const filter = message.filter as Filter | undefined, sort = message.sort as SortSpec | undefined, jmesPath = typeof message.jmesPath === 'string' ? message.jmesPath.slice(0, 1024) : undefined;
        if (this.activeQueryId) void this.client.cancel(session.id, this.activeQueryId).catch(() => undefined);
        const queryId = `${this.controllerId}:${queryRevision}`;
        const pending = this.client.requestWithId({ type: 'jsonl/applyQuery', sessionId: session.id, revision: session.revision, queryId, queryRevision, ...(filter ? { filter } : {}), ...(sort ? { sort } : {}), ...(jmesPath ? { jmesPath } : {}) }, 120_000); this.activeQueryId = pending.requestId;
        const data = await pending.promise; if (this.session === session && this.activeQueryId === pending.requestId && !this.disposed) { delete this.activeQueryId; this.currentQueryId = queryId; await this.panel.webview.postMessage({ type: 'page', ...data, offset: 0, queryRevision }); }
      } else if (message.type === 'jsonSearch') {
        const query = typeof message.query === 'string' ? message.query.slice(0, 1024) : '';
        const searchRevision = Number.isInteger(message.searchRevision) ? Number(message.searchRevision) : 0;
        const data = await this.client.request({ type: 'json/search', sessionId: session.id, revision: session.revision, query });
        if (this.session !== session || this.disposed) return;
        await this.panel.webview.postMessage({ type: 'search', query, searchRevision, ...data });
      }
      else if (message.type === 'revealLine') await this.revealLine(Number(message.line));
      else if (message.type === 'copy') await this.copy(message, session);
      else if (message.type === 'openTemp') await this.openTemporary(message, session);
      else if (message.type === 'openSource') await this.openSource();
      else if (message.type === 'format') await this.format(session);
      else if (message.type === 'repair') await this.repair(session);
      else if (message.type === 'export') await this.export(Number(message.queryRevision) || 0, session);
      else if (message.type === 'persist' && message.state && typeof message.state === 'object') await this.persistState(message.state as Record<string, unknown>);
    } catch (error) {
      if (this.session !== session || this.disposed) return;
      if (error instanceof PreviewError && error.code === 'CANCELLED') return;
      if ((error instanceof PreviewError && error.code === 'SESSION_NOT_FOUND') || /worker exited|Worker stopped/i.test(messageOf(error))) { try { await this.recover(); return; } catch (recoveryError) { await this.error(recoveryError); return; } }
      await this.error(error);
    }
  }
  private async openSource(): Promise<void> {
    if (this.source.mode === 'byte-stream') {
      const choice = await vscode.window.showWarningMessage('Opening source loads the complete large file in the text editor.', { modal: true }, 'Open Source'); if (!choice) return;
    }
    await vscode.commands.executeCommand('workbench.action.reopenTextEditor');
  }
  private async revealLine(line: number): Promise<void> {
    if (this.source.mode === 'byte-stream') {
      const choice = await vscode.window.showWarningMessage('Opening source loads the complete large file in the text editor.', { modal: true }, 'Open Source'); if (!choice) return;
    }
    const document = this.textDocument ?? await vscode.workspace.openTextDocument(this.resource); const target = Math.max(0, Math.min(document.lineCount - 1, line - 1));
    const editor = await vscode.window.showTextDocument(document, { preview: true }); const position = new vscode.Position(target, 0); editor.selection = new vscode.Selection(position, position); editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
  }
  private async copy(message: WebviewMessage, session: SessionHandle): Promise<void> {
    if (typeof message.text === 'string') { await vscode.env.clipboard.writeText(message.text); return; }
    const nodeId = typeof message.nodeId === 'string' ? message.nodeId : '';
    const format = ['raw', 'compact', 'pretty'].includes(String(message.format)) ? message.format as 'raw' | 'compact' | 'pretty' : 'raw';
    const data = await this.client.request({ type: 'json/getNodeText', sessionId: session.id, revision: session.revision, nodeId, format }) as { content: string };
    if (this.session !== session || this.disposed) return;
    await vscode.env.clipboard.writeText(data.content);
  }
  private async openTemporary(message: WebviewMessage, session: SessionHandle): Promise<void> {
    let content = typeof message.text === 'string' ? message.text : '';
    if (!content && typeof message.nodeId === 'string') {
      const data = await this.client.request({ type: 'json/getNodeText', sessionId: session.id, revision: session.revision, nodeId: message.nodeId, format: 'pretty' }) as { content: string };
      if (this.session !== session || this.disposed) return;
      content = data.content;
    }
    if (!content) return;
    const document = await vscode.workspace.openTextDocument({ language: 'json', content });
    await vscode.commands.executeCommand('vscode.openWith', document.uri, 'jsonlPreview.text', { preview: true });
  }
  private async format(session: SessionHandle): Promise<void> {
    const document = this.requireEditableDocument();
    const expectedVersion = document.version;
    if (session.revision !== `v${expectedVersion}`) throw new Error('The document changed. Refresh the preview before formatting.');
    const data = await this.client.request({ type: 'json/format', sessionId: session.id, revision: session.revision, indent: this.settings.indent }) as { edits: Array<{ offset: number; length: number; text: string }> };
    if (this.session !== session) throw new Error('The preview refreshed; formatting was not applied.');
    await this.applyEdits(document, data.edits, expectedVersion);
  }
  private async repair(session: SessionHandle): Promise<void> {
    const document = this.requireEditableDocument(); const expectedVersion = document.version;
    if (session.revision !== `v${expectedVersion}`) throw new Error('The document changed. Refresh the preview before repairing.');
    const repairs = session.summary.repairs ?? [];
    const picked = await vscode.window.showQuickPick(repairs.map((repair) => ({ label: repair.title, repair })), { placeHolder: repairs.length ? 'Preview a high-confidence repair' : 'No safe automatic repairs are available' }); if (!picked) return;
    if (document.version !== expectedVersion || this.session !== session) throw new Error('The document changed. Reopen the repair preview.');
    const data = await this.client.request({ type: 'json/getRepair', sessionId: session.id, revision: session.revision, repairId: (picked.repair as RepairCandidate).id }) as { edits: Array<{ offset: number; length: number; text: string }> };
    if (document.version !== expectedVersion || this.session !== session) throw new Error('The document changed. Reopen the repair preview.');
    const original = document.getText(), repaired = applyTextEdits(original, data.edits);
    const base = Buffer.from(this.resource.toString()).toString('base64url'); const before = vscode.Uri.parse(`jsonl-preview-repair:${base}?side=before`), after = vscode.Uri.parse(`jsonl-preview-repair:${base}?side=after`);
    this.repairPreview.set(before, original); this.repairPreview.set(after, repaired); await vscode.commands.executeCommand('vscode.diff', before, after, `Repair Preview: ${this.resource.path.split('/').at(-1)}`);
    const confirm = await vscode.window.showWarningMessage('Apply this repair to the source document?', { modal: true }, 'Apply Repair'); if (confirm) await this.applyEdits(document, data.edits, expectedVersion);
  }
  private requireEditableDocument(): vscode.TextDocument { if (!this.textDocument) throw new Error('Large-file preview is read-only.'); return this.textDocument; }
  private async applyEdits(document: vscode.TextDocument, edits: Array<{ offset: number; length: number; text: string }>, expectedVersion: number): Promise<void> {
    if (document.version !== expectedVersion) throw new Error('The document changed; the operation was not applied.');
    const workspaceEdit = new vscode.WorkspaceEdit();
    for (const edit of [...edits].sort((a, b) => b.offset - a.offset)) workspaceEdit.replace(document.uri, new vscode.Range(document.positionAt(edit.offset), document.positionAt(edit.offset + edit.length)), edit.text);
    if (!await vscode.workspace.applyEdit(workspaceEdit)) throw new Error('VS Code rejected the edit.');
  }
  private async export(queryRevision: number, session = this.session): Promise<void> {
    if (!session) throw new Error('The preview is not ready.');
    if (this.activeQueryId) throw new Error('Wait for the current query to finish before exporting.');
    if (queryRevision !== this.currentQueryRevision) throw new Error('The query changed; retry the export.');
    const target = await vscode.window.showSaveDialog({ filters: { 'JSON Lines': ['jsonl'], JSON: ['json'] }, defaultUri: vscode.Uri.joinPath(this.resource, '..', `${this.resource.path.split('/').at(-1)}.filtered.jsonl`) }); if (!target) return;
    let overwriteApproved = false;
    try { await vscode.workspace.fs.stat(target); const overwrite = await vscode.window.showWarningMessage(`Replace ${target.path.split('/').at(-1)}?`, { modal: true }, 'Replace'); if (!overwrite) return; overwriteApproved = true; } catch { /* target does not exist */ }
    const format = target.path.toLowerCase().endsWith('.json') ? 'json' : 'jsonl';
    if (target.scheme === 'file') {
      const temp = vscode.Uri.file(`${target.fsPath}.jsonl-preview-${randomUUID()}.tmp`);
      try {
        const data = await this.client.request({ type: 'jsonl/exportToTemp', sessionId: session.id, revision: session.revision, queryId: this.currentQueryId, queryRevision, format, path: temp.fsPath }, 120_000) as { records: number; bytes: number };
        if (this.session !== session) throw new Error('The preview refreshed; the export was discarded.');
        await vscode.workspace.fs.rename(temp, target, { overwrite: overwriteApproved }); await vscode.window.showInformationMessage(`Exported ${data.records} records to ${target.fsPath}.`);
      } catch (error) { try { await vscode.workspace.fs.delete(temp); } catch { /* no partial artifact */ } throw error; }
    } else {
      const data = await this.client.request({ type: 'jsonl/export', sessionId: session.id, revision: session.revision, queryId: this.currentQueryId, queryRevision, format, maxBytes: Math.min(this.settings.normalModeMaxBytes, 64 * 1024 * 1024) }, 120_000) as { content: string };
      if (this.session !== session) throw new Error('The preview refreshed; the export was discarded.');
      if (!overwriteApproved) {
        try { await vscode.workspace.fs.stat(target); const overwrite = await vscode.window.showWarningMessage(`Replace ${target.path.split('/').at(-1)}?`, { modal: true }, 'Replace'); if (!overwrite) return; } catch { /* target still does not exist */ }
      }
      await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(data.content));
    }
  }
  async exportCurrent(): Promise<void> { if (this.kind !== 'jsonl') { await vscode.window.showInformationMessage('Export is available for JSONL previews.'); return; } await this.export(this.currentQueryRevision); }
  private async error(error: unknown): Promise<void> { await this.panel.webview.postMessage({ type: 'error', message: messageOf(error) }); }
  private async postInit(): Promise<void> {
    if (!this.session) return;
    await this.panel.webview.postMessage({ type: 'init', summary: { ...this.session.summary, timezone: this.settings.timezone, maxAutoExpandDepth: this.settings.maxAutoExpandDepth, pageSize: this.settings.pageSize, locale: vscode.env.language }, uiState: this.savedState() });
  }
  private async recover(): Promise<void> {
    await this.replaceSession(this.source, this.kind, this.settings);
  }
  private stateKey(): string { return createHash('sha256').update(this.resource.toString()).digest('hex'); }
  private savedState(): Record<string, unknown> | undefined { return this.workspaceState.get<Record<string, Record<string, unknown>>>('jsonlPreview.viewStates', {})[this.stateKey()]; }
  private async persistState(state: Record<string, unknown>): Promise<void> {
    const safe = JSON.stringify(state).length <= 16 * 1024 ? state : {}; const all = this.workspaceState.get<Record<string, Record<string, unknown>>>('jsonlPreview.viewStates', {});
    const next = { ...all, [this.stateKey()]: safe }; const entries = Object.entries(next); await this.workspaceState.update('jsonlPreview.viewStates', Object.fromEntries(entries.slice(-100)));
  }
  isActive(): boolean { return !this.disposed && this.panel.active; }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.refreshGeneration++; this.disposables.forEach((item) => item.dispose()); if (this.activeQueryId && this.session) void this.client.cancel(this.session.id, this.activeQueryId).catch(() => undefined); if (this.session) void this.coordinator.release(this.session); }
}

function applyTextEdits(text: string, edits: Array<{ offset: number; length: number; text: string }>): string {
  for (const edit of [...edits].sort((a, b) => b.offset - a.offset)) text = text.slice(0, edit.offset) + edit.text + text.slice(edit.offset + edit.length); return text;
}
