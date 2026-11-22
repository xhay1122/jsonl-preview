import { afterEach, describe, expect, it } from 'vitest';
import { Worker } from 'node:worker_threads';
import { resolve, join } from 'node:path';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
  it('locates text matches in source order without loading intervening JSON pages', async () => {
    worker = new Worker(resolve('dist/worker.js'));
    const rows = Array.from({ length: 8010 }, (_, index) => index === 8004 ? { text: 'needle again' } : index === 3 ? { text: 'Needle, needle' } : null);
    const identity = { sessionId: 'json-search', revision: 'v1' };
    const opened = await request({ ...identity, type: 'session/openText', kind: 'json',
      chunks: [JSON.stringify({ keep: 'context', rows })], settings: defaultSettings });
    expect(opened.ok && opened.data).toMatchObject({ kind: 'json' });

    const search = { ...identity, type: 'json/search', query: 'needle', mode: 'reveal' } as const;
    const first = await request(search);
    expect(first.ok && first.data).toMatchObject({ matchCount: 3, matchIndex: 0, target: { occurrence: 0 } });
    const second = await request({ ...search, matchIndex: 1 });
    expect(second.ok && second.data).toMatchObject({ matchCount: 3, matchIndex: 1, target: { occurrence: 1 } });
    const third = await request({ ...search, matchIndex: 2 });
    if (!third.ok || !('target' in third.data) || !third.data.target) throw new Error('Missing JSON search target');
    expect(third.data.target.pages.map((page) => page.offset)).toEqual([1, 8000, 0]);
    const scalar = third.data.target.pages.at(-1)!.nodes[0]!;
    expect(scalar).toMatchObject({ nodeId: third.data.target.nodeId, pointer: '/rows/8004/text', displayValue: 'needle again' });
    const copied = await request({ ...identity, type: 'json/getNodeText', nodeId: scalar.nodeId, format: 'raw' });
    expect(copied.ok && copied.data).toEqual({ content: '"needle again"' });

    const projection = await request({ ...search, query: 'rows[3].text' });
    expect(projection.ok && projection.data).toEqual({ result: 'Needle, needle' });
  });

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

  it('opens a streamed file with bigint stat signature and responds to invalid requests instead of hanging', async () => {
    worker = new Worker(resolve('dist/worker.js'));
    const directory = await mkdtemp(join(tmpdir(), 'jsonl-preview-worker-file-'));
    const path = join(directory, 'streamed.jsonl');
    try {
      await writeFile(path, '{"id":1}\n{"id":2}\n');
      const info = await stat(path, { bigint: true });
      const opened = await request({
        type: 'session/openFile', sessionId: 'streamed', revision: 'rev-1', path,
        expectedSize: Number(info.size), expectedMtimeNs: info.mtimeNs.toString(), expectedDev: info.dev.toString(), expectedIno: info.ino.toString(),
        settings: defaultSettings
      });
      expect(opened.ok && opened.data).toMatchObject({ kind: 'jsonl', recordCount: 2 });

      const invalid = await request({
        type: 'session/openFile', sessionId: 'streamed', revision: 'rev-1', path,
        expectedSize: -1, expectedMtimeNs: 'bad', expectedDev: '0', expectedIno: '0', settings: defaultSettings
      });
      expect(invalid).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
