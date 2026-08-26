import { beforeEach, describe, expect, it, vi } from 'vitest';

const vscode = vi.hoisted(() => ({
  writeText: vi.fn(async (_text: string) => undefined)
}));

vi.mock('vscode', () => ({ env: { clipboard: { writeText: vscode.writeText } } }));

import { PreviewController } from '../../src/editors/previewController.js';
import { PreviewError } from '../../src/shared/errors.js';

function controllerWith(client: Record<string, unknown>): PreviewController & Record<string, unknown> {
  const controller = Object.create(PreviewController.prototype) as PreviewController & Record<string, unknown>;
  Object.assign(controller, {
    session: { id: 'session', key: 'key', revision: 'v1', summary: { kind: 'jsonl', revision: 'v1', byteLength: 10, parseMilliseconds: 1, errors: 0 } },
    disposed: false,
    currentQueryRevision: 0,
    currentQueryId: 'default',
    currentQueryIdRevision: 0,
    controllerId: 'controller',
    panel: { webview: { postMessage: vi.fn(async () => true) } },
    client,
    kind: 'jsonl',
    settings: { pageSize: 100 }
  });
  return controller;
}

describe('PreviewController', () => {
  beforeEach(() => vscode.writeText.mockClear());

  it('fetches complete JSONL content before copying rows and cells', async () => {
    const request = vi.fn(async (message: Record<string, unknown>) => ({ content: message.type === 'jsonl/getCellValue' ? 'complete cell' : 'complete row' }));
    const controller = controllerWith({ request });
    const receive = controller as unknown as { onMessage(message: unknown): Promise<void> };

    await receive.onMessage({ type: 'copy', physicalLine: 7 });
    await receive.onMessage({ type: 'copy', physicalLine: 7, pointer: '/content' });

    expect(request).toHaveBeenNthCalledWith(1, expect.objectContaining({ type: 'jsonl/getRecord', physicalLine: 7 }));
    expect(request).toHaveBeenNthCalledWith(2, expect.objectContaining({ type: 'jsonl/getCellValue', physicalLine: 7, pointer: '/content', format: 'plain' }));
    expect(vscode.writeText).toHaveBeenNthCalledWith(1, 'complete row');
    expect(vscode.writeText).toHaveBeenNthCalledWith(2, 'complete cell');
    expect((controller as unknown as { panel: { webview: { postMessage: ReturnType<typeof vi.fn> } } }).panel.webview.postMessage).toHaveBeenCalledWith({ type: 'copied' });
  });

  it('clears the active query identity after a rejected query', async () => {
    const controller = controllerWith({
      cancel: vi.fn(async () => undefined),
      requestWithId: () => ({ requestId: 'failed-request', promise: Promise.reject(new PreviewError('INVALID_JMESPATH', 'bad query')) })
    });

    await (controller as unknown as { onMessage(message: unknown): Promise<void> }).onMessage({ type: 'query', queryRevision: 1, jmesPath: '[' });
    expect((controller as unknown as { activeQueryId?: string }).activeQueryId).toBeUndefined();
    await expect((controller as unknown as { export(queryRevision: number): Promise<void> }).export(1)).rejects.toThrow('has not completed successfully');
  });

  it('does not let a stale initial page overwrite a newer successful query revision', async () => {
    let resolvePage!: (value: Record<string, unknown>) => void;
    const pagePromise = new Promise<Record<string, unknown>>((resolve) => { resolvePage = resolve; });
    const controller = controllerWith({
      request: vi.fn(() => pagePromise),
      cancel: vi.fn(async () => undefined),
      requestWithId: () => ({ requestId: 'query-request', promise: Promise.resolve({ rows: [], total: 0, scannedRows: 1, matchedRows: 0, isComplete: true }) })
    });
    const receive = controller as unknown as { onMessage(message: unknown): Promise<void> };

    const stalePage = receive.onMessage({ type: 'page', offset: 0, queryRevision: 1 });
    await receive.onMessage({ type: 'query', queryRevision: 2, jmesPath: 'active' });
    resolvePage({ rows: [], total: 1, scannedRows: 1, matchedRows: 1, isComplete: true });
    await stalePage;

    expect((controller as unknown as { currentQueryIdRevision: number }).currentQueryIdRevision).toBe(2);
    const messages = (controller as unknown as { panel: { webview: { postMessage: ReturnType<typeof vi.fn> } } }).panel.webview.postMessage.mock.calls.map(([message]) => message);
    expect(messages).toContainEqual(expect.objectContaining({ type: 'page', queryRevision: 2 }));
    expect(messages).not.toContainEqual(expect.objectContaining({ type: 'page', queryRevision: 1 }));
  });

  it('allows the initial default page to retry after a transient failure', async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce({ rows: [], total: 0, scannedRows: 1, matchedRows: 0, isComplete: true });
    const controller = controllerWith({ request });
    const receive = controller as unknown as { onMessage(message: unknown): Promise<void> };

    await receive.onMessage({ type: 'page', offset: 0, queryRevision: 1 });
    await receive.onMessage({ type: 'page', offset: 0, queryRevision: 1 });

    expect(request).toHaveBeenCalledTimes(2);
    expect((controller as unknown as { currentQueryIdRevision: number }).currentQueryIdRevision).toBe(1);
    expect((controller as unknown as { panel: { webview: { postMessage: ReturnType<typeof vi.fn> } } }).panel.webview.postMessage)
      .toHaveBeenCalledWith(expect.objectContaining({ type: 'page', queryRevision: 1 }));
  });
});
