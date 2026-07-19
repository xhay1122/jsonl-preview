import { afterEach, describe, expect, it } from 'vitest';
import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';
import { defaultSettings } from '../../src/shared/settings.js';
import type { WorkerRequest, WorkerResponse } from '../../src/worker/protocol.js';

let worker: Worker | undefined;
afterEach(async () => { await worker?.terminate(); worker = undefined; });

type RequestInput = WorkerRequest extends infer Request ? Request extends WorkerRequest ? Omit<Request, 'requestId'> : never : never;
function request(input: RequestInput): Promise<WorkerResponse> {
  const requestId = Math.random().toString(36).slice(2);
  return new Promise((resolveResponse, reject) => {
    const onMessage = (message: WorkerResponse | { type: string }) => {
      if ('requestId' in message && message.requestId === requestId) { worker!.off('message', onMessage); resolveResponse(message); }
    };
    worker!.on('message', onMessage); worker!.once('error', reject); worker!.postMessage({ ...input, requestId });
  });
}

describe('worker boundary', () => {
  it('opens a chunked session, pages it and rejects stale revisions', async () => {
    worker = new Worker(resolve('dist/worker.js'));
    const opened = await request({ type: 'session/openText', sessionId: 'session', revision: 'v1', kind: 'jsonl', chunks: ['{"id":1}\n', '{"id":2}'], settings: defaultSettings });
    expect(opened.ok && opened.data).toMatchObject({ kind: 'jsonl', recordCount: 2 });
    const page = await request({ type: 'jsonl/getPage', sessionId: 'session', revision: 'v1', queryId: 'default', queryRevision: 0, offset: 0, limit: 10 });
    expect(page.ok && page.data).toMatchObject({ total: 2, rows: [{ physicalLine: 1 }, { physicalLine: 2 }] });
    const stale = await request({ type: 'jsonl/getPage', sessionId: 'session', revision: 'v0', queryId: 'default', queryRevision: 0, offset: 0, limit: 10 });
    expect(stale).toMatchObject({ ok: false, code: 'STALE_REVISION' });
  });

  it('accepts the configured 1000-row page size when loading the final page', async () => {
    worker = new Worker(resolve('dist/worker.js'));
    const text = Array.from({ length: defaultSettings.pageSize + 5 }, (_, index) => JSON.stringify({ id: index + 1 })).join('\n');
    const opened = await request({ type: 'session/openText', sessionId: 'pagination', revision: 'v1', kind: 'jsonl', chunks: [text], settings: defaultSettings });
    expect(opened.ok && opened.data).toMatchObject({ kind: 'jsonl', recordCount: 1005 });

    const page = await request({
      type: 'jsonl/getPage', sessionId: 'pagination', revision: 'v1', queryId: 'default', queryRevision: 0,
      offset: defaultSettings.pageSize, limit: defaultSettings.pageSize
    });
    expect(page.ok && page.data).toMatchObject({
      total: 1005,
      rows: [
        { resultIndex: 1001, physicalLine: 1001, cells: { id: 1001 } },
        { resultIndex: 1002, physicalLine: 1002, cells: { id: 1002 } },
        { resultIndex: 1003, physicalLine: 1003, cells: { id: 1003 } },
        { resultIndex: 1004, physicalLine: 1004, cells: { id: 1004 } },
        { resultIndex: 1005, physicalLine: 1005, cells: { id: 1005 } }
      ]
    });
  });
});
