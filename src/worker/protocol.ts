import type { Filter, JsonNodeView, JsonlRow, SessionSummary, SortSpec } from '../shared/types.js';
import type { PreviewSettings } from '../shared/settings.js';

export type WorkerRequest =
  | { type: 'session/openText'; requestId: string; sessionId: string; revision: string; kind: 'json' | 'jsonl'; chunks: string[]; settings: PreviewSettings }
  | { type: 'session/openFile'; requestId: string; sessionId: string; revision: string; path: string; expectedSize: number; expectedMtimeMs: number; expectedDev: number; expectedIno: number; settings: PreviewSettings }
  | { type: 'json/getChildren'; requestId: string; sessionId: string; revision: string; nodeId: string; offset: number; limit: number }
  | { type: 'json/format'; requestId: string; sessionId: string; revision: string; indent: number }
  | { type: 'json/getRepair'; requestId: string; sessionId: string; revision: string; repairId: string }
  | { type: 'json/getNodeText'; requestId: string; sessionId: string; revision: string; nodeId: string; format: 'raw' | 'compact' | 'pretty' }
  | { type: 'json/search'; requestId: string; sessionId: string; revision: string; query: string }
  | { type: 'jsonl/getPage'; requestId: string; sessionId: string; revision: string; queryId: string; queryRevision: number; offset: number; limit: number }
  | { type: 'jsonl/getRecord'; requestId: string; sessionId: string; revision: string; physicalLine: number }
  | { type: 'jsonl/applyQuery'; requestId: string; sessionId: string; revision: string; queryId: string; queryRevision: number; filter?: Filter; sort?: SortSpec; jmesPath?: string }
  | { type: 'jsonl/export'; requestId: string; sessionId: string; revision: string; queryId: string; queryRevision: number; format: 'jsonl' | 'json'; maxBytes: number }
  | { type: 'jsonl/exportToTemp'; requestId: string; sessionId: string; revision: string; queryId: string; queryRevision: number; format: 'jsonl' | 'json'; path: string }
  | { type: 'request/cancel'; requestId: string; sessionId: string; targetRequestId: string }
  | { type: 'session/dispose'; requestId: string; sessionId: string };

export type WorkerData = SessionSummary | { nodes: JsonNodeView[] } | { result: unknown } | { rows: JsonlRow[]; total: number; scannedRows: number; matchedRows: number; isComplete: boolean } | { content: string } | { path: string; records: number; bytes: number } | { edits: Array<{ offset: number; length: number; text: string }> } | { disposed: true };
export type WorkerResponse =
  | { requestId: string; sessionId: string; ok: true; revision: string; queryRevision?: number; data: WorkerData }
  | { requestId: string; sessionId: string; ok: false; revision?: string; code: string; message: string };
export type WorkerProgress = { type: 'progress'; sessionId: string; revision: string; scannedBytes: number; totalBytes: number; records: number };

const MAX_ID = 128;
function validSettings(value: unknown): value is PreviewSettings {
  if (!value || typeof value !== 'object') return false;
  const settings = value as Record<string, unknown>;
  return Number.isInteger(settings.indent) && Number(settings.indent) >= 1 && Number(settings.indent) <= 8
    && typeof settings.allowComments === 'boolean' && typeof settings.allowTrailingComma === 'boolean'
    && Number.isInteger(settings.maxAutoExpandDepth) && Number(settings.maxAutoExpandDepth) >= 1 && Number(settings.maxAutoExpandDepth) <= 100
    && Number.isInteger(settings.pageSize) && Number(settings.pageSize) >= 20 && Number(settings.pageSize) <= 1000
    && Number.isInteger(settings.schemaSampleSize) && Number(settings.schemaSampleSize) >= 10 && Number(settings.schemaSampleSize) <= 10_000
    && typeof settings.ignoreEmptyLines === 'boolean'
    && Number.isSafeInteger(settings.maxLineBytes) && Number(settings.maxLineBytes) >= 100 * 1024 && Number(settings.maxLineBytes) <= 1024 * 1024 * 1024
    && Number.isSafeInteger(settings.maxSortableRows) && Number(settings.maxSortableRows) >= 1000 && Number(settings.maxSortableRows) <= 100_000_000
    && Number.isSafeInteger(settings.queryCacheBytes) && Number(settings.queryCacheBytes) >= 8 * 1024 * 1024 && Number(settings.queryCacheBytes) <= 4 * 1024 * 1024 * 1024
    && Number.isSafeInteger(settings.normalModeMaxBytes) && Number(settings.normalModeMaxBytes) >= 1024 * 1024 && Number(settings.normalModeMaxBytes) <= 1024 * 1024 * 1024
    && typeof settings.timezone === 'string' && settings.timezone.length <= 128;
}
function validFilter(value: unknown, depth = 0): value is Filter {
  if (!value || typeof value !== 'object' || depth > 12) return false;
  const filter = value as Record<string, unknown>;
  if (filter.op === 'and') return Array.isArray(filter.items) && filter.items.length <= 32 && filter.items.every((item) => validFilter(item, depth + 1));
  if (typeof filter.path !== 'string' || filter.path.length > 2048 || !filter.path.startsWith('/')) return false;
  if (filter.op === 'exists' || filter.op === 'isNull') return true;
  if (filter.op === 'contains') return typeof filter.value === 'string' && filter.value.length <= 4096;
  if (filter.op === 'compare') {
    if (!['eq', 'ne', 'gt', 'gte', 'lt', 'lte'].includes(String(filter.cmp)) || !filter.value || typeof filter.value !== 'object') return false;
    const literal = filter.value as Record<string, unknown>;
    if (literal.kind === 'null') return true;
    if (literal.kind === 'boolean') return typeof literal.value === 'boolean';
    if (literal.kind === 'string') return typeof literal.value === 'string' && literal.value.length <= 4096;
    return literal.kind === 'number' && typeof literal.decimal === 'string' && literal.decimal.length <= 256;
  }
  return false;
}
function validSort(value: unknown): value is SortSpec {
  if (!value || typeof value !== 'object') return false;
  const sort = value as Record<string, unknown>;
  if (sort.direction !== 'asc' && sort.direction !== 'desc') return false;
  if (sort.by === 'physicalLine') return sort.path === undefined && sort.nulls === undefined;
  return sort.by === undefined && typeof sort.path === 'string' && sort.path.startsWith('/') && sort.path.length <= 2048 && (sort.nulls === undefined || sort.nulls === 'first' || sort.nulls === 'last');
}
export function validateWorkerRequest(value: unknown): value is WorkerRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Record<string, unknown>;
  if (typeof request.type !== 'string' || typeof request.requestId !== 'string' || request.requestId.length > MAX_ID || typeof request.sessionId !== 'string' || request.sessionId.length > MAX_ID) return false;
  if (request.type !== 'request/cancel' && request.type !== 'session/dispose' && (typeof request.revision !== 'string' || request.revision.length > MAX_ID)) return false;
  if (request.type === 'jsonl/getPage') return typeof request.queryId === 'string' && request.queryId.length <= MAX_ID && Number.isSafeInteger(request.queryRevision) && Number(request.queryRevision) >= 0 && Number.isSafeInteger(request.offset) && Number(request.offset) >= 0 && Number.isInteger(request.limit) && Number(request.limit) > 0 && Number(request.limit) <= 1000;
  if (request.type === 'jsonl/getRecord') return Number.isSafeInteger(request.physicalLine) && Number(request.physicalLine) > 0;
  if (request.type === 'json/getChildren') return typeof request.nodeId === 'string' && request.nodeId.length <= MAX_ID && Number.isSafeInteger(request.offset) && Number(request.offset) >= 0 && Number.isInteger(request.limit) && Number(request.limit) > 0 && Number(request.limit) <= 500;
  if (request.type === 'session/openText') return (request.kind === 'json' || request.kind === 'jsonl') && typeof request.revision === 'string' && request.revision.length <= MAX_ID && validSettings(request.settings) && Array.isArray(request.chunks) && request.chunks.length <= 4096 && request.chunks.every((chunk) => typeof chunk === 'string' && chunk.length <= 256 * 1024) && request.chunks.reduce((total, chunk) => total + chunk.length, 0) <= request.settings.normalModeMaxBytes;
  if (request.type === 'jsonl/applyQuery') return typeof request.queryId === 'string' && request.queryId.length <= MAX_ID && Number.isSafeInteger(request.queryRevision) && Number(request.queryRevision) >= 0 && (request.filter === undefined || validFilter(request.filter)) && (request.sort === undefined || validSort(request.sort)) && (request.jmesPath === undefined || typeof request.jmesPath === 'string' && request.jmesPath.length <= 1024);
  if (request.type === 'json/search') return typeof request.query === 'string' && request.query.length <= 1024;
  if (request.type === 'session/openFile') return typeof request.revision === 'string' && request.revision.length <= MAX_ID && validSettings(request.settings) && typeof request.path === 'string' && request.path.length <= 32768 && Number.isSafeInteger(request.expectedSize) && Number(request.expectedSize) >= 0 && Number.isFinite(request.expectedMtimeMs) && Number.isSafeInteger(request.expectedDev) && Number.isSafeInteger(request.expectedIno);
  if (request.type === 'jsonl/exportToTemp') return typeof request.path === 'string' && request.path.length <= 32768 && typeof request.queryId === 'string' && request.queryId.length <= MAX_ID && Number.isSafeInteger(request.queryRevision) && Number(request.queryRevision) >= 0 && (request.format === 'json' || request.format === 'jsonl');
  if (request.type === 'jsonl/export') return typeof request.queryId === 'string' && request.queryId.length <= MAX_ID && Number.isSafeInteger(request.queryRevision) && Number(request.queryRevision) >= 0 && (request.format === 'json' || request.format === 'jsonl') && Number.isSafeInteger(request.maxBytes) && Number(request.maxBytes) > 0 && Number(request.maxBytes) <= 100 * 1024 * 1024;
  if (request.type === 'json/format') return typeof request.revision === 'string' && request.revision.length <= MAX_ID && Number.isInteger(request.indent) && Number(request.indent) >= 1 && Number(request.indent) <= 8;
  if (request.type === 'json/getRepair') return typeof request.revision === 'string' && request.revision.length <= MAX_ID && typeof request.repairId === 'string' && request.repairId.length <= MAX_ID;
  if (request.type === 'json/getNodeText') return typeof request.revision === 'string' && request.revision.length <= MAX_ID && typeof request.nodeId === 'string' && request.nodeId.length <= MAX_ID && ['raw', 'compact', 'pretty'].includes(String(request.format));
  if (request.type === 'request/cancel') return typeof request.targetRequestId === 'string' && request.targetRequestId.length <= MAX_ID;
  return request.type === 'session/dispose';
}
