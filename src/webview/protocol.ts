import type { JsonNodeView, JsonlRow, SessionSummary, SortSpec } from '../shared/types.js';

export interface ViewState {
  query?: string;
  /** null records an explicit choice to use the original JSONL line order. */
  sort?: SortState | null;
  columns?: string[];
}

export interface SortState {
  field: string;
  direction: 'asc' | 'desc';
}

export type WebviewSummary = SessionSummary & {
  timezone?: string;
  maxAutoExpandDepth?: number;
  locale?: string;
  pageSize?: number;
};

export type WebviewRequest =
  | { type: 'ready' }
  | { type: 'children'; nodeId: string; parentId: string; generation: number; offset: number; limit: number }
  | { type: 'page'; offset: number; queryRevision: number }
  | { type: 'record'; physicalLine: number }
  | { type: 'query'; queryRevision: number; jmesPath?: string; sort?: SortSpec }
  | { type: 'jsonSearch'; query: string; searchRevision: number }
  | { type: 'revealLine'; line: number }
  | { type: 'copy'; text: string }
  | { type: 'copy'; nodeId: string; format: 'raw' | 'compact' | 'pretty' }
  | { type: 'openTemp'; text: string }
  | { type: 'openTemp'; nodeId: string }
  | { type: 'openSource' }
  | { type: 'format' }
  | { type: 'repair' }
  | { type: 'export'; queryRevision: number }
  | { type: 'persist'; state: ViewState };

export type HostMessage =
  | { type: 'init'; summary: WebviewSummary; uiState?: ViewState }
  | { type: 'children'; parentId: string; generation: number; offset: number; nodes: JsonNodeView[] }
  | { type: 'page'; rows: JsonlRow[]; total: number; scannedRows: number; matchedRows: number; isComplete: boolean; offset: number; queryRevision: number }
  | { type: 'record'; physicalLine: number; content: string }
  | { type: 'progress'; records: number; scannedBytes?: number; totalBytes?: number; revision?: string }
  | { type: 'search'; query: string; result: unknown; searchRevision: number }
  | { type: 'error'; message: string };

export interface VsCodeApi {
  postMessage(message: WebviewRequest): void;
  setState(state: ViewState): void;
  getState(): ViewState | undefined;
}

export function isHostMessage(value: unknown): value is HostMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  if (message.type === 'init') return Boolean(message.summary) && typeof message.summary === 'object';
  if (message.type === 'children') return typeof message.parentId === 'string' && Number.isInteger(message.generation) && Number.isInteger(message.offset) && Array.isArray(message.nodes);
  if (message.type === 'page') return Array.isArray(message.rows) && Number.isFinite(message.total) && Number.isInteger(message.offset) && Number.isInteger(message.queryRevision);
  if (message.type === 'record') return Number.isSafeInteger(message.physicalLine) && Number(message.physicalLine) > 0 && typeof message.content === 'string';
  if (message.type === 'progress') return Number.isFinite(message.records);
  if (message.type === 'search') return typeof message.query === 'string' && Number.isInteger(message.searchRevision) && 'result' in message;
  if (message.type === 'error') return typeof message.message === 'string';
  return false;
}
