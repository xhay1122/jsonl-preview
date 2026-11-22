import { compile, search } from 'jmespath';
import { timestampLabel, type TimeDisplayOptions } from './dateTime.js';
import { PreviewError } from './errors.js';

export type JsonSearchMode = 'filter' | 'reveal';
export type JsonSearchDefault = JsonSearchMode | 'remember';
export type JsonSearchPreferences = { defaultMode: JsonSearchDefault; lastMode: JsonSearchMode };
export type MatchRange = { start: number; end: number };
export type MatchGroup<T> = { node: T; first: number };

export function isJsonSearchMode(value: unknown): value is JsonSearchMode {
  return value === 'filter' || value === 'reveal';
}

export function literalMatches(query: string): (text: string) => IterableIterator<MatchRange> {
  const expression = query ? new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu') : undefined;
  return function* (text) {
    if (!expression) return;
    for (const match of text.matchAll(expression)) yield { start: match.index, end: match.index + match[0].length };
  };
}

export function scalarMatches(query: string): (text: string, value: unknown) => IterableIterator<MatchRange> {
  const trimmed = query.trim();
  let needle: unknown = trimmed;
  try { needle = JSON.parse(trimmed); } catch { /* search ordinary text as entered */ }
  if (needle === null || typeof needle === 'boolean') {
    return function* (text, value) {
      if (value === needle) yield { start: 0, end: text.length };
    };
  }
  return literalMatches(typeof needle === 'string' ? needle : trimmed);
}

export function* scalarRanges(match: ReturnType<typeof scalarMatches>, text: string, value: unknown,
  field: string | undefined, time: TimeDisplayOptions): IterableIterator<MatchRange> {
  yield* match(text, value);
  const label = timestampLabel(value, field, time)?.text;
  if (label) yield* match(label, label);
}

export function matchGroupAt<T>(groups: readonly MatchGroup<T>[], index: number): MatchGroup<T> | undefined {
  let low = 0, high = groups.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (groups[middle]!.first <= index) low = middle + 1;
    else high = middle;
  }
  return groups[low - 1];
}

export function isPlainValueQuery(query: string): boolean {
  const trimmed = query.trim();
  if (!trimmed) return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed === null || typeof parsed !== 'object';
  } catch {
    return !/[\[\]{}|&?*`]/.test(trimmed);
  }
}

export function queryProjection(getValue: () => unknown, expression: string): { result: unknown } | undefined {
  const query = expression.trim();
  const structured = !isPlainValueQuery(query) || /^[A-Za-z_]\w*\s*\(/.test(query);
  try {
    // Parsing first avoids materializing a document for ordinary text that
    // cannot be an expression.
    const ast = compile(query) as { type: string; name?: string };
    const root = getValue();
    const result = search(root, query);
    if (result !== null || ast.type !== 'Field'
      || (root !== null && typeof root === 'object' && ast.name !== undefined && Object.hasOwn(root, ast.name))) {
      return { result: result ?? null };
    }
  } catch (error) {
    if (structured) throw new PreviewError('INVALID_JMESPATH', error instanceof Error ? error.message : String(error));
  }
  return undefined;
}

export function checkQueryResultSize(result: unknown): void {
  const encoded = JSON.stringify(result);
  if (encoded && new TextEncoder().encode(encoded).byteLength > 1024 * 1024) {
    throw new PreviewError('QUERY_RESULT_TOO_LARGE', 'Query result exceeds the 1 MB preview limit. Narrow the search.');
  }
}
