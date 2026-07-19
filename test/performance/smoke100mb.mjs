import { createWriteStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';

const targetBytes = 100 * 1024 * 1024;
const path = join(tmpdir(), `jsonl-preview-smoke-${randomUUID()}.jsonl`);
const stream = createWriteStream(path, { flags: 'wx' });
let bytes = 0, id = 0;
while (bytes < targetBytes) {
  const line = JSON.stringify({ id, level: id % 10 ? 'info' : 'error', timestamp: 1_700_000_000 + id, message: `fixed benchmark record ${id}` }) + '\n';
  bytes += Buffer.byteLength(line); id++; if (!stream.write(line)) await once(stream, 'drain');
}
stream.end(); await once(stream, 'close');

const worker = new Worker(resolve('dist/worker.js'));
const request = (message) => new Promise((resolveResponse, reject) => {
  const requestId = randomUUID();
  const onError = (error) => { worker.off('message', onMessage); reject(error); };
  const onMessage = (response) => { if (response.requestId === requestId) { worker.off('message', onMessage); worker.off('error', onError); resolveResponse(response); } };
  worker.on('message', onMessage); worker.once('error', onError); worker.postMessage({ ...message, requestId });
});
const settings = { indent: 2, allowComments: false, allowTrailingComma: false, maxAutoExpandDepth: 10, pageSize: 100, schemaSampleSize: 1000, ignoreEmptyLines: true, maxLineBytes: 5 * 1024 * 1024, maxSortableRows: 1_000_000, queryCacheBytes: 128 * 1024 * 1024, normalModeMaxBytes: 100 * 1024 * 1024, timezone: 'system' };
const sourceInfo = await stat(path);
const started = performance.now();
const response = await request({ type: 'session/openFile', sessionId: '100mb-smoke', revision: `size-${bytes}`, path, expectedSize: sourceInfo.size, expectedMtimeMs: sourceInfo.mtimeMs, expectedDev: sourceInfo.dev, expectedIno: sourceInfo.ino, settings });
const indexMilliseconds = performance.now() - started;
const queryStarted = performance.now();
const query = await request({ type: 'jsonl/applyQuery', sessionId: '100mb-smoke', revision: `size-${bytes}`, queryId: 'errors', queryRevision: 1, filter: { op: 'compare', path: '/level', cmp: 'eq', value: { kind: 'string', value: 'error' } } });
const queryMilliseconds = performance.now() - queryStarted;
const peakRssMB = process.memoryUsage().rss / 1024 / 1024, file = await stat(path);
await worker.terminate(); await rm(path);
if (!response.ok || !query.ok || file.size < targetBytes) throw new Error(response.message ?? query.message ?? '100 MB smoke test failed.');
if (indexMilliseconds > 10_000 || queryMilliseconds > 30_000 || peakRssMB > 768) throw new Error(`Performance budget exceeded: index=${Math.round(indexMilliseconds)}ms query=${Math.round(queryMilliseconds)}ms rss=${Math.round(peakRssMB)}MB`);
console.log(JSON.stringify({ bytes: file.size, records: response.data.recordCount, matchedRecords: query.data.matchedRows, indexMilliseconds: Math.round(indexMilliseconds), queryMilliseconds: Math.round(queryMilliseconds), workerParseMilliseconds: Math.round(response.data.parseMilliseconds), peakRssMB: Math.round(peakRssMB) }));
