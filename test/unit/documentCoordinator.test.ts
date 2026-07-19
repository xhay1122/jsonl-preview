import { describe, expect, it, vi } from 'vitest';
import type { WorkerClient } from '../../src/document/workerClient.js';
import type { DocumentSource } from '../../src/document/documentSource.js';
import { defaultSettings } from '../../src/shared/settings.js';

vi.mock('vscode', () => ({}));

import { DocumentCoordinator } from '../../src/document/documentCoordinator.js';

describe('DocumentCoordinator', () => {
  it('uses one in-flight worker session for concurrent consumers and releases it by identity', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const client = {
      onDidRestart: () => ({ dispose() {} }),
      async request(request: Record<string, unknown>) {
        requests.push(request);
        if (request.type === 'session/openText') return { kind: 'jsonl', revision: 'v1', byteLength: 2, parseMilliseconds: 1, errors: 0, recordCount: 1 };
        return { disposed: true };
      }
    } as unknown as WorkerClient;
    const source: DocumentSource = {
      uri: 'untitled:test', revision: 'v1', mode: 'text', capabilities: { dirtyContent: true, randomRead: false, streaming: false },
      async stat() { return { byteLength: 2 }; }, async readText() { await Promise.resolve(); return '{}'; }
    };
    const coordinator = new DocumentCoordinator(client);
    const [first, second] = await Promise.all([coordinator.acquire(source, 'jsonl', defaultSettings), coordinator.acquire(source, 'jsonl', defaultSettings)]);
    expect(first.id).toBe(second.id);
    expect(requests.filter((request) => request.type === 'session/openText')).toHaveLength(1);
    await coordinator.release(first);
    expect(requests.filter((request) => request.type === 'session/dispose')).toHaveLength(0);
    await coordinator.release(second);
    expect(requests.filter((request) => request.type === 'session/dispose')).toHaveLength(1);
    coordinator.dispose();
  });

  it('enforces the normal-mode boundary inside the coordinator', async () => {
    const client = { onDidRestart: () => ({ dispose() {} }), request: vi.fn() } as unknown as WorkerClient;
    const source: DocumentSource = { uri: 'file:test.json', revision: 'v1', mode: 'text', capabilities: { dirtyContent: false, randomRead: false, streaming: false }, async stat() { return { byteLength: 11 }; }, async readText() { return '{}'; } };
    const coordinator = new DocumentCoordinator(client);
    await expect(coordinator.acquire(source, 'json', { ...defaultSettings, normalModeMaxBytes: 10 })).rejects.toThrow(/normal-mode limit/i);
    expect(client.request).not.toHaveBeenCalled();
    coordinator.dispose();
  });
});
