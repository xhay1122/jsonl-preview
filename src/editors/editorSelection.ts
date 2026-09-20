import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';

export const SELECTION_READ_BUSY = Symbol('selection-read-busy');
type SelectionResult = string | undefined | typeof SELECTION_READ_BUSY;
let clipboardReadInProgress = false;

/** Large documents are not synchronized to the extension host. */
export async function readEditorSelection(): Promise<SelectionResult> {
  if (clipboardReadInProgress) return SELECTION_READ_BUSY;
  const editor = vscode.window.activeTextEditor;
  if (editor) return editor.selection.isEmpty ? undefined : editor.document.getText(editor.selection);

  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (!(input instanceof vscode.TabInputText)) return undefined;

  // Copy runs in the workbench, where the large document's selection still exists.
  // The command is enabled only with editorHasSelection to avoid copying a whole line.
  return readClipboardSelection('editor.action.clipboardCopyAction');
}

export async function readTerminalSelection(): Promise<SelectionResult> {
  return readClipboardSelection('workbench.action.terminal.copySelection');
}

async function readClipboardSelection(command: string): Promise<SelectionResult> {
  // Drop concurrent requests instead of queueing a copy against a changed focus/selection.
  if (clipboardReadInProgress) return SELECTION_READ_BUSY;
  clipboardReadInProgress = true;
  try {
    return await copySelection(command);
  } finally {
    clipboardReadInProgress = false;
  }
}

async function copySelection(command: string): Promise<string | undefined> {
  // VS Code exposes only plain-text clipboard access. Images and rich text cannot
  // be restored by this fallback (also used for terminal selections); see README.
  const original = await vscode.env.clipboard.readText();
  const marker = `jsonl-preview-selection-${randomUUID()}`;
  let copied: string | undefined;
  await vscode.env.clipboard.writeText(marker);
  try {
    await vscode.commands.executeCommand(command);
    copied = await vscode.env.clipboard.readText();
    return copied === marker || !copied ? undefined : copied;
  } finally {
    const current = await vscode.env.clipboard.readText();
    if (current === marker || (copied !== undefined && current === copied)) {
      await vscode.env.clipboard.writeText(original);
    }
  }
}
