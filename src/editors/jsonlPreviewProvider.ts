import * as vscode from 'vscode';
import { ByteStreamSource } from '../document/documentSource.js';
import type { DocumentCoordinator } from '../document/documentCoordinator.js';
import type { WorkerClient } from '../document/workerClient.js';
import type { PreviewSettings } from '../shared/settings.js';
import { PreviewController, RepairPreviewProvider } from './previewController.js';

class LargeJsonlDocument implements vscode.CustomDocument {
  constructor(readonly uri: vscode.Uri, readonly source: ByteStreamSource) {}
  dispose(): void {}
}

export class JsonlPreviewProvider implements vscode.CustomReadonlyEditorProvider<LargeJsonlDocument> {
  private active: PreviewController | undefined;
  constructor(private readonly extensionUri: vscode.Uri, private readonly coordinator: DocumentCoordinator, private readonly client: WorkerClient, private readonly repairPreview: RepairPreviewProvider, private readonly workspaceState: vscode.Memento, private readonly settings: () => PreviewSettings) {}
  async openCustomDocument(uri: vscode.Uri): Promise<LargeJsonlDocument> { return new LargeJsonlDocument(uri, await ByteStreamSource.create(uri)); }
  async resolveCustomEditor(document: LargeJsonlDocument, panel: vscode.WebviewPanel): Promise<void> {
    const controller = new PreviewController(panel, document.uri, document.source, 'jsonl', this.settings(), this.coordinator, this.client, this.extensionUri, this.repairPreview, this.workspaceState); this.active = controller;
    panel.onDidChangeViewState((event) => { if (event.webviewPanel.active) this.active = controller; });
    panel.onDidDispose(() => { controller.dispose(); if (this.active === controller) this.active = undefined; });
  }
  activeController(): PreviewController | undefined { return this.active?.isActive() ? this.active : undefined; }
}
