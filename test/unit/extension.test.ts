import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

const state = vi.hoisted(() => ({
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  window: {
    activeTextEditor: undefined as vscode.TextEditor | undefined,
    tabGroups: { activeTabGroup: { activeTab: undefined as { input: unknown } | undefined } },
    registerCustomEditorProvider: vi.fn(),
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showQuickPick: vi.fn()
  },
  openTextDocument: vi.fn(),
  executeCommand: vi.fn(),
  readClipboard: vi.fn(),
  writeClipboard: vi.fn(),
  stat: vi.fn()
}));

vi.mock('vscode', () => ({
  window: state.window,
  Uri: { joinPath: () => ({ fsPath: '/extension/dist/worker.js' }) },
  Range: class Range { constructor(readonly start: unknown, readonly end: unknown) {} },
  TabInputCustom: class TabInputCustom {},
  commands: {
    registerCommand: (name: string, handler: (...args: unknown[]) => unknown) => { state.commands.set(name, handler); },
    executeCommand: state.executeCommand
  },
  workspace: {
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
    registerTextDocumentContentProvider: vi.fn(),
    openTextDocument: state.openTextDocument,
    textDocuments: [],
    fs: { stat: state.stat }
  },
  env: { language: 'en', clipboard: { readText: state.readClipboard, writeText: state.writeClipboard } }
}));
vi.mock('../../src/document/workerClient.js', () => ({ WorkerClient: class {} }));
vi.mock('../../src/document/documentCoordinator.js', () => ({ DocumentCoordinator: class {} }));
vi.mock('../../src/editors/jsonPreviewProvider.js', () => ({ JsonPreviewProvider: class {} }));
vi.mock('../../src/editors/jsonlPreviewProvider.js', () => ({ JsonlPreviewProvider: class {} }));
vi.mock('../../src/editors/previewController.js', () => ({ RepairPreviewProvider: class {} }));

import { TabInputCustom } from 'vscode';
import { activate } from '../../src/extension.js';

function uri(path: string, scheme = 'file'): vscode.Uri {
  return { path, scheme, toString: () => `${scheme}:${path}` } as vscode.Uri;
}

const sourceUri = uri('/log.json');
const temporaryUri = uri('/Untitled-1', 'untitled');

function editor(content: string, isEmpty = false, documentUri = sourceUri) {
  const replace = vi.fn();
  const edit = vi.fn(async (callback: (builder: { replace: typeof replace }) => void) => {
    callback({ replace });
    return true;
  });
  state.window.activeTextEditor = {
    document: { uri: documentUri, getText: () => content, positionAt: (offset: number) => ({ offset }) },
    selection: { isEmpty },
    viewColumn: 1,
    edit
  } as unknown as vscode.TextEditor;
  return { edit, replace };
}

describe('open preview command', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    state.commands.clear();
    state.window.activeTextEditor = undefined;
    state.window.tabGroups.activeTabGroup.activeTab = undefined;
    state.stat.mockResolvedValue({ size: 100 });
    state.openTextDocument.mockResolvedValue({ uri: temporaryUri });
    activate({ subscriptions: [], extensionUri: uri('/extension'), workspaceState: {} } as unknown as vscode.ExtensionContext);
  });

  it.each([sourceUri, undefined])('extracts a selected log payload when invoked with %s', async (input) => {
    editor('2026-10-19T13:53:41.216+08:00 INFO think_json={"messages":[{"type":1}]} ext_info=None\n');

    await state.commands.get('jsonlPreview.openPreview')!(input);

    expect(state.openTextDocument).toHaveBeenCalledExactlyOnceWith({ content: '{"messages":[{"type":1}]}' });
    expect(state.executeCommand).toHaveBeenCalledExactlyOnceWith('vscode.openWith', temporaryUri, 'jsonlPreview.text', { preview: false });
  });

  it('opens the whole document when there is no selection', async () => {
    editor('{"whole":true}', true);

    await state.commands.get('jsonlPreview.openPreview')!(sourceUri);

    expect(state.openTextDocument).not.toHaveBeenCalled();
    expect(state.executeCommand).toHaveBeenCalledExactlyOnceWith('reopenActiveEditorWith', 'jsonlPreview.text');
  });

  it('opens an explicitly targeted file without using another editor selection', async () => {
    editor('{"selected":true}');
    const otherUri = uri('/other.json');

    await state.commands.get('jsonlPreview.openPreview')!(otherUri);

    expect(state.openTextDocument).not.toHaveBeenCalled();
    expect(state.executeCommand).toHaveBeenCalledExactlyOnceWith('vscode.openWith', otherUri, 'jsonlPreview.text', { preview: false });
  });

  it('keeps the preview-to-source toggle', async () => {
    state.window.tabGroups.activeTabGroup.activeTab = {
      input: Object.assign(Object.create(TabInputCustom.prototype), { uri: sourceUri, viewType: 'jsonlPreview.text' })
    };

    await state.commands.get('jsonlPreview.openPreview')!(sourceUri);

    expect(state.executeCommand).toHaveBeenCalledExactlyOnceWith('reopenActiveEditorWith', 'default');
    expect(state.openTextDocument).not.toHaveBeenCalled();
  });

  it('does not open the whole file when the user cancels choosing a selected payload', async () => {
    editor('request={"a":1} response={"b":2}');
    state.window.showQuickPick.mockResolvedValue(undefined);

    await state.commands.get('jsonlPreview.openPreview')!(sourceUri);

    expect(state.window.showQuickPick).toHaveBeenCalledOnce();
    expect(state.executeCommand).not.toHaveBeenCalled();
    expect(state.openTextDocument).not.toHaveBeenCalled();
  });

  it.each([temporaryUri, undefined])('extracts a single log line in an untitled document in place with %s', async (input) => {
    const text = '\n \t\nINFO think_json={"messages":[{"text":"日志 😀"}]} ext_info=None\n';
    const { edit, replace } = editor(text, true, temporaryUri);

    await state.commands.get('jsonlPreview.openPreview')!(input);

    expect(edit).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledExactlyOnceWith(
      { start: { offset: 0 }, end: { offset: text.length } }, '{"messages":[{"text":"日志 😀"}]}'
    );
    expect(state.openTextDocument).not.toHaveBeenCalled();
    expect(state.executeCommand).toHaveBeenCalledExactlyOnceWith('reopenActiveEditorWith', 'jsonlPreview.text');
  });

  it.each([
    '{"complete":true}\n',
    '{\n"multiline":true\n}',
    'INFO payload={"first":1}\nINFO payload={"second":2}',
    'request={"a":1} response={"b":2}',
    'INFO payload={"broken":}',
    'INFO payload={"broken":',
    'plain text',
    ' \n\t\n'
  ])('preserves untitled content when it is not a unique embedded JSON on one line: %j', async (text) => {
    const { edit } = editor(text, true, temporaryUri);

    await state.commands.get('jsonlPreview.openPreview')!(temporaryUri);

    expect(edit).not.toHaveBeenCalled();
    expect(state.openTextDocument).not.toHaveBeenCalled();
    expect(state.executeCommand).toHaveBeenCalledExactlyOnceWith('reopenActiveEditorWith', 'jsonlPreview.text');
  });

  it('does not replace log content in saved files', async () => {
    const { edit } = editor('INFO payload={"a":1}', true);

    await state.commands.get('jsonlPreview.openPreview')!(sourceUri);

    expect(edit).not.toHaveBeenCalled();
    expect(state.executeCommand).toHaveBeenCalledExactlyOnceWith('reopenActiveEditorWith', 'jsonlPreview.text');
  });

  it('stops before reopening when the editor rejects the replacement', async () => {
    const { edit } = editor('INFO payload={"a":1}', true, temporaryUri);
    edit.mockResolvedValueOnce(false);

    await state.commands.get('jsonlPreview.openPreview')!(temporaryUri);

    expect(state.window.showErrorMessage).toHaveBeenCalledOnce();
    expect(state.openTextDocument).not.toHaveBeenCalled();
    expect(state.executeCommand).not.toHaveBeenCalled();
  });

  it.each([
    ['INFO payload={"message":"日志 😀","id":12345678901234567890} done', '{"message":"日志 😀","id":12345678901234567890}'],
    ['  [1,{"a":2}]\n', '  [1,{"a":2}]\n'],
    ['{"a":1}\n{"b":2}\n', '{"a":1}\n{"b":2}\n'],
    ['null', 'null']
  ])('opens clipboard JSON in a new temporary preview without an active editor: %j', async (clipboard, content) => {
    state.readClipboard.mockResolvedValue(clipboard);

    await state.commands.get('jsonlPreview.previewClipboard')!();

    expect(state.readClipboard).toHaveBeenCalledOnce();
    expect(state.writeClipboard).not.toHaveBeenCalled();
    expect(state.openTextDocument).toHaveBeenCalledExactlyOnceWith({ content });
    expect(state.executeCommand).toHaveBeenCalledExactlyOnceWith('vscode.openWith', temporaryUri, 'jsonlPreview.text', { preview: false });
  });

  it('chooses between clipboard payloads without changing the active editor', async () => {
    const { edit } = editor('{"selected":true}');
    state.readClipboard.mockResolvedValue('request={"a":1} response={"b":2}');
    state.window.showQuickPick.mockImplementation(async (items) => items[1]);

    await state.commands.get('jsonlPreview.previewClipboard')!();

    expect(state.window.showQuickPick.mock.calls[0]![0].map((item: { content: string }) => item.content)).toEqual(['{"a":1}', '{"b":2}']);
    expect(state.openTextDocument).toHaveBeenCalledExactlyOnceWith({ content: '{"b":2}' });
    expect(state.executeCommand).toHaveBeenCalledExactlyOnceWith('vscode.openWith', temporaryUri, 'jsonlPreview.text', { preview: false });
    expect(edit).not.toHaveBeenCalled();
    expect(state.writeClipboard).not.toHaveBeenCalled();
  });

  it('does not create a tab when clipboard selection is cancelled', async () => {
    state.readClipboard.mockResolvedValue('request={"a":1} response={"b":2}');
    state.window.showQuickPick.mockResolvedValue(undefined);

    await state.commands.get('jsonlPreview.previewClipboard')!();

    expect(state.window.showQuickPick).toHaveBeenCalledOnce();
    expect(state.openTextDocument).not.toHaveBeenCalled();
    expect(state.executeCommand).not.toHaveBeenCalled();
  });

  it.each(['', ' \n\t', 'no JSON here', '{"broken":}', 'payload={"broken":}', '{"valid":1}\n{"broken":}'])('does not create a clipboard tab without valid JSON: %j', async (content) => {
    state.readClipboard.mockResolvedValue(content);

    await state.commands.get('jsonlPreview.previewClipboard')!();

    expect(state.window.showInformationMessage).toHaveBeenCalledExactlyOnceWith('No extractable valid JSON or JSON Lines found in the clipboard.');
    expect(state.openTextDocument).not.toHaveBeenCalled();
    expect(state.executeCommand).not.toHaveBeenCalled();
    expect(state.writeClipboard).not.toHaveBeenCalled();
  });
});
