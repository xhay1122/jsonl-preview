export type Brand<T, Name extends string> = T & { readonly __brand: Name };
export type ByteOffset = Brand<number, 'ByteOffset'>;
export type Utf16Offset = Brand<number, 'Utf16Offset'>;

export type JsonNodeType = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';
export interface JsonNodeView {
  nodeId: string;
  key?: string;
  type: JsonNodeType;
  offset: Utf16Offset;
  length: number;
  childrenCount: number;
  pointer: string;
  jsonPath: string;
  displayValue?: string;
  rawText?: string;
  ambiguousPath?: boolean;
}

export interface Diagnostic {
  code: string;
  message: string;
  line: number;
  column: number;
  offset: number;
  length: number;
  severity: 'error' | 'warning';
}

export interface RepairCandidate {
  id: string;
  title: string;
  offset: number;
  length: number;
  text: string;
  result?: string;
}

export interface LineMeta {
  physicalLine: number;
  startByte: ByteOffset;
  contentByteLength: number;
  eolByteLength: 0 | 1 | 2;
  status: 'unparsed' | 'valid' | 'invalid' | 'tooLarge' | 'empty';
}

export type FilterLiteral =
  | { kind: 'string'; value: string }
  | { kind: 'number'; decimal: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' };
export type Filter =
  | { op: 'and'; items: Filter[] }
  | { op: 'compare'; path: string; cmp: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte'; value: FilterLiteral }
  | { op: 'contains'; path: string; value: string }
  | { op: 'exists' | 'isNull'; path: string };
export type SortSpec =
  | { path: string; direction: 'asc' | 'desc'; nulls?: 'first' | 'last' }
  | { by: 'physicalLine'; direction: 'asc' | 'desc' };

export interface JsonlRow {
  resultIndex: number;
  physicalLine: number;
  status: LineMeta['status'];
  raw: string;
  /** The page response contains only a preview; fetch the physical line before using it. */
  rawTruncated?: boolean;
  cells: Record<string, unknown>;
  truncatedCells?: string[];
  error?: Diagnostic;
}

export interface SessionSummary {
  kind: 'json' | 'jsonl';
  revision: string;
  byteLength: number;
  parseMilliseconds: number;
  errors: number;
  errorsComplete?: boolean;
  recordCount?: number;
  fields?: string[];
  fieldPointers?: Record<string, string>;
  root?: JsonNodeView;
  children?: JsonNodeView[];
  diagnostics?: Diagnostic[];
  repairs?: RepairCandidate[];
}
