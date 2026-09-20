import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  window: {
    activeTextEditor: undefined as undefined | { selection: { isEmpty: boolean }; document: { getText: ReturnType<typeof vi.fn> } },
    tabGroups: { activeTabGroup: { activeTab: undefined as undefined | { input: unknown } } }
  },
  clipboard: '',
  readText: vi.fn(),
  writeText: vi.fn(),
  executeCommand: vi.fn()
}));
vi.mock('vscode', () => ({
  window: state.window,
  TabInputText: class TabInputText {},
  env: { clipboard: { readText: state.readText, writeText: state.writeText } },
  commands: { executeCommand: state.executeCommand }
}));

import * as vscode from 'vscode';
import { readEditorSelection, readTerminalSelection, SELECTION_READ_BUSY } from '../../src/editors/editorSelection.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function largeEditor(): void {
  state.window.tabGroups.activeTabGroup.activeTab = { input: Object.create(vscode.TabInputText.prototype) };
}

describe('readEditorSelection', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    state.window.activeTextEditor = undefined;
    state.window.tabGroups.activeTabGroup.activeTab = undefined;
    state.clipboard = 'previous clipboard';
    state.readText.mockImplementation(async () => state.clipboard);
    state.writeText.mockImplementation(async (text: string) => { state.clipboard = text; });
  });

  it('reads a normal editor selection directly without touching the clipboard', async () => {
    const getText = vi.fn(() => '{"normal":true}');
    const selection = { isEmpty: false };
    state.window.activeTextEditor = { selection, document: { getText } };
    expect(await readEditorSelection()).toBe('{"normal":true}');
    expect(getText).toHaveBeenCalledWith(selection);
    expect(state.readText).not.toHaveBeenCalled();
    expect(state.executeCommand).not.toHaveBeenCalled();
  });

  it('rejects a known empty selection without copying the current line', async () => {
    state.window.activeTextEditor = { selection: { isEmpty: true }, document: { getText: vi.fn() } };
    expect(await readEditorSelection()).toBeUndefined();
    expect(state.executeCommand).not.toHaveBeenCalled();
  });

  it.each([undefined, { input: {} }])('does not copy from a non-text tab: %s', async (tab) => {
    state.window.tabGroups.activeTabGroup.activeTab = tab;
    expect(await readEditorSelection()).toBeUndefined();
    expect(state.readText).not.toHaveBeenCalled();
  });

  it('reads large-file selections even when activeTextEditor is unavailable', async () => {
    largeEditor();
    const content = '{"message":"日志 😀"}\n{"line":414238}';
    state.executeCommand.mockImplementation(async () => { state.clipboard = content; });
    expect(await readEditorSelection()).toBe(content);
    expect(state.executeCommand).toHaveBeenCalledWith('editor.action.clipboardCopyAction');
    expect(state.clipboard).toBe('previous clipboard');
  });

  it('accepts a selection identical to the previous clipboard text', async () => {
    largeEditor();
    state.clipboard = '{"same":true}';
    state.executeCommand.mockImplementation(async () => { state.clipboard = '{"same":true}'; });
    expect(await readEditorSelection()).toBe('{"same":true}');
    expect(state.clipboard).toBe('{"same":true}');
  });

  it('does not preview stale clipboard content when the copy command does nothing', async () => {
    largeEditor();
    expect(await readEditorSelection()).toBeUndefined();
    expect(state.clipboard).toBe('previous clipboard');
  });

  it('restores the clipboard if the copy command fails', async () => {
    largeEditor();
    state.executeCommand.mockRejectedValue(new Error('copy failed'));
    await expect(readEditorSelection()).rejects.toThrow('copy failed');
    expect(state.clipboard).toBe('previous clipboard');
  });

  it('preserves a newer clipboard value when another app updates it before restoration', async () => {
    largeEditor();
    state.executeCommand.mockImplementation(async () => { state.clipboard = '{"selected":true}'; });
    state.readText.mockResolvedValueOnce('previous clipboard')
      .mockResolvedValueOnce('{"selected":true}')
      .mockImplementationOnce(async () => { state.clipboard = 'new external copy'; return state.clipboard; });
    expect(await readEditorSelection()).toBe('{"selected":true}');
    expect(state.clipboard).toBe('new external copy');
    expect(state.writeText).toHaveBeenCalledTimes(1);
  });

  it('reads terminal selections using the same clipboard restoration path', async () => {
    state.executeCommand.mockImplementation(async () => { state.clipboard = '{"terminal":true}'; });
    expect(await readTerminalSelection()).toBe('{"terminal":true}');
    expect(state.executeCommand).toHaveBeenCalledWith('workbench.action.terminal.copySelection');
    expect(state.clipboard).toBe('previous clipboard');
  });

  it('rejects stale clipboard text when terminal copying does nothing', async () => {
    expect(await readTerminalSelection()).toBeUndefined();
    expect(state.clipboard).toBe('previous clipboard');
  });

  const readers = { editor: readEditorSelection, terminal: readTerminalSelection };
  for (const first of ['editor', 'terminal'] as const) {
    for (const second of ['editor', 'terminal'] as const) {
      it.each(['backup', 'copy', 'restore'] as const)(`drops ${second} requests during ${first} %s without queueing`, async (stage) => {
        largeEditor();
        const entered = deferred(), release = deferred();
        const pause = async () => { entered.resolve(); await release.promise; };
        if (stage === 'backup') state.readText.mockImplementationOnce(async () => { await pause(); return state.clipboard; });
        state.executeCommand.mockImplementation(async () => {
          if (stage === 'copy') await pause();
          state.clipboard = '{"selected":true}';
        });
        state.writeText.mockImplementation(async (text: string) => {
          if (stage === 'restore' && text === 'previous clipboard') await pause();
          state.clipboard = text;
        });

        const pending = readers[first]();
        await entered.promise;
        const reads = state.readText.mock.calls.length, writes = state.writeText.mock.calls.length;
        try {
          expect(await readers[second]()).toBe(SELECTION_READ_BUSY);
          expect(state.readText).toHaveBeenCalledTimes(reads);
          expect(state.writeText).toHaveBeenCalledTimes(writes);
        } finally {
          release.resolve();
          await pending;
        }
        expect(await pending).toBe('{"selected":true}');
        expect(state.clipboard).toBe('previous clipboard');
        expect(state.executeCommand).toHaveBeenCalledTimes(1);

        expect(await readers[second]()).toBe('{"selected":true}');
        expect(state.clipboard).toBe('previous clipboard');
        expect(state.executeCommand).toHaveBeenCalledTimes(2);
      });
    }
  }

  it.each(['backup', 'marker', 'copy', 'restore'] as const)('releases the shared guard after a %s failure', async (stage) => {
    largeEditor();
    const error = new Error(`${stage} failed`);
    if (stage === 'backup') state.readText.mockRejectedValueOnce(error);
    if (stage === 'marker') state.writeText.mockRejectedValueOnce(error);
    if (stage === 'copy') state.executeCommand.mockRejectedValueOnce(error);
    if (stage === 'restore') {
      state.writeText.mockImplementationOnce(async (text: string) => { state.clipboard = text; })
        .mockRejectedValueOnce(error);
    }
    await expect(readEditorSelection()).rejects.toThrow(error);

    state.executeCommand.mockImplementation(async () => { state.clipboard = '{"retry":true}'; });
    expect(await readTerminalSelection()).toBe('{"retry":true}');
  });
});
