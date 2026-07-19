import * as vscode from 'vscode';
import { TextDocumentSource } from '../document/documentSource.js';
import type { DocumentCoordinator } from '../document/documentCoordinator.js';
import type { WorkerClient } from '../document/workerClient.js';
import type { PreviewSettings } from '../shared/settings.js';
import { previewDocumentKind } from '../shared/documentKind.js';
import { PreviewController, RepairPreviewProvider } from './previewController.js';

export class JsonPreviewProvider implements vscode.CustomTextEditorProvider {
  private readonly controllers = new Map<vscode.WebviewPanel, PreviewController>();
  private active: PreviewController | undefined;
  constructor(private readonly extensionUri: vscode.Uri, private readonly coordinator: DocumentCoordinator, private readonly client: WorkerClient, private readonly repairPreview: RepairPreviewProvider, private readonly workspaceState: vscode.Memento, private readonly settings: () => PreviewSettings) {}
  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const create = () => {
      const text = document.getText();
      const kind = previewDocumentKind(document.uri.path, text);
      const existing = this.controllers.get(panel);
      if (existing) void existing.refresh(new TextDocumentSource(document, text), kind, this.settings());
      else {
        const controller = new PreviewController(panel, document.uri, new TextDocumentSource(document, text), kind, this.settings(), this.coordinator, this.client, this.extensionUri, this.repairPreview, this.workspaceState, document);
        this.controllers.set(panel, controller); this.active = controller;
      }
    };
    create();
    let timer: NodeJS.Timeout | undefined;
    const changes = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document !== document) return; if (timer) clearTimeout(timer); timer = setTimeout(create, 250);
    });
    panel.onDidDispose(() => { if (timer) clearTimeout(timer); changes.dispose(); const controller = this.controllers.get(panel); controller?.dispose(); this.controllers.delete(panel); if (this.active === controller) this.active = undefined; });
    panel.onDidChangeViewState((event) => { if (event.webviewPanel.active) this.active = this.controllers.get(panel); });
  }
  activeController(): PreviewController | undefined { return this.active?.isActive() ? this.active : undefined; }
}
