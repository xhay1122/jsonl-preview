import { open, stat, type FileHandle } from 'node:fs/promises';
import { TextDecoder } from 'node:util';
import type { ByteOffset, Diagnostic, Filter, JsonlRow, LineMeta, SortSpec } from '../shared/types.js';
import type { PreviewSettings } from '../shared/settings.js';
import { compareForSort, matchesFilter } from './filterEngine.js';
import { PreviewError } from '../shared/errors.js';
import { parseTree, type Node } from 'jsonc-parser';
import { compile as compileJmesPath, search as jmespathSearch } from 'jmespath';
import { createJsonValueMatcher, isPlainValueQuery } from './valueSearch.js';

interface ParsedLine { raw: string; value?: unknown; cells: Record<string, unknown>; cellsCollected: boolean; exactNumbers: Map<string, string>; exactCollected: boolean; diagnostic?: Diagnostic }
interface CachedLine { value: ParsedLine; bytes: number }
interface QuerySnapshot { rows: Uint32Array; bytes: number }
interface ParseOptions { cache: boolean; cells: boolean; exactNumbers: boolean }
type Progress = (scannedBytes: number, totalBytes: number, records: number) => void;

const LINE_CHUNK_SIZE = 65_536;
const statusCode: Record<LineMeta['status'], number> = { unparsed: 0, valid: 1, invalid: 2, tooLarge: 3, empty: 4 };
const codeStatus: LineMeta['status'][] = ['unparsed', 'valid', 'invalid', 'tooLarge', 'empty'];

class CompactLineIndex {
  private readonly starts: Float64Array[] = [];
  private readonly lengths: Float64Array[] = [];
  private readonly attributes: Uint8Array[] = [];
  length = 0;

  push(startByte: number, contentByteLength: number, eolByteLength: 0 | 1 | 2, status: LineMeta['status']): void {
    const chunkIndex = Math.floor(this.length / LINE_CHUNK_SIZE), offset = this.length % LINE_CHUNK_SIZE;
    if (!this.starts[chunkIndex]) {
      this.starts.push(new Float64Array(LINE_CHUNK_SIZE)); this.lengths.push(new Float64Array(LINE_CHUNK_SIZE)); this.attributes.push(new Uint8Array(LINE_CHUNK_SIZE));
    }
    this.starts[chunkIndex]![offset] = startByte; this.lengths[chunkIndex]![offset] = contentByteLength;
    this.attributes[chunkIndex]![offset] = statusCode[status]! * 4 + eolByteLength; this.length++;
  }

  get(index: number): LineMeta {
    if (!Number.isInteger(index) || index < 0 || index >= this.length) throw new PreviewError('LINE_NOT_FOUND', 'The requested line does not exist.');
    const chunkIndex = Math.floor(index / LINE_CHUNK_SIZE), offset = index % LINE_CHUNK_SIZE;
    const attribute = this.attributes[chunkIndex]![offset]!;
    return { physicalLine: index + 1, startByte: this.starts[chunkIndex]![offset]! as ByteOffset, contentByteLength: this.lengths[chunkIndex]![offset]!, eolByteLength: attribute % 4 as 0 | 1 | 2, status: codeStatus[Math.floor(attribute / 4)]! };
  }

  setStatus(index: number, status: LineMeta['status']): void {
    const chunkIndex = Math.floor(index / LINE_CHUNK_SIZE), offset = index % LINE_CHUNK_SIZE;
    const eol = this.attributes[chunkIndex]![offset]! % 4;
    this.attributes[chunkIndex]![offset] = statusCode[status]! * 4 + eol;
  }
}

function flatten(value: unknown, prefix = '', output: Record<string, unknown> = {}, depth = 0): Record<string, unknown> {
  if (depth > 8 || Object.keys(output).length >= 200) return output;
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      const label = prefix ? `${prefix}.${key}` : key;
      if (child !== null && typeof child === 'object' && !Array.isArray(child)) flatten(child, label, output, depth + 1); else output[label] = child;
    }
  } else output.$ = value;
  return output;
}
function previewValue(value: unknown): unknown {
  if (typeof value === 'string' && value.length > 4096) return `${value.slice(0, 4096)}…`;
  return value;
}

function isJmesPathMatch(value: unknown): boolean {
  if (value === null || value === false || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as object).length > 0;
  return true;
}

function filterNeedsExactNumbers(filter: Filter | undefined): boolean {
  if (!filter) return false;
  if (filter.op === 'and') return filter.items.some(filterNeedsExactNumbers);
  return filter.op === 'compare' && filter.value.kind === 'number';
}

function byteChunks(buffer: Uint8Array): AsyncIterable<Uint8Array> {
  return (async function* () { yield buffer; })();
}
function pointerSegment(value: string): string { return value.replace(/~/g, '~0').replace(/\//g, '~1'); }
function collectExactNumbers(node: Node | undefined, raw: string, pointer = '', output = new Map<string, string>()): Map<string, string> {
  if (!node) return output;
  const pending: Array<{ node: Node; pointer: string }> = [{ node, pointer }];
  while (pending.length) {
    const current = pending.pop()!;
    if (current.node.type === 'number') output.set(current.pointer, raw.slice(current.node.offset, current.node.offset + current.node.length));
    else if (current.node.type === 'array') current.node.children?.forEach((child, index) => pending.push({ node: child, pointer: `${current.pointer}/${index}` }));
    else if (current.node.type === 'object') for (const property of current.node.children ?? []) { const key = String(property.children?.[0]?.value ?? ''); const child = property.children?.[1]; if (child) pending.push({ node: child, pointer: `${current.pointer}/${pointerSegment(key)}` }); }
  }
  return output;
}

export class JsonlIndex {
  private readonly lines = new CompactLineIndex();
  readonly fields: string[] = [];
  private readonly fieldSet = new Set<string>();
  private readonly cache = new Map<number, CachedLine>();
  private cacheBytes = 0;
  private readonly queries = new Map<string, QuerySnapshot>();
  private queryBytes = 0;
  private textBytes?: Uint8Array;
  private file?: FileHandle;
  private fileReadWindow?: { start: number; bytes: Uint8Array };
  private byteLength = 0;
  private sourcePath?: string;
  private sourceSignature?: { size: number; mtimeMs: number; dev: number; ino: number };

  constructor(readonly settings: PreviewSettings) {}

  private get maxIndexedLines(): number {
    const indexBudget = Math.min(512 * 1024 * 1024, Math.max(64 * 1024 * 1024, this.settings.queryCacheBytes * 2));
    return Math.floor(indexBudget / 17);
  }

  private appendLine(startByte: number, contentByteLength: number, eolByteLength: 0 | 1 | 2, status: LineMeta['status']): void {
    if (this.lines.length >= this.maxIndexedLines) throw new PreviewError('INDEX_LIMIT', `The file exceeds the line-index budget of ${this.maxIndexedLines.toLocaleString()} records. Increase queryCacheMB or use a file with fewer records.`);
    this.lines.push(startByte, contentByteLength, eolByteLength, status);
  }

  async openText(text: string, progress?: Progress): Promise<void> {
    this.textBytes = new TextEncoder().encode(text);
    this.byteLength = this.textBytes.byteLength;
    await this.scan(byteChunks(this.textBytes), progress);
  }

  async openFile(path: string, progress?: Progress, expected?: { size: number; mtimeMs: number; dev: number; ino: number }): Promise<void> {
    this.file = await open(path, 'r');
    const before = await this.file.stat();
    if (expected && (before.size !== expected.size || before.mtimeMs !== expected.mtimeMs || before.dev !== expected.dev || before.ino !== expected.ino)) { await this.file.close(); delete this.file; throw new PreviewError('SOURCE_CHANGED', 'The file changed before it could be indexed; refresh the preview.'); }
    this.byteLength = before.size; this.sourcePath = path; this.sourceSignature = { size: before.size, mtimeMs: before.mtimeMs, dev: before.dev, ino: before.ino };
    try {
      await this.scan(this.file.createReadStream({ autoClose: false, highWaterMark: 256 * 1024 }), progress);
      const after = await this.file.stat();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new PreviewError('SOURCE_CHANGED', 'The file changed while it was being indexed.');
    } catch (error) { await this.file.close(); delete this.file; throw error; }
  }

  private async scan(chunks: AsyncIterable<Uint8Array>, progress?: Progress): Promise<void> {
    let start = 0, scanned = 0, previousByte: number | undefined, hasNonWhitespace = false;
    for await (const chunk of chunks) {
      let cursor = 0;
      while (cursor < chunk.length) {
        const newline = chunk.indexOf(0x0a, cursor);
        const end = newline < 0 ? chunk.length : newline;
        if (!hasNonWhitespace) {
          for (let index = cursor; index < end; index++) {
            const byte = chunk[index]!;
            if (byte !== 0x0d && byte !== 0x20 && byte !== 0x09) { hasNonWhitespace = true; break; }
          }
        }
        if (newline < 0) break;
        const byteBeforeNewline = newline > 0 ? chunk[newline - 1] : previousByte;
        const lineEnd = scanned + newline + 1;
        const eol = byteBeforeNewline === 0x0d ? 2 : 1;
        const contentLength = lineEnd - start - eol;
        this.appendLine(start, contentLength, eol, !hasNonWhitespace ? 'empty' : contentLength > this.settings.maxLineBytes ? 'tooLarge' : 'unparsed');
        start = lineEnd; hasNonWhitespace = false;
        cursor = newline + 1;
      }
      previousByte = chunk.length ? chunk[chunk.length - 1] : previousByte;
      scanned += chunk.length;
      progress?.(scanned, this.byteLength, this.lines.length);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (start < scanned) {
      const length = scanned - start;
      this.appendLine(start, length, 0, !hasNonWhitespace ? 'empty' : length > this.settings.maxLineBytes ? 'tooLarge' : 'unparsed');
    }
    let initialCount = 0;
    for (let index = 0; index < this.lines.length; index++) if (!this.settings.ignoreEmptyLines || this.lines.get(index).status !== 'empty') initialCount++;
    const initialRows = new Uint32Array(initialCount); let initialOffset = 0;
    for (let index = 0; index < this.lines.length; index++) if (!this.settings.ignoreEmptyLines || this.lines.get(index).status !== 'empty') initialRows[initialOffset++] = index;
    this.storeQuery('default', initialRows);
    const sample = initialRows.slice(0, this.settings.schemaSampleSize);
    for (const index of sample) await this.parseLine(index, { cache: true, cells: true, exactNumbers: false });
  }

  private async bytes(meta: LineMeta): Promise<Uint8Array> {
    if (this.textBytes) return this.textBytes.subarray(meta.startByte, meta.startByte + meta.contentByteLength);
    if (!this.file) throw new PreviewError('SOURCE_CLOSED', 'The source is closed.');
    const requestedEnd = meta.startByte + meta.contentByteLength;
    const window = this.fileReadWindow;
    if (window && meta.startByte >= window.start && requestedEnd <= window.start + window.bytes.byteLength) {
      const offset = meta.startByte - window.start;
      return window.bytes.subarray(offset, offset + meta.contentByteLength);
    }
    // Schema sampling and pages read adjacent records. A bounded read-ahead
    // window turns hundreds of small random file reads into a few sequential
    // reads without retaining the complete JSONL file.
    const readLength = Math.min(this.byteLength - meta.startByte, Math.max(meta.contentByteLength, 1024 * 1024));
    const buffer = new Uint8Array(readLength);
    const result = await this.file.read(buffer, 0, buffer.length, meta.startByte);
    const bytes = buffer.subarray(0, result.bytesRead);
    this.fileReadWindow = { start: meta.startByte, bytes };
    return bytes.subarray(0, Math.min(meta.contentByteLength, bytes.byteLength));
  }

  private async parseLine(index: number, options: ParseOptions = { cache: true, cells: true, exactNumbers: false }): Promise<ParsedLine> {
    const cached = this.cache.get(index);
    if (cached) {
      if (options.cells && !cached.value.cellsCollected) {
        cached.value.cells = flatten(cached.value.value);
        cached.value.cellsCollected = true;
        for (const field of Object.keys(cached.value.cells)) if (!this.fieldSet.has(field) && this.fields.length < 200) { this.fieldSet.add(field); this.fields.push(field); }
      }
      if (options.exactNumbers && !cached.value.exactCollected) { cached.value.exactNumbers = collectExactNumbers(parseTree(cached.value.raw), cached.value.raw); cached.value.exactCollected = true; }
      this.cache.delete(index); this.cache.set(index, cached);
      return cached.value;
    }
    const meta = this.lines.get(index);
    let parsed: ParsedLine;
    if (meta.status === 'empty') {
      parsed = { raw: '', cells: {}, cellsCollected: true, exactNumbers: new Map(), exactCollected: true, ...(!this.settings.ignoreEmptyLines ? { diagnostic: { code: 'EMPTY_LINE', message: 'Empty lines are not allowed.', line: meta.physicalLine, column: 1, offset: 0, length: 0, severity: 'error' as const } } : {}) };
    } else if (meta.status === 'tooLarge') {
      const preview = await this.bytes({ ...meta, contentByteLength: Math.min(meta.contentByteLength, 4096) });
      parsed = { raw: new TextDecoder().decode(preview) + '…', cells: {}, cellsCollected: true, exactNumbers: new Map(), exactCollected: true, diagnostic: { code: 'LINE_TOO_LARGE', message: 'Line exceeds the configured parsing limit.', line: meta.physicalLine, column: 1, offset: 0, length: meta.contentByteLength, severity: 'error' } };
    } else {
      try {
        const bytes = await this.bytes(meta);
        let raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (meta.physicalLine === 1 && raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
        const value: unknown = JSON.parse(raw);
        this.lines.setStatus(index, 'valid');
        const cells = options.cells ? flatten(value) : {};
        if (options.cells) for (const field of Object.keys(cells)) if (!this.fieldSet.has(field) && this.fields.length < 200) { this.fieldSet.add(field); this.fields.push(field); }
        parsed = { raw, value, cells, cellsCollected: options.cells, exactNumbers: options.exactNumbers ? collectExactNumbers(parseTree(raw), raw) : new Map(), exactCollected: options.exactNumbers };
      } catch (error) {
        this.lines.setStatus(index, 'invalid');
        const raw = new TextDecoder().decode(await this.bytes(meta));
        const match = /position (\d+)/.exec(error instanceof Error ? error.message : '');
        const column = Number(match?.[1] ?? 0) + 1;
        parsed = { raw, cells: {}, cellsCollected: true, exactNumbers: new Map(), exactCollected: true, diagnostic: { code: 'INVALID_JSONL_RECORD', message: error instanceof Error ? error.message : String(error), line: meta.physicalLine, column, offset: column - 1, length: 1, severity: 'error' } };
      }
    }
    if (options.cache) this.cacheLine(index, parsed, meta.contentByteLength);
    return parsed;
  }

  private cacheLine(index: number, value: ParsedLine, sourceBytes: number): void {
    const bytes = Math.max(256, sourceBytes * 3 + Object.keys(value.cells).length * 96 + value.exactNumbers.size * 80);
    const budget = Math.max(1024 * 1024, Math.floor(this.settings.queryCacheBytes * 0.75));
    if (bytes > budget) return;
    const previous = this.cache.get(index); if (previous) this.cacheBytes -= previous.bytes;
    this.cache.set(index, { value, bytes }); this.cacheBytes += bytes;
    while (this.cacheBytes > budget) {
      const oldest = this.cache.entries().next().value as [number, CachedLine] | undefined;
      if (!oldest) break;
      this.cache.delete(oldest[0]); this.cacheBytes -= oldest[1].bytes;
    }
  }

  private storeQuery(queryId: string, indexes: Iterable<number> | Uint32Array): void {
    const rows = indexes instanceof Uint32Array ? indexes : Uint32Array.from(indexes);
    const previous = this.queries.get(queryId); if (previous) this.queryBytes -= previous.bytes;
    const snapshot = { rows, bytes: rows.byteLength };
    this.queries.delete(queryId); this.queries.set(queryId, snapshot); this.queryBytes += snapshot.bytes;
    const budget = Math.max(64 * 1024, Math.floor(this.settings.queryCacheBytes * 0.25));
    if (queryId !== 'default' && snapshot.bytes > budget) { this.queries.delete(queryId); this.queryBytes -= snapshot.bytes; throw new PreviewError('QUERY_CACHE_LIMIT', 'The query result exceeds the configured cache budget. Narrow the query or increase queryCacheMB.'); }
    const cachedBytes = () => [...this.queries.entries()].reduce((total, [id, item]) => total + (id === 'default' ? 0 : item.bytes), 0);
    while ((this.queries.size > 2 && cachedBytes() > budget) || this.queries.size > 32) {
      const oldest = [...this.queries.entries()].find(([id]) => id !== 'default' && id !== queryId);
      if (!oldest) break;
      this.queries.delete(oldest[0]); this.queryBytes -= oldest[1].bytes;
    }
  }

  private query(queryId: string): QuerySnapshot {
    const snapshot = this.queries.get(queryId);
    if (!snapshot) throw new PreviewError('QUERY_NOT_FOUND', 'The query result expired; run the query again.');
    if (queryId !== 'default') { this.queries.delete(queryId); this.queries.set(queryId, snapshot); }
    return snapshot;
  }

  private async ensureSourceUnchanged(): Promise<void> {
    if (!this.sourcePath || !this.sourceSignature) return;
    const current = await stat(this.sourcePath);
    if (current.size !== this.sourceSignature.size || current.mtimeMs !== this.sourceSignature.mtimeMs || current.dev !== this.sourceSignature.dev || current.ino !== this.sourceSignature.ino) throw new PreviewError('SOURCE_CHANGED', 'The file changed after it was indexed; refresh the preview.');
  }

  async applyQuery(queryId: string, filter: Filter | undefined, sort: SortSpec | undefined, cancelled: () => boolean, jmesPath = ''): Promise<{ scannedRows: number; matchedRows: number }> {
    await this.ensureSourceUnchanged();
    if (!filter && !jmesPath && (!sort || 'by' in sort)) {
      const base = this.query('default').rows;
      const rows = sort?.direction === 'desc' ? Uint32Array.from(base).reverse() : base.slice();
      this.storeQuery(queryId, rows);
      return { scannedRows: 0, matchedRows: rows.length };
    }
    if (sort && 'path' in sort && this.lines.length > this.settings.maxSortableRows) throw new PreviewError('SORT_LIMIT', `Sorting is limited to ${this.settings.maxSortableRows} records.`);
    const plainValueQuery = jmesPath ? isPlainValueQuery(jmesPath) : false;
    const matchesJsonValue = plainValueQuery ? createJsonValueMatcher(jmesPath) : undefined;
    let valueSearchOnly = false;
    if (jmesPath) {
      try { compileJmesPath(jmesPath); }
      catch (error) {
        if (!plainValueQuery) throw new PreviewError('INVALID_JMESPATH', error instanceof Error ? error.message : String(error));
        valueSearchOnly = true;
      }
    }
    const matchedIndexes: number[] = [];
    const sortableMatches: Array<{ index: number; value: unknown; exactNumbers: Map<string, string> }> | undefined = sort ? [] : undefined;
    const exactNumbers = Boolean(sort && 'path' in sort) || filterNeedsExactNumbers(filter);
    const maxQueryRows = Math.floor(Math.max(64 * 1024, this.settings.queryCacheBytes * 0.25) / Uint32Array.BYTES_PER_ELEMENT);
    let scannedRows = 0;
    for (let index = 0; index < this.lines.length; index++) {
      if (cancelled()) throw new PreviewError('CANCELLED', 'Query cancelled.');
      const line = await this.parseLine(index, { cache: true, cells: false, exactNumbers }); scannedRows++;
      let expressionMatch = !jmesPath;
      if (jmesPath && line.value !== undefined) {
        if (valueSearchOnly) expressionMatch = matchesJsonValue!(line.value);
        else try {
          const result = jmespathSearch(line.value, jmesPath);
          expressionMatch = result === null && matchesJsonValue ? matchesJsonValue(line.value) : isJmesPathMatch(result);
        } catch (error) {
          if (matchesJsonValue) expressionMatch = matchesJsonValue(line.value);
          else throw new PreviewError('INVALID_JMESPATH', error instanceof Error ? error.message : String(error));
        }
      }
      if (expressionMatch && (!filter || (line.value !== undefined && matchesFilter(line.value, filter, line.exactNumbers)))) {
        if (sortableMatches) sortableMatches.push({ index, value: line.value, exactNumbers: line.exactNumbers }); else matchedIndexes.push(index);
        if ((sortableMatches?.length ?? matchedIndexes.length) > maxQueryRows) throw new PreviewError('QUERY_CACHE_LIMIT', 'The query result exceeds the configured cache budget. Narrow the query or increase queryCacheMB.');
      }
      if (index % 512 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (sort && sortableMatches) {
      sortableMatches.sort((a, b) => 'by' in sort
        ? (sort.direction === 'asc' ? a.index - b.index : b.index - a.index)
        : compareForSort(a.value, b.value, sort, a.exactNumbers, b.exactNumbers) || a.index - b.index);
      for (const match of sortableMatches) matchedIndexes.push(match.index);
    }
    await this.ensureSourceUnchanged();
    this.storeQuery(queryId, matchedIndexes);
    return { scannedRows, matchedRows: matchedIndexes.length };
  }

  async page(queryId: string, offset: number, limit: number): Promise<JsonlRow[]> {
    await this.ensureSourceUnchanged();
    const queryRows = this.query(queryId).rows;
    const result: JsonlRow[] = []; let estimatedBytes = 0;
    for (let position = offset; position < Math.min(queryRows.length, offset + limit); position++) {
      const lineIndex = queryRows[position]!;
      const parsed = await this.parseLine(lineIndex);
      const meta = this.lines.get(lineIndex);
      const rawTruncated = parsed.raw.length > 16_384;
      const raw = rawTruncated ? `${parsed.raw.slice(0, 16_384)}…` : parsed.raw;
      const cells = Object.fromEntries(Object.entries(parsed.cells).map(([key, value]) => [key, previewValue(value)]));
      const row = { resultIndex: position + 1, physicalLine: meta.physicalLine, status: meta.status, raw, ...(rawTruncated ? { rawTruncated: true } : {}), cells, ...(parsed.diagnostic ? { error: parsed.diagnostic } : {}) } satisfies JsonlRow;
      const size = Buffer.byteLength(JSON.stringify(row)); if (result.length && estimatedBytes + size > 900 * 1024) break; estimatedBytes += size; result.push(row);
    }
    return result;
  }

  async recordText(physicalLine: number): Promise<string> {
    await this.ensureSourceUnchanged();
    const meta = this.lines.get(physicalLine - 1);
    let raw = new TextDecoder().decode(await this.bytes(meta));
    if (physicalLine === 1 && raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    await this.ensureSourceUnchanged();
    return raw;
  }

  async export(queryId: string, format: 'jsonl' | 'json', maxBytes: number): Promise<string> {
    await this.ensureSourceUnchanged();
    const raw: string[] = []; let bytes = format === 'json' ? 4 : 0;
    for (const index of this.query(queryId).rows) {
      const line = await this.parseLine(index, { cache: false, cells: false, exactNumbers: false }); if (line.value === undefined) continue;
      bytes += Buffer.byteLength(line.raw) + 3;
      if (bytes > maxBytes) throw new PreviewError('EXPORT_TOO_LARGE', `The export exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MB limit for this destination.`);
      raw.push(line.raw);
    }
    await this.ensureSourceUnchanged();
    return format === 'jsonl' ? `${raw.join('\n')}${raw.length ? '\n' : ''}` : `[\n${raw.map((line) => `  ${line}`).join(',\n')}\n]`;
  }

  async exportToFile(queryId: string, path: string, format: 'jsonl' | 'json'): Promise<{ records: number; bytes: number }> {
    await this.ensureSourceUnchanged();
    const target = await open(path, 'wx'); let bytes = 0, records = 0;
    const write = async (text: string) => { bytes += Buffer.byteLength(text); await target.write(text); };
    try {
      if (format === 'json') await write('[\n');
      for (const index of this.query(queryId).rows) {
        const line = await this.parseLine(index, { cache: false, cells: false, exactNumbers: false }); if (line.value === undefined) continue;
        if (format === 'json') await write(`${records ? ',\n' : ''}  ${line.raw}`); else await write(`${line.raw}\n`);
        records++;
      }
      if (format === 'json') await write('\n]\n'); await this.ensureSourceUnchanged(); await target.sync(); return { records, bytes };
    } finally { await target.close(); }
  }

  total(queryId = 'default'): number { return this.query(queryId).rows.length; }
  get sourceByteLength(): number { return this.byteLength; }
  get lineCount(): number { return this.lines.length; }
  lineMetadata(index: number): LineMeta { return this.lines.get(index); }
  get errorCount(): number {
    let count = 0;
    for (let index = 0; index < this.lines.length; index++) { const status = this.lines.get(index).status; if (status === 'invalid' || status === 'tooLarge' || (!this.settings.ignoreEmptyLines && status === 'empty')) count++; }
    return count;
  }
  async close(): Promise<void> { await this.file?.close(); this.cache.clear(); this.queries.clear(); this.cacheBytes = 0; this.queryBytes = 0; delete this.fileReadWindow; }
}
