import type { JsonNodeView, JsonlRow, JsonSearchData } from '../shared/types.js';
import type { JsonSearchMode, JsonSearchPreferences } from '../shared/jsonSearch.js';
import type { SortState, ViewState, WebviewSummary } from './protocol.js';

export interface TreeState {
  generation: number;
  nodes: Record<string, JsonNodeView>;
  children: Record<string, string[]>;
  loadedCount: Record<string, number>;
  expanded: Set<string>;
  manuallyCollapsed: Set<string>;
  loading: Set<string>;
  mode: 'expanded' | 'collapsed';
}

export interface PageState {
  rows: JsonlRow[];
  total: number;
  offset: number;
  loaded: boolean;
  scannedRows: number;
  matchedRows: number;
  isComplete: boolean;
  errors?: number;
  errorsComplete?: boolean;
}

export interface AppState {
  summary: WebviewSummary | undefined;
  view: ViewState;
  queryRevision: number;
  searchRevision: number;
  searchMode: JsonSearchMode;
  searchPreferences: JsonSearchPreferences;
  requestedOffset: number;
  page: PageState;
  tree: TreeState;
  searchResult: ({ query: string } & JsonSearchData) | undefined;
  searchError: string | undefined;
  progressRecords: number | undefined;
  error: string | undefined;
}

export type Action =
  | { type: 'init'; summary: WebviewSummary; view?: ViewState; searchPreferences?: JsonSearchPreferences }
  | { type: 'setQuery'; query: string }
  | { type: 'setSort'; sort?: SortState }
  | { type: 'setColumnWidths'; columnWidths: Record<string, number> }
  | { type: 'startQuery'; queryRevision: number }
  | { type: 'requestPage'; offset: number }
  | { type: 'startSearch'; searchRevision: number }
  | { type: 'setSearchMode'; mode: JsonSearchMode }
  | { type: 'searchPreferences'; preferences: JsonSearchPreferences }
  | { type: 'page'; queryRevision: number; offset: number; page: Omit<PageState, 'offset' | 'loaded'> }
  | ({ type: 'search'; searchRevision: number; query: string } & JsonSearchData)
  | { type: 'searchError'; searchRevision: number; message: string }
  | { type: 'treeLoading'; nodeId: string }
  | { type: 'treeChildren'; generation: number; parentId: string; offset: number; nodes: JsonNodeView[] }
  | { type: 'toggleNode'; nodeId: string; open: boolean }
  | { type: 'treeMode'; mode: TreeState['mode'] }
  | { type: 'progress'; records: number }
  | { type: 'error'; message: string }
  | { type: 'clearError' };

const emptyPage: PageState = { rows: [], total: 0, offset: 0, loaded: false, scannedRows: 0, matchedRows: 0, isComplete: true };
const defaultSearchPreferences: JsonSearchPreferences = { defaultMode: 'remember', lastMode: 'filter' };

export function initialSearchMode(preferences: JsonSearchPreferences): JsonSearchMode {
  return preferences.defaultMode === 'remember' ? preferences.lastMode : preferences.defaultMode;
}
// Expanding a JSON tree is intentionally eager for small documents because it
// makes them pleasant to inspect. On wider real-world files (package-lock.json
// is a common example), eager expansion fans out into hundreds of host requests
// and React nodes before the user has interacted with the tree.
export const EAGER_TREE_MAX_BYTES = 200 * 1024;

export function sanitizeViewState(value: unknown): ViewState {
  if (!value || typeof value !== 'object') return {};
  const input = value as Record<string, unknown>;
  const query = typeof input.query === 'string' ? input.query.slice(0, 1024) : undefined;
  const rawSort = input.sort && typeof input.sort === 'object' ? input.sort as Record<string, unknown> : undefined;
  const sort: SortState | null | undefined = input.sort === null
    ? null
    : rawSort && typeof rawSort.field === 'string' && rawSort.field.length <= 2048 && (rawSort.direction === 'asc' || rawSort.direction === 'desc')
      ? { field: rawSort.field, direction: rawSort.direction }
      : undefined;
  const columns = Array.isArray(input.columns) ? input.columns.filter((column): column is string => typeof column === 'string' && column.length <= 512).slice(0, 200) : undefined;
  const rawColumnWidths = input.columnWidths && typeof input.columnWidths === 'object' && !Array.isArray(input.columnWidths)
    ? input.columnWidths as Record<string, unknown>
    : undefined;
  const columnWidths = rawColumnWidths
    ? Object.fromEntries(Object.entries(rawColumnWidths)
      .filter(([key, width]) => key.length > 0 && key.length <= 512 && typeof width === 'number' && Number.isFinite(width) && width >= 60 && width <= 1200)
      .slice(0, 200)
      .map(([key, width]) => [key, Math.round(width as number)]))
    : undefined;
  return {
    ...(query === undefined ? {} : { query }),
    ...(sort === undefined ? {} : { sort }),
    ...(columns ? { columns } : {}),
    ...(columnWidths && Object.keys(columnWidths).length ? { columnWidths } : {})
  };
}

function initialTree(summary?: WebviewSummary, generation = 0): TreeState {
  const nodes: Record<string, JsonNodeView> = {};
  const children: Record<string, string[]> = {};
  const loadedCount: Record<string, number> = {};
  if (summary?.root) {
    nodes[summary.root.nodeId] = summary.root;
    const initial = summary.children ?? [];
    for (const node of initial) nodes[node.nodeId] = node;
    children[summary.root.nodeId] = initial.map((node) => node.nodeId);
    loadedCount[summary.root.nodeId] = initial.length;
  }
  return {
    generation,
    nodes,
    children,
    loadedCount,
    expanded: new Set(summary?.root ? [summary.root.nodeId] : []),
    manuallyCollapsed: new Set(),
    loading: new Set(),
    mode: summary && summary.byteLength > EAGER_TREE_MAX_BYTES ? 'collapsed' : 'expanded'
  };
}

export function createInitialState(view: ViewState = {}): AppState {
  return { summary: undefined, view: sanitizeViewState(view), queryRevision: 0, searchRevision: 0, searchMode: 'filter', searchPreferences: defaultSearchPreferences, requestedOffset: 0, page: emptyPage, tree: initialTree(), searchResult: undefined, searchError: undefined, progressRecords: undefined, error: undefined };
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'init': {
      const restoredView = sanitizeViewState({ ...state.view, ...sanitizeViewState(action.view) });
      const availableFields = new Set(action.summary.fields ?? []);
      let view = restoredView;
      if (restoredView.sort && restoredView.sort.field !== '\u0000physicalLine' && !availableFields.has(restoredView.sort.field)) {
        const { sort: _invalidSort, ...validView } = restoredView;
        view = validView;
      }
      const timestampField = action.summary.kind === 'jsonl'
        ? action.summary.fields?.find((field) => field.toLowerCase() === 'timestamp')
        : undefined;
      const initializedView = view.sort === undefined && timestampField
        ? { ...view, sort: { field: timestampField, direction: 'asc' } as const }
        : view;
      const searchPreferences = action.searchPreferences ?? state.searchPreferences;
      return {
        ...state,
        summary: action.summary,
        view: initializedView,
        requestedOffset: 0,
        page: emptyPage,
        searchResult: undefined,
        searchError: undefined,
        searchPreferences,
        searchMode: state.summary ? state.searchMode : initialSearchMode(searchPreferences),
        tree: initialTree(action.summary, state.tree.generation + 1),
        error: undefined
      };
    }
    case 'setQuery': return { ...state, view: { ...state.view, query: action.query }, searchResult: undefined, searchError: undefined, error: undefined };
    case 'setSort': {
      return { ...state, view: { ...state.view, sort: action.sort ?? null } };
    }
    case 'setColumnWidths':
      return { ...state, view: { ...state.view, columnWidths: action.columnWidths } };
    case 'startQuery': return { ...state, queryRevision: action.queryRevision, requestedOffset: 0, page: { ...state.page, offset: 0 } };
    case 'requestPage': return { ...state, requestedOffset: action.offset };
    case 'startSearch': return { ...state, searchRevision: action.searchRevision };
    case 'setSearchMode': return {
      ...state, searchMode: action.mode, searchPreferences: { ...state.searchPreferences, lastMode: action.mode },
      searchResult: undefined, searchError: undefined
    };
    case 'searchPreferences': return { ...state, searchPreferences: action.preferences };
    case 'page': {
      if (action.queryRevision !== state.queryRevision || action.offset !== state.requestedOffset) return state;
      let summary = state.summary;
      if (summary && action.page.errors !== undefined
        && (summary.errors !== action.page.errors || action.page.errorsComplete !== undefined && summary.errorsComplete !== action.page.errorsComplete)) {
        summary = { ...summary, errors: action.page.errors, ...(action.page.errorsComplete === undefined ? {} : { errorsComplete: action.page.errorsComplete }) };
      }
      return {
        ...state,
        summary,
        page: { ...action.page, offset: action.offset, loaded: true },
        progressRecords: undefined
      };
    }
    case 'search': {
      if (action.searchRevision !== state.searchRevision) return state;
      const { type: _type, searchRevision: _revision, ...result } = action;
      return { ...state, searchResult: result, searchError: undefined };
    }
    case 'searchError':
      if (action.searchRevision !== state.searchRevision) return state;
      return { ...state, searchResult: undefined, searchError: action.message };
    case 'treeLoading': {
      const loading = new Set(state.tree.loading); loading.add(action.nodeId);
      return { ...state, tree: { ...state.tree, loading } };
    }
    case 'treeChildren': {
      if (action.generation !== state.tree.generation) return state;
      const nodes = { ...state.tree.nodes };
      for (const node of action.nodes) nodes[node.nodeId] = node;
      const current = action.offset === 0 ? [] : [...(state.tree.children[action.parentId] ?? [])];
      const known = new Set(current);
      for (const node of action.nodes) if (!known.has(node.nodeId)) { current.push(node.nodeId); known.add(node.nodeId); }
      const loading = new Set(state.tree.loading); loading.delete(action.parentId);
      // An empty page means the host has no more children. Treat it as terminal
      // even if a malformed document reported a larger childrenCount; otherwise
      // an expanded node requests the same empty page forever.
      const loadedCount = action.nodes.length === 0
        ? (state.tree.nodes[action.parentId]?.childrenCount ?? action.offset)
        : Math.max(state.tree.loadedCount[action.parentId] ?? 0, action.offset + action.nodes.length);
      return {
        ...state,
        tree: {
          ...state.tree,
          nodes,
          children: { ...state.tree.children, [action.parentId]: current },
          loadedCount: { ...state.tree.loadedCount, [action.parentId]: loadedCount },
          loading
        }
      };
    }
    case 'toggleNode': {
      const expanded = new Set(state.tree.expanded), manuallyCollapsed = new Set(state.tree.manuallyCollapsed);
      if (action.open) { expanded.add(action.nodeId); manuallyCollapsed.delete(action.nodeId); }
      else { expanded.delete(action.nodeId); manuallyCollapsed.add(action.nodeId); }
      return { ...state, tree: { ...state.tree, expanded, manuallyCollapsed } };
    }
    case 'treeMode': return {
      ...state,
      tree: {
        ...state.tree,
        mode: action.mode,
        expanded: new Set(),
        manuallyCollapsed: action.mode === 'expanded' ? new Set() : state.tree.manuallyCollapsed
      }
    };
    case 'progress': return { ...state, progressRecords: action.records };
    case 'error': return { ...state, requestedOffset: state.page.offset, error: action.message, tree: { ...state.tree, loading: new Set() } };
    case 'clearError': return { ...state, error: undefined };
  }
}
