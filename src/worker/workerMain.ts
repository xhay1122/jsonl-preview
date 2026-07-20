import { parentPort } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import type { WorkerRequest, WorkerResponse } from './protocol.js';
import { validateWorkerRequest } from './protocol.js';
import { childrenOf, formatJsonEdits, nodeText, parseJsonDocument, queryJson, rootView, type JsonDocument } from './jsonService.js';
import { JsonlIndex } from './jsonlIndex.js';
import { messageOf, PreviewError } from '../shared/errors.js';

if (!parentPort) throw new Error('workerMain must run in a Worker.');

interface Session { revision: string; kind: 'json' | 'jsonl'; json?: JsonDocument; jsonl?: JsonlIndex; cancelled: Set<string>; activeQueries: Set<string> }
const sessions = new Map<string, Session>();

function respond(response: WorkerResponse): void { parentPort!.postMessage(response); }
function assertSession(request: WorkerRequest): Session {
  const session = sessions.get(request.sessionId);
  if (!session) throw new PreviewError('SESSION_NOT_FOUND', 'Preview session no longer exists.');
  if ('revision' in request && session.revision !== request.revision) throw new PreviewError('STALE_REVISION', 'The document changed; refresh the preview.');
  return session;
}

parentPort.on('message', async (value: unknown) => {
  if (!validateWorkerRequest(value)) return;
  const request = value;
  try {
    if (request.type === 'request/cancel') {
      const session = assertSession(request); if (session.activeQueries.has(request.targetRequestId)) session.cancelled.add(request.targetRequestId);
      respond({ requestId: request.requestId, sessionId: request.sessionId, ok: true, revision: '', data: { disposed: true } });
      return;
    }
    if (request.type === 'session/dispose') {
      const session = sessions.get(request.sessionId);
      await session?.jsonl?.close(); sessions.delete(request.sessionId);
      respond({ requestId: request.requestId, sessionId: request.sessionId, ok: true, revision: session?.revision ?? '', data: { disposed: true } });
      return;
    }
    if (request.type === 'session/openText' || request.type === 'session/openFile') {
      await sessions.get(request.sessionId)?.jsonl?.close();
      const started = performance.now();
      if (request.type === 'session/openText' && request.kind === 'json') {
        const text = request.chunks.join('');
        const json = parseJsonDocument(text, request.settings);
        const session: Session = { revision: request.revision, kind: 'json', json, cancelled: new Set(), activeQueries: new Set() };
        sessions.set(request.sessionId, session);
        const root = rootView(json);
        respond({ requestId: request.requestId, sessionId: request.sessionId, ok: true, revision: request.revision, data: {
          kind: 'json', revision: request.revision, byteLength: Buffer.byteLength(text), parseMilliseconds: performance.now() - started,
          errors: json.diagnostics.filter((item) => item.severity === 'error').length,
          ...(root ? { root, children: childrenOf(json, root.nodeId, 0, 100) } : {}), diagnostics: json.diagnostics,
          repairs: json.repairs.map(({ result: _result, ...repair }) => repair)
        } });
      } else {
        const index = new JsonlIndex(request.settings);
        const progress = (scannedBytes: number, totalBytes: number, records: number) => parentPort!.postMessage({ type: 'progress', sessionId: request.sessionId, revision: request.revision, scannedBytes, totalBytes, records });
        if (request.type === 'session/openFile') await index.openFile(request.path, progress, { size: request.expectedSize, mtimeMs: request.expectedMtimeMs, dev: request.expectedDev, ino: request.expectedIno }); else await index.openText(request.chunks.join(''), progress);
        sessions.set(request.sessionId, { revision: request.revision, kind: 'jsonl', jsonl: index, cancelled: new Set(), activeQueries: new Set() });
        respond({ requestId: request.requestId, sessionId: request.sessionId, ok: true, revision: request.revision, data: { kind: 'jsonl', revision: request.revision, byteLength: index.sourceByteLength, parseMilliseconds: performance.now() - started, errors: index.errorCount, recordCount: index.total(), fields: index.fields } });
      }
      return;
    }
    const session = assertSession(request);
    if (request.type === 'json/getChildren') {
      if (!session.json) throw new PreviewError('WRONG_SESSION_TYPE', 'This is not a JSON session.');
      respond({ requestId: request.requestId, sessionId: request.sessionId, ok: true, revision: session.revision, data: { nodes: childrenOf(session.json, request.nodeId, request.offset, request.limit) } });
    } else if (request.type === 'json/format') {
      if (!session.json) throw new PreviewError('WRONG_SESSION_TYPE', 'This is not a JSON session.');
      respond({ requestId: request.requestId, sessionId: request.sessionId, ok: true, revision: session.revision, data: { edits: formatJsonEdits(session.json.text, request.indent) } });
    } else if (request.type === 'json/getRepair') {
      if (!session.json) throw new PreviewError('WRONG_SESSION_TYPE', 'This is not a JSON session.');
      const repair = session.json.repairs.find((item) => item.id === request.repairId);
      if (!repair) throw new PreviewError('REPAIR_NOT_FOUND', 'The repair is stale or unavailable.');
      respond({ requestId: request.requestId, sessionId: request.sessionId, ok: true, revision: session.revision, data: { edits: [{ offset: repair.offset, length: repair.length, text: repair.text }] } });
    } else if (request.type === 'json/getNodeText') {
      if (!session.json) throw new PreviewError('WRONG_SESSION_TYPE', 'This is not a JSON session.');
      respond({ requestId: request.requestId, sessionId: request.sessionId, ok: true, revision: session.revision, data: { content: nodeText(session.json, request.nodeId, request.format) } });
    } else if (request.type === 'json/search') {
      if (!session.json) throw new PreviewError('WRONG_SESSION_TYPE', 'This is not a JSON session.');
      respond({ requestId: request.requestId, sessionId: request.sessionId, ok: true, revision: session.revision, data: queryJson(session.json, request.query) });
    } else if (request.type === 'jsonl/getPage') {
      if (!session.jsonl) throw new PreviewError('WRONG_SESSION_TYPE', 'This is not a JSONL session.');
      const rows = await session.jsonl.page(request.queryId, request.offset, request.limit);
      const total = session.jsonl.total(request.queryId);
      respond({ requestId: request.requestId, sessionId: request.sessionId, ok: true, revision: session.revision, queryRevision: request.queryRevision, data: { rows, total, scannedRows: session.jsonl.lineCount, matchedRows: total, isComplete: true } });
    } else if (request.type === 'jsonl/getRecord') {
      if (!session.jsonl) throw new PreviewError('WRONG_SESSION_TYPE', 'This is not a JSONL session.');
      respond({ requestId: request.requestId, sessionId: request.sessionId, ok: true, revision: session.revision, data: { content: await session.jsonl.recordText(request.physicalLine) } });
    } else if (request.type === 'jsonl/applyQuery') {
      if (!session.jsonl) throw new PreviewError('WRONG_SESSION_TYPE', 'This is not a JSONL session.');
      session.cancelled.delete(request.requestId); session.activeQueries.add(request.requestId);
      let result;
      try { result = await session.jsonl.applyQuery(request.queryId, request.filter, request.sort, () => session.cancelled.has(request.requestId), request.jmesPath); }
      finally { session.activeQueries.delete(request.requestId); session.cancelled.delete(request.requestId); }
      respond({ requestId: request.requestId, sessionId: request.sessionId, ok: true, revision: session.revision, queryRevision: request.queryRevision, data: { rows: await session.jsonl.page(request.queryId, 0, session.jsonl.settings.pageSize), total: session.jsonl.total(request.queryId), ...result, isComplete: true } });
    } else if (request.type === 'jsonl/export') {
      if (!session.jsonl) throw new PreviewError('WRONG_SESSION_TYPE', 'This is not a JSONL session.');
      respond({ requestId: request.requestId, sessionId: request.sessionId, ok: true, revision: session.revision, queryRevision: request.queryRevision, data: { content: await session.jsonl.export(request.queryId, request.format, request.maxBytes) } });
    } else if (request.type === 'jsonl/exportToTemp') {
      if (!session.jsonl) throw new PreviewError('WRONG_SESSION_TYPE', 'This is not a JSONL session.');
      const result = await session.jsonl.exportToFile(request.queryId, request.path, request.format);
      respond({ requestId: request.requestId, sessionId: request.sessionId, ok: true, revision: session.revision, queryRevision: request.queryRevision, data: { path: request.path, ...result } });
    }
  } catch (error) {
    respond({ requestId: request.requestId, sessionId: request.sessionId, ok: false, ...('revision' in request ? { revision: request.revision } : {}), code: error instanceof PreviewError ? error.code : 'INTERNAL', message: messageOf(error) });
  }
});
