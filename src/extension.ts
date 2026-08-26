import * as vscode from 'vscode';
import { parseTree, type ParseError } from 'jsonc-parser';
import { WorkerClient } from './document/workerClient.js';
import { DocumentCoordinator } from './document/documentCoordinator.js';
import { JsonPreviewProvider } from './editors/jsonPreviewProvider.js';
import { JsonlPreviewProvider } from './editors/jsonlPreviewProvider.js';
import { RepairPreviewProvider } from './editors/previewController.js';
import type { PreviewSettings } from './shared/settings.js';
import { TextDocumentSource } from './document/documentSource.js';
import { randomUUID } from 'node:crypto';

const previewViewTypes = new Set(['jsonlPreview.text', 'jsonlPreview.large']);

function clamp(value: number, minimum: number, maximum: number): number { return Math.min(maximum, Math.max(minimum, value)); }

function settings(): PreviewSettings {
  const config = vscode.workspace.getConfiguration('jsonlPreview');
  return {
    indent: config.get('json.indent', 2), allowComments: config.get('json.allowComments', false), allowTrailingComma: config.get('json.allowTrailingComma', false), maxAutoExpandDepth: config.get('json.maxAutoExpandDepth', 10),
    pageSize: config.get('jsonl.pageSize', 1000), schemaSampleSize: config.get('jsonl.schemaSampleSize', 1000), ignoreEmptyLines: config.get('jsonl.ignoreEmptyLines', true),
    maxLineBytes: Math.floor(clamp(config.get('maxLineLengthMB', 5), 0.1, 1024) * 1024 * 1024), maxSortableRows: Math.floor(clamp(config.get('maxSortableRows', 1_000_000), 1000, 100_000_000)), queryCacheBytes: Math.floor(clamp(config.get('queryCacheMB', 128), 8, 4096) * 1024 * 1024), normalModeMaxBytes: Math.floor(clamp(config.get('normalModeMaxFileMB', 100), 1, 1024) * 1024 * 1024),
    timezone: config.get('timezone', 'system').slice(0, 128)
  };
}

export function activate(context: vscode.ExtensionContext): void {
  const client = new WorkerClient(vscode.Uri.joinPath(context.extensionUri, 'dist', 'worker.js').fsPath);
  const coordinator = new DocumentCoordinator(client); const repairPreview = new RepairPreviewProvider();
  context.subscriptions.push(coordinator, client, repairPreview, vscode.workspace.registerTextDocumentContentProvider('jsonl-preview-repair', repairPreview));
  const textProvider = new JsonPreviewProvider(context.extensionUri, coordinator, client, repairPreview, context.workspaceState, settings), largeProvider = new JsonlPreviewProvider(context.extensionUri, coordinator, client, repairPreview, context.workspaceState, settings);
  context.subscriptions.push(vscode.window.registerCustomEditorProvider('jsonlPreview.text', textProvider, { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: true }));
  context.subscriptions.push(vscode.window.registerCustomEditorProvider('jsonlPreview.large', largeProvider, { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: true }));
  context.subscriptions.push(vscode.commands.registerCommand('jsonlPreview.openPreview', (uri?: vscode.Uri) => openPreview(uri)), vscode.commands.registerCommand('jsonlPreview.previewSelection', () => previewSelection()), vscode.commands.registerCommand('jsonlPreview.previewTerminalSelection', () => previewTerminalSelection()), vscode.commands.registerCommand('jsonlPreview.formatDocument', () => formatActive(client, coordinator)), vscode.commands.registerCommand('jsonlPreview.diagnoseRepair', () => openPreview()), vscode.commands.registerCommand('jsonlPreview.exportFiltered', async () => { const controller = textProvider.activeController() ?? largeProvider.activeController(); if (controller) await controller.exportCurrent(); else await openPreview(); }), vscode.commands.registerCommand('jsonlPreview.convertFormat', () => convertActive()), vscode.commands.registerCommand('jsonlPreview.resetViewState', async () => { await context.workspaceState.update('jsonlPreview.viewStates', undefined); await vscode.window.showInformationMessage('JSON(L) Preview view state was reset.'); }));
}

function activePreviewUri(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  return input instanceof vscode.TabInputCustom && previewViewTypes.has(input.viewType) ? input.uri : undefined;
}

async function targetUri(input?: vscode.Uri): Promise<vscode.Uri | undefined> { return input ?? vscode.window.activeTextEditor?.document.uri ?? activePreviewUri(); }
async function openPreview(input?: vscode.Uri): Promise<void> {
  const uri = await targetUri(input); if (!uri) { await vscode.window.showInformationMessage('Open a JSON, JSONL or NDJSON file first.'); return; }
  const previewUri = activePreviewUri();
  if (previewUri?.toString() === uri.toString()) {
    await vscode.commands.executeCommand('reopenActiveEditorWith', 'default');
    return;
  }
  const viewColumn = vscode.window.activeTextEditor?.document.uri.toString() === uri.toString() ? vscode.window.activeTextEditor.viewColumn : undefined;
  const extension = uri.path.toLowerCase().split('.').at(-1), isUntitled = uri.scheme === 'untitled';
  if (!isUntitled && !['json', 'jsonl', 'ndjson'].includes(extension ?? '')) { await vscode.window.showErrorMessage('This file is not JSON, JSONL or NDJSON.'); return; }
  let viewType = 'jsonlPreview.text';
  if (uri.scheme === 'file') {
    const openDocument = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());
    const size = (await vscode.workspace.fs.stat(uri)).size;
    const config = vscode.workspace.getConfiguration('jsonlPreview');
    const threshold = config.get('largeFileThresholdMB', 50) * 1024 * 1024;
    const normalLimit = config.get('normalModeMaxFileMB', 100) * 1024 * 1024;
    if (extension !== 'json' && size > threshold && !openDocument?.isDirty) viewType = 'jsonlPreview.large';
    else if (size > normalLimit) { await vscode.window.showErrorMessage(extension === 'json' ? 'The JSON file exceeds the normal-mode limit.' : 'The file exceeds the normal-mode limit and cannot use streaming while it has unsaved changes.'); return; }
  }
  if (viewColumn !== undefined) await vscode.commands.executeCommand('reopenActiveEditorWith', viewType);
  else await vscode.commands.executeCommand('vscode.openWith', uri, viewType, { preview: false });
}

async function previewSelection(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) { await vscode.window.showInformationMessage('Select JSON or JSON Lines content first.'); return; }
  await previewContent(editor.document.getText(editor.selection));
}

async function previewTerminalSelection(): Promise<void> {
  const originalClipboard = await vscode.env.clipboard.readText();
  let content: string | undefined;
  try {
    await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
    content = await vscode.env.clipboard.readText();
  } finally {
    if (content !== undefined && await vscode.env.clipboard.readText() === content) await vscode.env.clipboard.writeText(originalClipboard);
  }
  if (!content) { await vscode.window.showInformationMessage('Select JSON or JSON Lines content in the terminal first.'); return; }
  await previewContent(content);
}

async function previewContent(content: string): Promise<void> {
  const document = await vscode.workspace.openTextDocument({ content });
  await openPreview(document.uri);
}

async function formatActive(client: WorkerClient, coordinator: DocumentCoordinator): Promise<void> {
  const editor = vscode.window.activeTextEditor; if (!editor || !editor.document.fileName.toLowerCase().endsWith('.json')) { await vscode.window.showInformationMessage('Open a JSON source editor first.'); return; }
  const session = await coordinator.acquire(new TextDocumentSource(editor.document), 'json', settings());
  try {
    const expectedVersion = editor.document.version;
    const data = await client.request({ type: 'json/format', sessionId: session.id, revision: session.revision, indent: settings().indent }) as { edits: Array<{ offset: number; length: number; text: string }> };
    if (editor.document.version !== expectedVersion || session.revision !== `v${expectedVersion}`) throw new Error('The document changed; formatting was not applied.');
    const workspaceEdit = new vscode.WorkspaceEdit(); for (const edit of [...data.edits].sort((a, b) => b.offset - a.offset)) workspaceEdit.replace(editor.document.uri, new vscode.Range(editor.document.positionAt(edit.offset), editor.document.positionAt(edit.offset + edit.length)), edit.text); if (!await vscode.workspace.applyEdit(workspaceEdit)) throw new Error('VS Code rejected the formatting edit.');
  } finally { await coordinator.release(session); }
}

async function convertActive(): Promise<void> {
  const document = vscode.window.activeTextEditor?.document; if (!document) return; const isJsonl = /\.(jsonl|ndjson)$/i.test(document.fileName); let output: string, extension: string;
  try {
    const maxBytes = settings().normalModeMaxBytes;
    const characterLength = document.offsetAt(document.lineAt(document.lineCount - 1).range.end);
    if (characterLength > maxBytes) throw new Error(`The document exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MB conversion limit.`);
    const text = document.getText();
    if (Buffer.byteLength(text) > maxBytes) throw new Error(`The document exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MB conversion limit.`);
    if (isJsonl) {
      const records = text.split(/\r?\n/).filter((line) => line.trim()); records.forEach((line, index) => { const errors: ParseError[] = []; if (!parseTree(line, errors) || errors.length) throw new Error(`Invalid JSON on physical line ${index + 1}.`); });
      output = `[\n${records.map((line) => `  ${line}`).join(',\n')}\n]\n`; extension = 'json';
    } else {
      const errors: ParseError[] = [], root = parseTree(text, errors); if (!root || root.type !== 'array' || errors.length) throw new Error('JSON root must be a valid array.');
      output = `${(root.children ?? []).map((node) => text.slice(node.offset, node.offset + node.length)).join('\n')}\n`; extension = 'jsonl';
    }
  } catch (error) { await vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error)); return; }
  const target = await vscode.window.showSaveDialog({ defaultUri: document.uri.with({ path: document.uri.path.replace(/\.[^.]+$/, `.${extension}`) }) });
  if (!target) return;
  let overwriteApproved = false;
  try { await vscode.workspace.fs.stat(target); const overwrite = await vscode.window.showWarningMessage(`Replace ${target.path.split('/').at(-1)}?`, { modal: true }, 'Replace'); if (!overwrite) return; overwriteApproved = true; } catch { /* target does not exist */ }
  const bytes = new TextEncoder().encode(output);
  if (target.scheme === 'file') {
    const temporary = vscode.Uri.file(`${target.fsPath}.jsonl-preview-${randomUUID()}.tmp`);
    try { await vscode.workspace.fs.writeFile(temporary, bytes); await vscode.workspace.fs.rename(temporary, target, { overwrite: overwriteApproved }); }
    catch (error) { try { await vscode.workspace.fs.delete(temporary); } catch { /* no partial artifact */ } throw error; }
  } else {
    if (!overwriteApproved) { try { await vscode.workspace.fs.stat(target); const overwrite = await vscode.window.showWarningMessage(`Replace ${target.path.split('/').at(-1)}?`, { modal: true }, 'Replace'); if (!overwrite) return; } catch { /* target still does not exist */ } }
    await vscode.workspace.fs.writeFile(target, bytes);
  }
}

export function deactivate(): void {}
