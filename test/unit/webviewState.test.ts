import type { JsonNodeView, JsonlRow, SessionSummary } from '../../src/shared/types.js';
import { createInitialState, reducer, sanitizeViewState } from '../../src/webview/state.js';
import { describe, expect, it } from 'vitest';

const summary = { kind: 'jsonl', revision: 'v1', byteLength: 100, parseMilliseconds: 2, errors: 0, recordCount: 2, fields: ['name'] } satisfies SessionSummary;
const rows: JsonlRow[] = [{ resultIndex: 1, physicalLine: 1, status: 'valid', raw: '{"name":"Ada"}', cells: { name: 'Ada' } }];

describe('webview state reducer', () => {
  it('sanitizes persisted state before rendering', () => {
    expect(sanitizeViewState({ query: 42, sort: { field: [], direction: 'sideways' }, columns: ['ok', 1, 'x'.repeat(513)] })).toEqual({ columns: ['ok'] });
    expect(sanitizeViewState({ sort: null })).toEqual({ sort: null });
    expect(sanitizeViewState({ columnWidths: { name: 243.6, tooSmall: 20, tooLarge: 1201, invalid: '180', [String('x').repeat(513)]: 180 } }))
      .toEqual({ columnWidths: { name: 244 } });
  });
  it('rejects a page from an older query revision', () => {
    let state = reducer(createInitialState(), { type: 'init', summary });
    state = reducer(state, { type: 'startQuery', queryRevision: 2 });
    state = reducer(state, { type: 'page', queryRevision: 1, offset: 0, page: { rows, total: 1, scannedRows: 1, matchedRows: 1, isComplete: true } });
    expect(state.page.rows).toEqual([]);
    expect(state.page.loaded).toBe(false);
  });

  it('updates known error progress from accepted pages', () => {
    let state = reducer(createInitialState(), { type: 'init', summary: { ...summary, errorsComplete: false } });
    state = reducer(state, { type: 'startQuery', queryRevision: 1 });
    state = reducer(state, { type: 'page', queryRevision: 1, offset: 0, page: { rows, total: 1, scannedRows: 1, matchedRows: 1, isComplete: true, errors: 1, errorsComplete: true } });
    expect(state.summary).toEqual(expect.objectContaining({ errors: 1, errorsComplete: true }));
  });

  it('can clear a custom sort and restore the original order', () => {
    let state = createInitialState({ sort: { field: 'name', direction: 'desc' } });
    state = reducer(state, { type: 'setSort' });
    expect(state.view.sort).toBeNull();
    expect(state.view).toEqual({ sort: null });
  });

  it('stores resized JSONL column widths in the view state', () => {
    const state = reducer(createInitialState(), { type: 'setColumnWidths', columnWidths: { name: 320 } });
    expect(state.view.columnWidths).toEqual({ name: 320 });
  });

  it('clears a search error when the query changes', () => {
    let state = reducer(createInitialState(), { type: 'error', message: 'Invalid JMESPath' });
    state = reducer(state, { type: 'setQuery', query: 'valid' });
    expect(state.error).toBeUndefined();
  });

  it('defaults to timestamp ascending while preserving an explicit index order', () => {
    const timestampSummary = { ...summary, fields: ['name', 'timestamp'] };
    const defaultState = reducer(createInitialState(), { type: 'init', summary: timestampSummary });
    expect(defaultState.view.sort).toEqual({ field: 'timestamp', direction: 'asc' });

    const indexState = reducer(createInitialState({ sort: null }), { type: 'init', summary: timestampSummary });
    expect(indexState.view.sort).toBeNull();
  });

  it('drops a persisted sort whose field no longer exists', () => {
    const state = reducer(createInitialState({ sort: { field: 'a.b', direction: 'asc' } }), { type: 'init', summary: { ...summary, fields: ['["a.b"]'] } });
    expect(state.view.sort).toBeUndefined();
  });

  it('rejects an older page navigation response within the same query', () => {
    let state = reducer(createInitialState(), { type: 'init', summary });
    state = reducer(state, { type: 'startQuery', queryRevision: 3 });
    state = reducer(state, { type: 'requestPage', offset: 100 });
    state = reducer(state, { type: 'requestPage', offset: 200 });
    state = reducer(state, { type: 'page', queryRevision: 3, offset: 100, page: { rows, total: 300, scannedRows: 300, matchedRows: 300, isComplete: true } });
    expect(state.page.offset).toBe(0);
    state = reducer(state, { type: 'page', queryRevision: 3, offset: 200, page: { rows, total: 300, scannedRows: 300, matchedRows: 300, isComplete: true } });
    expect(state.page.offset).toBe(200);
    expect(state.page.loaded).toBe(true);
  });

  it('ignores children from a previous tree generation', () => {
    const root = node('root', 1);
    let state = reducer(createInitialState(), { type: 'init', summary: { ...summary, kind: 'json', root } });
    const staleGeneration = state.tree.generation;
    state = reducer(state, { type: 'init', summary: { ...summary, kind: 'json', revision: 'v2', root } });
    state = reducer(state, { type: 'treeChildren', generation: staleGeneration, parentId: root.nodeId, offset: 0, nodes: [node('stale', 0)] });
    expect(state.tree.nodes.stale).toBeUndefined();
  });

  it('keeps expansion state immutable and explicit', () => {
    const root = node('root', 1);
    let state = reducer(createInitialState(), { type: 'init', summary: { ...summary, kind: 'json', root } });
    const before = state.tree.expanded;
    state = reducer(state, { type: 'toggleNode', nodeId: root.nodeId, open: false });
    expect(state.tree.expanded).not.toBe(before);
    expect(state.tree.expanded.has(root.nodeId)).toBe(false);
    expect(before.has(root.nodeId)).toBe(true);
  });

  it('opens only the root of a large JSON tree until the user expands more', () => {
    const root = node('root', 5);
    const state = reducer(createInitialState(), { type: 'init', summary: { ...summary, kind: 'json', byteLength: 300 * 1024, root } });
    expect(state.tree.mode).toBe('collapsed');
    expect(state.tree.expanded).toEqual(new Set(['root']));
  });

  it('stops loading a node after the host returns an empty child page', () => {
    const root = node('root', 3);
    let state = reducer(createInitialState(), { type: 'init', summary: { ...summary, kind: 'json', root } });
    state = reducer(state, { type: 'treeLoading', nodeId: root.nodeId });
    state = reducer(state, { type: 'treeChildren', generation: state.tree.generation, parentId: root.nodeId, offset: 0, nodes: [] });
    expect(state.tree.loadedCount[root.nodeId]).toBe(root.childrenCount);
    expect(state.tree.loading.has(root.nodeId)).toBe(false);
  });

});

function node(nodeId: string, childrenCount: number): JsonNodeView {
  return { nodeId, type: childrenCount ? 'object' : 'string', offset: 0 as JsonNodeView['offset'], length: 1, childrenCount, pointer: '', jsonPath: '@', ...(childrenCount ? {} : { displayValue: 'value' }) };
}
