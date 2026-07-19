import { applyEdits, findNodeAtOffset, format, getLocation, getNodeValue, parseTree, printParseErrorCode, type Node, type ParseError } from 'jsonc-parser';
import type { Diagnostic, JsonNodeView, RepairCandidate, Utf16Offset } from '../shared/types.js';
import type { PreviewSettings } from '../shared/settings.js';
import { search as jmespathSearch } from 'jmespath';
import { PreviewError } from '../shared/errors.js';
import { isPlainValueQuery, searchJsonValues } from './valueSearch.js';

export interface JsonDocument {
  text: string;
  root?: Node;
  nodes: Map<string, Node>;
  views: Map<string, JsonNodeView>;
  diagnostics: Diagnostic[];
  repairs: RepairCandidate[];
  queryable: boolean;
  queryValue?: unknown;
  queryValueReady?: boolean;
}

function lineColumn(text: string, offset: number): [number, number] {
  const before = text.slice(0, offset);
  const lastNewline = before.lastIndexOf('\n');
  return [before.split('\n').length, offset - lastNewline];
}

function pointerSegment(value: string): string { return value.replace(/~/g, '~0').replace(/\//g, '~1'); }
function jsonPathSegment(value: string): string { return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) ? `.${value}` : `.${JSON.stringify(value)}`; }
function nodeType(node: Node): JsonNodeView['type'] { return node.type as JsonNodeView['type']; }

function scalarDisplay(node: Node, text: string): Pick<JsonNodeView, 'displayValue' | 'rawText'> {
  if (node.type === 'object' || node.type === 'array') return {};
  const rawText = text.slice(node.offset, node.offset + node.length);
  if (node.type === 'string') return { displayValue: String(node.value), rawText };
  return { displayValue: rawText, rawText };
}

function registerView(document: JsonDocument, node: Node, pointer: string, jsonPath: string, key?: string, occurrence = 0, ambiguousPath = false): JsonNodeView {
  // Value-node spans are unique in a parse tree. A compact span id avoids a
  // crypto hash for every lazily materialized row and reduces message payloads.
  const id = `n${node.offset.toString(36)}-${node.length.toString(36)}-${occurrence.toString(36)}`;
  const existing = document.views.get(id);
  if (existing) return existing;
  const view: JsonNodeView = {
    nodeId: id,
    ...(key === undefined ? {} : { key }),
    type: nodeType(node),
    offset: node.offset as Utf16Offset,
    length: node.length,
    childrenCount: node.type === 'object' ? (node.children?.length ?? 0) : (node.children?.length ?? 0),
    pointer,
    jsonPath,
    ...scalarDisplay(node, document.text),
    ...(ambiguousPath ? { ambiguousPath: true } : {})
  };
  document.nodes.set(id, node);
  document.views.set(id, view);
  return view;
}

function collectDuplicateDiagnostics(document: JsonDocument, root: Node): void {
  const pending: Array<{ node: Node; depth: number }> = [{ node: root, depth: 1 }];
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (depth > 512) { document.queryable = false; continue; }
    if (node.type === 'object') {
    const occurrences = new Map<string, number>();
    for (const property of node.children ?? []) {
      const propertyKey = String(property.children?.[0]?.value ?? '');
      const value = property.children?.[1];
      if (!value) continue;
      occurrences.set(propertyKey, (occurrences.get(propertyKey) ?? 0) + 1);
      pending.push({ node: value, depth: depth + 1 });
    }
    for (const [name, count] of occurrences) {
      if (count > 1) {
        const property = node.children?.find((item) => item.children?.[0]?.value === name);
        const offset = property?.children?.[0]?.offset ?? node.offset;
        const [line, column] = lineColumn(document.text, offset);
        document.diagnostics.push({ code: 'duplicate-key', message: `Duplicate object key: ${name}`, line, column, offset, length: name.length, severity: 'warning' });
      }
    }
    } else if (node.type === 'array') {
      for (const child of node.children ?? []) pending.push({ node: child, depth: depth + 1 });
    }
  }
}

function diagnostics(text: string, errors: ParseError[]): Diagnostic[] {
  return errors.map((error) => {
    const [line, column] = lineColumn(text, error.offset);
    return { code: printParseErrorCode(error.error), message: printParseErrorCode(error.error), line, column, offset: error.offset, length: error.length, severity: 'error' as const };
  });
}

function repairCandidates(text: string, errors: ParseError[], settings: PreviewSettings): RepairCandidate[] {
  if (errors.length === 0 || errors.length > 4) return [];
  const candidates: Array<{ title: string; offset: number; length: number; insert: string }> = [];
  const trimmed = text.trimEnd();
  const stack: string[] = [];
  let inString = false, escaped = false;
  for (let index = 0; index < trimmed.length; index++) {
    const char = trimmed[index]!;
    if (inString) {
      if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === '{' || char === '[') stack.push(char);
    else if ((char === '}' && stack.at(-1) === '{') || (char === ']' && stack.at(-1) === '[')) stack.pop();
  }
  if (!inString && stack.length > 0) {
    const insert = stack.reverse().map((char) => char === '{' ? '}' : ']').join('');
    candidates.push({ title: `Insert missing closing ${insert}`, offset: trimmed.length, length: 0, insert });
  }
  const trailing = /,\s*([}\]])/.exec(text);
  if (trailing) candidates.push({ title: 'Remove trailing comma', offset: trailing.index, length: 1, insert: '' });
  return candidates.flatMap((candidate, index) => {
    const result = text.slice(0, candidate.offset) + candidate.insert + text.slice(candidate.offset + candidate.length);
    const nextErrors: ParseError[] = [];
    parseTree(result, nextErrors, { allowTrailingComma: settings.allowTrailingComma, disallowComments: !settings.allowComments });
    if (nextErrors.length >= errors.length) return [];
    return [{ id: `repair-${index}`, title: candidate.title, offset: candidate.offset, length: candidate.length, text: candidate.insert, result }];
  });
}

export function parseJsonDocument(text: string, settings: PreviewSettings): JsonDocument {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { allowTrailingComma: settings.allowTrailingComma, disallowComments: !settings.allowComments });
  const document: JsonDocument = { text, ...(root ? { root } : {}), nodes: new Map(), views: new Map(), diagnostics: diagnostics(text, errors), repairs: [], queryable: true };
  if (root) { registerView(document, root, '', '@'); collectDuplicateDiagnostics(document, root); }
  if (!document.queryable) document.diagnostics.push({ code: 'maximum-depth', message: 'The JSON exceeds the safe query depth; browsing remains available but search is disabled.', line: 1, column: 1, offset: 0, length: 0, severity: 'warning' });
  document.repairs = repairCandidates(text, errors, settings);
  return document;
}

export function childrenOf(document: JsonDocument, nodeId: string, offset: number, limit: number): JsonNodeView[] {
  const parent = document.nodes.get(nodeId);
  if (!parent) return [];
  const parentView = document.views.get(nodeId);
  if (!parentView) return [];
  if (parent.type === 'object') {
    const counts = new Map<string, number>();
    for (const property of parent.children ?? []) {
      const key = String(property.children?.[0]?.value ?? ''); counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const occurrences = new Map<string, number>();
    for (const property of (parent.children ?? []).slice(0, offset)) {
      const key = String(property.children?.[0]?.value ?? ''); occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
    }
    return (parent.children ?? []).slice(offset, offset + limit).flatMap((property) => {
      const key = String(property.children?.[0]?.value ?? '');
      const occurrence = occurrences.get(key) ?? 0;
      occurrences.set(key, occurrence + 1);
      const child = property.children?.[1];
      return child ? [registerView(document, child, `${parentView.pointer}/${pointerSegment(key)}`, `${parentView.jsonPath}${jsonPathSegment(key)}`, key, occurrence, (counts.get(key) ?? 0) > 1)] : [];
    });
  }
  if (parent.type === 'array') return (parent.children ?? []).slice(offset, offset + limit).map((child, index) => {
    const absoluteIndex = offset + index;
    return registerView(document, child, `${parentView.pointer}/${absoluteIndex}`, `${parentView.jsonPath}[${absoluteIndex}]`, String(absoluteIndex));
  });
  return [];
}

export function rootView(document: JsonDocument): JsonNodeView | undefined {
  if (!document.root) return undefined;
  return [...document.views.values()].find((view) => view.offset === document.root?.offset);
}

export function formatJson(text: string, indent: number): string {
  return applyEdits(text, format(text, undefined, { tabSize: indent, insertSpaces: true, eol: text.includes('\r\n') ? '\r\n' : '\n', keepLines: false }));
}

export function formatJsonEdits(text: string, indent: number): Array<{ offset: number; length: number; text: string }> {
  return format(text, undefined, { tabSize: indent, insertSpaces: true, eol: text.includes('\r\n') ? '\r\n' : '\n', keepLines: false }).map((edit) => ({ offset: edit.offset, length: edit.length, text: edit.content }));
}

export function nodeAt(document: JsonDocument, offset: number): JsonNodeView | undefined {
  const node = document.root ? findNodeAtOffset(document.root, offset, true) : undefined;
  return node ? [...document.views.values()].find((view) => view.offset === node.offset) : undefined;
}

export function locationPath(text: string, offset: number): Array<string | number> { return getLocation(text, offset).path; }

export function nodeText(document: JsonDocument, nodeId: string, style: 'raw' | 'compact' | 'pretty'): string {
  const node = document.nodes.get(nodeId); if (!node) throw new Error('JSON node no longer exists.');
  const raw = document.text.slice(node.offset, node.offset + node.length); if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error('Copying a node larger than 1 MB is disabled; open the source instead.');
  if (style === 'raw') return raw;
  return applyEdits(raw, format(raw, undefined, { tabSize: style === 'pretty' ? 2 : 0, insertSpaces: true, eol: '\n' }));
}

export function queryJson(document: JsonDocument, expression: string): { result: unknown } {
  if (!document.root) return { result: null };
  if (!document.queryable) throw new PreviewError('MAXIMUM_DEPTH', 'Search is disabled because the JSON exceeds the safe query depth.');
  let result: unknown;
  // jsonc-parser's getNodeValue recursively rebuilds the complete object. Keep
  // that immutable projection for the session so consecutive debounced searches
  // do not pay the O(document size) materialization cost each time.
  if (!document.queryValueReady) {
    document.queryValue = getNodeValue(document.root);
    document.queryValueReady = true;
  }
  const rootValue = document.queryValue;
  try { result = jmespathSearch(rootValue, expression); }
  catch (error) {
    if (!isPlainValueQuery(expression)) throw new PreviewError('INVALID_JMESPATH', error instanceof Error ? error.message : String(error));
    result = searchJsonValues(rootValue, expression);
  }
  // A plain value such as `Ada`, `42`, or `true` is also a useful search term.
  // JMESPath treats many of these as field names (and returns null), so fall
  // back to a recursive value search when no projection was found.
  if (result === null && isPlainValueQuery(expression)) result = searchJsonValues(rootValue, expression);
  const encoded = JSON.stringify(result);
  if (encoded && Buffer.byteLength(encoded) > 1024 * 1024) throw new PreviewError('QUERY_RESULT_TOO_LARGE', 'JMESPath result exceeds the 1 MB preview limit. Narrow the expression.');
  return { result };
}
