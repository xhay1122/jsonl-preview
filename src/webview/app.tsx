import { memo, useCallback, useEffect, useReducer, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import Button from 'tdesign-react/es/button';
import Drawer from 'tdesign-react/es/drawer';
import Input from 'tdesign-react/es/input';
import Table, { type PrimaryTableCol, type TableSort } from 'tdesign-react/es/table';
import ChevronRightIcon from 'tdesign-icons-react/esm/components/chevron-right';
import CodeIcon from 'tdesign-icons-react/esm/components/code';
import CopyIcon from 'tdesign-icons-react/esm/components/copy';
import FileExportIcon from 'tdesign-icons-react/esm/components/file-export';
import FormatPainterIcon from 'tdesign-icons-react/esm/components/format-painter';
import KeyIcon from 'tdesign-icons-react/esm/components/key';
import SearchIcon from 'tdesign-icons-react/esm/components/search';
import TabIcon from 'tdesign-icons-react/esm/components/tab';
import ToolsIcon from 'tdesign-icons-react/esm/components/tools';
import { BrandIcon } from './brandIcon';
import type { JsonNodeView, JsonlRow } from '../shared/types.js';
import { createInitialState, reducer, type AppState, type TreeState } from './state.js';
import { isHostMessage, type HostMessage, type SortState, type WebviewSummary } from './protocol.js';
import { send, vscode } from './bridge.js';
import { setLocale, tr } from './i18n.js';
function jsonText(value: unknown, pretty = true): string {
  const result = JSON.stringify(value, null, pretty ? 2 : 0);
  return result === undefined ? String(value) : result;
}
function valueKind(value: unknown): string { return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value; }
function isContainer(value: unknown): value is Record<string, unknown> | unknown[] { return value !== null && typeof value === 'object'; }
function isLong(text: string): boolean { return text.length > 120 || text.includes('\n'); }
function formatBytes(bytes: number): string { return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
function maxAutoDepth(summary: WebviewSummary): number {
  const value = Number(summary.maxAutoExpandDepth);
  return Number.isInteger(value) && value > 0 ? value : 10;
}
const PHYSICAL_LINE_SORT = '\u0000physicalLine';
const ERROR_TOAST_DURATION_MS = 4000;
function sortSpec(sort?: SortState | null): { path: string; direction: 'asc' | 'desc' } | { by: 'physicalLine'; direction: 'asc' | 'desc' } | undefined {
  if (!sort) return undefined;
  if (sort.field === PHYSICAL_LINE_SORT) return sort.direction === 'asc' ? undefined : { by: 'physicalLine', direction: 'desc' };
  return { path: '/' + sort.field.split('.').map((part) => part.replace(/~/g, '~0').replace(/\//g, '~1')).join('/'), direction: sort.direction };
}
function temporaryText(value: unknown): string {
  if (typeof value === 'string') { try { return jsonText(JSON.parse(value)); } catch { return jsonText(value); } }
  return jsonText(value);
}

function displayValue(value: unknown, summary: WebviewSummary): { text: string; title?: string } {
  if (value === undefined) return { text: '—' };
  if (value === null) return { text: 'null' };
  let milliseconds: number | undefined;
  if (typeof value === 'number' && Number.isInteger(value)) {
    const digits = String(Math.abs(value)).length;
    if (digits === 10) milliseconds = value * 1000;
    else if (digits === 13) milliseconds = value;
  } else if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) return { text: value, title: tr('timezoneUnknown') };
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) milliseconds = parsed;
  }
  if (milliseconds !== undefined) {
    try {
      const options: Intl.DateTimeFormatOptions = {
        dateStyle: 'medium', timeStyle: 'medium',
        ...(summary.timezone && summary.timezone !== 'system' ? { timeZone: summary.timezone } : {})
      };
      return { text: new Intl.DateTimeFormat(undefined, options).format(new Date(milliseconds)), title: String(value) };
    } catch { /* keep the original value */ }
  }
  if (typeof value === 'string') return { text: value };
  return { text: isContainer(value) ? jsonText(value, false) : String(value) };
}

interface MenuItem { label: string; action(): void; icon?: ReactNode }
interface MenuState { x: number; y: number; items: MenuItem[] }
interface DrawerState { title: string; value?: unknown; text?: string; actions?: ReactNode; physicalLine?: number; loading?: boolean }

function DrawerHeader({ title, actions }: { title: string; actions?: ReactNode }): ReactNode {
  return <div className="drawer-header-content"><span className="drawer-title">{title}</span>{actions && <div className="drawer-header-actions">{actions}</div>}</div>;
}

function ContextMenu({ menu, close }: { menu: MenuState; close(): void }): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onPointer = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) close(); };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') { close(); return; }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
      const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
      if (!buttons.length) return;
      event.preventDefault();
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : current < 0 ? (event.key === 'ArrowDown' ? 0 : buttons.length - 1)
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    };
    document.addEventListener('mousedown', onPointer); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onPointer); document.removeEventListener('keydown', onKey); };
  }, [close]);
  const style: CSSProperties = { left: Math.max(8, Math.min(menu.x, innerWidth - 228)), top: Math.max(8, Math.min(menu.y, innerHeight - menu.items.length * 38 - 16)) };
  return <div ref={ref} className="context-menu" role="menu" style={style}>
    {menu.items.map((item) => <button key={item.label} type="button" className="menu-item" role="menuitem" onClick={() => { close(); item.action(); }}>
      {item.icon}<span>{item.label}</span>
    </button>)}
  </div>;
}

function ValueTree({ value, label = '@', level = 1, initiallyExpanded = true, maxDepth = 10, jsonPath, onMenu, onLongText }: {
  value: unknown; label?: string; level?: number; initiallyExpanded?: boolean; maxDepth?: number; jsonPath?: string;
  onMenu?(event: React.MouseEvent, key: string | undefined, value: unknown, path?: string): void;
  onLongText?(text: string): void;
}): ReactNode {
  const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item] as const) : isContainer(value) ? Object.entries(value) : [];
  const expandable = entries.length > 0;
  const [open, setOpen] = useState(expandable && initiallyExpanded && level <= maxDepth);
  const shown = typeof value === 'string' ? value : value === null ? 'null' : isContainer(value) ? '' : String(value);
  const longText = !expandable && typeof value === 'string' && isLong(value);
  const childPath = (key: string) => jsonPath === undefined ? undefined : Array.isArray(value) ? `${jsonPath}[${key}]` : `${jsonPath}${/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? `.${key}` : `.${JSON.stringify(key)}`}`;
  const toggle = () => { if (expandable) setOpen((current) => !current); };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!expandable) return;
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); }
    if (event.key === 'ArrowRight' && !open) { event.preventDefault(); setOpen(true); }
    if (event.key === 'ArrowLeft' && open) { event.preventDefault(); setOpen(false); }
  };
  return <>
    <div className={`tree-row ${expandable ? 'expandable' : ''}`} role="treeitem" aria-level={level} aria-expanded={expandable ? open : undefined} tabIndex={0}
      style={{ '--level': level - 1 } as CSSProperties} onClick={toggle} onKeyDown={onKeyDown}
      onContextMenu={(event) => { event.preventDefault(); onMenu?.(event, label === '@' ? undefined : label, value, jsonPath); }}>
      <ChevronRightIcon className={`chevron ${open ? 'open' : ''}`} aria-hidden />
      <span className="json-key">{label}</span>
      {expandable ? <span className={`shape shape-${valueKind(value)}`}>{Array.isArray(value) ? '[ ]' : '{ }'}&nbsp; {entries.length}</span> : <span className={`json-value value-${valueKind(value)} ${longText ? 'long-value' : ''}`} title={shown}>{shown}</span>}
      {longText && <button className="inline-action" type="button" onClick={(event) => { event.stopPropagation(); onLongText?.(value); }}>{tr('expand')}</button>}
    </div>
    {open && <div role="group">{entries.map(([key, child]) => <ValueTree key={key} value={child} label={key} level={level + 1} initiallyExpanded={initiallyExpanded} maxDepth={maxDepth} jsonPath={childPath(key)} onMenu={onMenu} onLongText={onLongText} />)}</div>}
  </>;
}

interface ServerTreeNodeProps {
  nodeId: string; level: number; tree: TreeState; summary: WebviewSummary;
  dispatch: React.Dispatch<Parameters<typeof reducer>[1]>;
  requestChildren(node: JsonNodeView, offset: number): void;
  onMenu(event: React.MouseEvent, node: JsonNodeView): void;
  onLongText(text: string): void;
}

const ServerTreeNode = memo(function ServerTreeNodeComponent({ nodeId, level, tree, summary, dispatch, requestChildren, onMenu, onLongText }: ServerTreeNodeProps): ReactNode {
  const node = tree.nodes[nodeId];
  if (!node) throw new Error(`Tree node ${nodeId} is missing.`);
  const expandable = node.childrenCount > 0;
  const autoOpen = tree.mode === 'expanded' && level <= maxAutoDepth(summary) && !tree.manuallyCollapsed.has(nodeId);
  const open = expandable && (tree.expanded.has(nodeId) || autoOpen);
  const loaded = tree.loadedCount[nodeId] ?? 0;
  const loading = tree.loading.has(nodeId);
  useEffect(() => {
    if (open && loaded === 0 && node.childrenCount > 0 && !loading) requestChildren(node, 0);
  }, [loaded, loading, node, open, requestChildren]);
  const toggle = () => { if (expandable) dispatch({ type: 'toggleNode', nodeId, open: !open }); };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!expandable) return;
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); }
    if (event.key === 'ArrowRight' && !open) { event.preventDefault(); dispatch({ type: 'toggleNode', nodeId, open: true }); }
    if (event.key === 'ArrowLeft' && open) { event.preventDefault(); dispatch({ type: 'toggleNode', nodeId, open: false }); }
  };
  const text = node.displayValue ?? (node.type === 'null' ? 'null' : '');
  return <>
    <div className={`tree-row ${expandable ? 'expandable' : ''}`} role="treeitem" aria-level={level} aria-expanded={expandable ? open : undefined} tabIndex={0}
      style={{ '--level': level - 1 } as CSSProperties} onClick={toggle} onKeyDown={onKeyDown}
      onContextMenu={(event) => { event.preventDefault(); onMenu(event, node); }}>
      <ChevronRightIcon className={`chevron ${open ? 'open' : ''}`} aria-hidden />
      <span className="json-key">{node.key ?? '@'}</span>
      {expandable ? <span className={`shape shape-${node.type}`}>{node.type === 'array' ? '[ ]' : '{ }'}&nbsp; {node.childrenCount}</span> : <span className={`json-value value-${node.type}`} title={text}>{text}</span>}
      {!expandable && isLong(text) && <button className="inline-action" type="button" onClick={(event) => { event.stopPropagation(); onLongText(text); }}>{tr('expand')}</button>}
      {loading && <span className="loading-label">{tr('loading')}</span>}
    </div>
    {open && <div role="group">
      {(tree.children[nodeId] ?? []).map((childId) => <ServerTreeNode key={childId} nodeId={childId} level={level + 1} tree={tree} summary={summary} dispatch={dispatch} requestChildren={requestChildren} onMenu={onMenu} onLongText={onLongText} />)}
      {loaded < node.childrenCount && <button className="tree-load-more" type="button" disabled={loading} style={{ '--level': level } as CSSProperties} onClick={() => requestChildren(node, loaded)}>{loading ? tr('loading') : tr('loadMore', { loaded, total: node.childrenCount })}</button>}
    </div>}
  </>;
}, (previous, next) => {
  if (previous.nodeId !== next.nodeId || previous.level !== next.level || previous.summary !== next.summary || previous.tree.mode !== next.tree.mode) return false;
  if (previous.dispatch !== next.dispatch || previous.requestChildren !== next.requestChildren || previous.onMenu !== next.onMenu || previous.onLongText !== next.onLongText) return false;
  // Expansion changes can belong to a descendant. If an ancestor skips its
  // render here, React never reaches the toggled child, making nested nodes
  // appear unresponsive even though the reducer updated their state.
  if (previous.tree.expanded !== next.tree.expanded || previous.tree.manuallyCollapsed !== next.tree.manuallyCollapsed) return false;
  // Child pages and loading state can also belong to a descendant. Comparing
  // only this node's entries would leave an ancestor memoized after the host
  // response, so the new descendants would not appear until another toggle.
  if (previous.tree.nodes !== next.tree.nodes
    || previous.tree.children !== next.tree.children
    || previous.tree.loadedCount !== next.tree.loadedCount
    || previous.tree.loading !== next.tree.loading) return false;
  const id = previous.nodeId;
  return previous.tree.nodes[id] === next.tree.nodes[id]
    && previous.tree.children[id] === next.tree.children[id]
    && previous.tree.loadedCount[id] === next.tree.loadedCount[id]
    && previous.tree.loading.has(id) === next.tree.loading.has(id)
    && previous.tree.expanded.has(id) === next.tree.expanded.has(id)
    && previous.tree.manuallyCollapsed.has(id) === next.tree.manuallyCollapsed.has(id);
});

function Toolbar({ summary, query, onQuery, onFormat, onRepair, onExport, onOpenSource }: {
  summary: WebviewSummary; query: string; onQuery(value: string): void; onFormat(): void; onRepair(): void; onExport(): void; onOpenSource(): void;
}): ReactNode {
  const placeholder = summary.kind === 'json' ? tr('searchJson') : tr('searchJsonl');
  return <header className="toolbar">
    <div className="brand"><span className="brand-mark"><BrandIcon /></span><span className="brand-title">{summary.kind === 'json' ? 'JSON Preview' : 'JSONL Preview'}</span></div>
    <Input className="search-input" type="search" value={query} placeholder={placeholder} aria-label={placeholder} clearable prefixIcon={<SearchIcon />} onChange={onQuery} />
    <div className="toolbar-actions flex items-center gap-2">
      {summary.kind === 'json' ? <>
        <Button variant="outline" size="small" icon={<FormatPainterIcon />} onClick={onFormat}>{tr('format')}</Button>
        <Button variant="outline" size="small" icon={<ToolsIcon />} onClick={onRepair}>{tr('repair')}</Button>
      </> : <Button variant="outline" size="small" icon={<FileExportIcon />} onClick={onExport}>{tr('export')}</Button>}
      <Button theme="primary" size="small" icon={<CodeIcon />} onClick={onOpenSource}>{tr('source')}</Button>
    </div>
  </header>;
}

function StatusBar({ summary, extra, progress }: { summary: WebviewSummary; extra?: string; progress?: number }): ReactNode {
  const items = [formatBytes(summary.byteLength), summary.kind === 'jsonl' ? tr('records', { count: summary.recordCount ?? 0 }) : undefined, tr('errors', { count: summary.errors }), `${Math.round(summary.parseMilliseconds)} ms`, progress === undefined ? undefined : tr('indexed', { count: progress }), extra].filter(Boolean);
  return <div className="statusbar">{items.map((item) => <span key={String(item)}>{item}</span>)}</div>;
}

function JsonTreeView({ state, dispatch, requestChildren, onServerMenu, onValueMenu, openText }: {
  state: AppState; dispatch: React.Dispatch<Parameters<typeof reducer>[1]>; requestChildren(node: JsonNodeView, offset: number): void;
  onServerMenu(event: React.MouseEvent, node: JsonNodeView): void;
  onValueMenu(event: React.MouseEvent, key: string | undefined, value: unknown, path?: string): void;
  openText(text: string): void;
}): ReactNode {
  const summary = state.summary!;
  if (state.searchResult) return <section className="surface tree-surface">
    <div className="surface-heading"><span className="surface-title">{tr('queryResult')}</span></div>
    <div className="tree" role="tree" aria-label={tr('queryResultAria')}><ValueTree value={state.searchResult.result} maxDepth={maxAutoDepth(summary)} jsonPath="@" onMenu={onValueMenu} onLongText={openText} /></div>
  </section>;
  return <section className="surface tree-surface">
    <div className="surface-heading">
      <span className="surface-title">{tr('structure')}</span>
      {summary.root && <Button variant="text" size="small" onClick={() => dispatch({ type: 'treeMode', mode: state.tree.mode === 'expanded' ? 'collapsed' : 'expanded' })}>{state.tree.mode === 'expanded' ? tr('collapseAll') : tr('expandAll')}</Button>}
    </div>
    <div className="tree" role="tree" aria-label={tr('structure')}>
      {!summary.root ? <div className="empty-state"><span className="empty-icon">!</span><h2>{tr('invalidJson')}</h2>{(summary.diagnostics ?? []).map((diagnostic) => <div className="error" key={`${diagnostic.offset}-${diagnostic.code}`}>{tr('location', { line: diagnostic.line, column: diagnostic.column })} · {diagnostic.message}</div>)}</div>
        : <ServerTreeNode nodeId={summary.root.nodeId} level={1} tree={state.tree} summary={summary} dispatch={dispatch} requestChildren={requestChildren} onMenu={onServerMenu} onLongText={openText} />}
    </div>
  </section>;
}

function LegacyJsonlGrid({ state, onSort, onPage, onRecord }: {
  state: AppState; onSort(field?: string): void; onPage(offset: number): void; onRecord(row: JsonlRow): void;
}): ReactNode {
  const summary = state.summary!;
  const all = summary.fields ?? ['$'];
  const selected = state.view.columns?.filter((field) => all.includes(field));
  const fields = selected?.length ? selected : all.slice(0, 12);
  const { rows, total, offset } = state.page;
  const currentSort = state.view.sort;
  const rowHeight = 34;
  const pageSize = Math.max(1, summary.pageSize ?? (rows.length || 100));
  const virtualHeight = Math.min(10_000_000, Math.max(rowHeight, total * rowHeight));
  const loadingPage = state.requestedOffset !== offset;
  const visibleOffset = loadingPage ? state.requestedOffset : offset;
  const visibleRowCount = loadingPage
    ? Math.min(pageSize, Math.max(0, total - visibleOffset))
    : rows.length;
  const windowHeight = visibleRowCount * rowHeight;
  const windowTop = total <= visibleRowCount ? 0 : visibleOffset / Math.max(1, total - visibleRowCount) * Math.max(0, virtualHeight - windowHeight);
  const onScroll = (event: React.UIEvent<HTMLDivElement>) => {
    if (!total || event.currentTarget.scrollHeight <= event.currentTarget.clientHeight) return;
    if (total <= pageSize) return;
    const ratio = event.currentTarget.scrollTop / Math.max(1, event.currentTarget.scrollHeight - event.currentTarget.clientHeight);
    const maxPageOffset = Math.floor((total - 1) / pageSize) * pageSize;
    const approximateFirst = Math.floor(ratio * maxPageOffset);
    const requested = Math.min(maxPageOffset, Math.floor(approximateFirst / pageSize) * pageSize);
    if (requested === offset) return;
    if (requested !== state.requestedOffset) onPage(requested);
  };
  const navigateRows = (event: KeyboardEvent<HTMLDivElement>, rowIndex: number) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const rows = [...event.currentTarget.parentElement!.querySelectorAll<HTMLElement>('[data-grid-row]')];
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, rowIndex + (event.key === 'ArrowDown' ? 1 : -1)));
    rows[next]?.focus();
  };
  return <section className="surface grid-surface">
    <div className="grid" role="grid" aria-rowcount={total} aria-busy={loadingPage} style={{ '--columns': fields.length } as CSSProperties} onScroll={onScroll}>
      <div className="grid-row grid-header" role="row"><button type="button" className={`cell line-cell column-header ${!currentSort || currentSort.field === PHYSICAL_LINE_SORT ? 'sorted' : ''}`} role="columnheader" aria-sort={currentSort?.field === PHYSICAL_LINE_SORT ? currentSort.direction === 'asc' ? 'ascending' : 'descending' : currentSort ? 'none' : 'ascending'} onClick={() => onSort(PHYSICAL_LINE_SORT)}>#{currentSort?.field === PHYSICAL_LINE_SORT ? currentSort.direction === 'asc' ? ' ↑' : ' ↓' : !currentSort ? ' ↑' : ''}</button>
        {fields.map((field) => {
          const selectedSort = currentSort?.field === field;
          return <button key={field} type="button" className={`cell column-header ${selectedSort ? 'sorted' : ''}`} role="columnheader" aria-sort={selectedSort ? currentSort.direction === 'asc' ? 'ascending' : 'descending' : 'none'} onClick={() => onSort(field)}>
            {field}{selectedSort ? currentSort.direction === 'asc' ? ' ↑' : ' ↓' : ''}
          </button>;
        })}
      </div>
      <div className="virtual-body" style={{ height: virtualHeight }}>
        <div className="virtual-window" style={{ transform: `translateY(${windowTop}px)` }}>
          {loadingPage ? Array.from({ length: visibleRowCount }, (_, rowIndex) => <div key={rowIndex} className="grid-row loading-row" aria-hidden="true">
            <div className="cell line-cell"><span className="loading-cell" /></div>
            {fields.map((field) => <div className="cell" key={field}><span className="loading-cell" /></div>)}
          </div>) : rows.map((row, rowIndex) => <div key={`${row.resultIndex}-${row.physicalLine}`} data-grid-row className={`grid-row ${row.error ? 'invalid' : ''}`} role="row" aria-rowindex={row.resultIndex + 1} tabIndex={rowIndex === 0 ? 0 : -1} onClick={() => onRecord(row)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onRecord(row); } else navigateRows(event, rowIndex); }}>
            <button type="button" className="cell line-cell" title={tr('sourceLine')} onClick={(event) => { event.stopPropagation(); send({ type: 'revealLine', line: row.physicalLine }); }}>{row.physicalLine}</button>
            {fields.map((field) => { const shown = displayValue(row.cells[field], summary); return <div className="cell" role="gridcell" key={field}><span className={`cell-value value-${valueKind(row.cells[field])}`} title={shown.title ?? shown.text}>{shown.text}</span></div>; })}
          </div>)}
        </div>
      </div>
    </div>
  </section>;
}

function JsonlGrid({ state, onSort, onPage, onRecord, onCellMenu, onColumnWidthsChange }: {
  state: AppState; onSort(field?: string, direction?: 'asc' | 'desc'): void; onPage(offset: number): void; onRecord(row: JsonlRow): void;
  onCellMenu(event: React.MouseEvent, row: JsonlRow, cellValue: unknown, cellText: string, field?: string): void;
  onColumnWidthsChange(columnWidths: Record<string, number>): void;
}): ReactNode {
  const summary = state.summary!;
  const all = summary.fields ?? ['$'];
  const selected = state.view.columns?.filter((field) => all.includes(field));
  const fields = selected?.length ? selected : all.slice(0, 12);
  const { rows, total, offset } = state.page;
  const currentSort = state.view.sort;
  const pageSize = Math.max(1, summary.pageSize ?? (rows.length || 100));
  const hasPagination = total > pageSize;
  const loadingPage = state.requestedOffset !== offset;
  const currentPage = Math.floor((loadingPage ? state.requestedOffset : offset) / pageSize) + 1;
  const ariaSort = (field: string): 'ascending' | 'descending' | 'none' => {
    const selectedSort = currentSort?.field === field || (!currentSort && field === PHYSICAL_LINE_SORT);
    return selectedSort ? currentSort?.direction === 'desc' ? 'descending' : 'ascending' : 'none';
  };
  const columns: Array<PrimaryTableCol<JsonlRow>> = [{
    colKey: PHYSICAL_LINE_SORT, title: '#', width: state.view.columnWidths?.[PHYSICAL_LINE_SORT] ?? 68, fixed: 'left', sorter: true, resize: { minWidth: 60, maxWidth: 240 },
    attrs: ({ type, row }) => type === 'th' ? { 'aria-sort': ariaSort(PHYSICAL_LINE_SORT), onClick: (event: React.MouseEvent) => { if (!(event.target as Element).closest('.t-table__sort-icon')) onSort(PHYSICAL_LINE_SORT); } } : { onContextMenu: (event: React.MouseEvent) => onCellMenu(event, row, row.physicalLine, String(row.physicalLine)) },
    cell: ({ row }) => <button type="button" className="line-link" title={tr('sourceLine')} onClick={(event) => { event.stopPropagation(); send({ type: 'revealLine', line: row.physicalLine }); }}>{row.physicalLine}</button>
  }, ...fields.map((field): PrimaryTableCol<JsonlRow> => ({
    colKey: field, title: field, width: state.view.columnWidths?.[field] ?? 180, ellipsis: true, sorter: true, resize: { minWidth: 80, maxWidth: 1200 },
    attrs: ({ type, row }) => type === 'th' ? { 'aria-sort': ariaSort(field), onClick: (event: React.MouseEvent) => { if (!(event.target as Element).closest('.t-table__sort-icon')) onSort(field); } } : { onContextMenu: (event: React.MouseEvent) => onCellMenu(event, row, row.cells[field], displayValue(row.cells[field], summary).text, field) },
    cell: ({ row }) => { const shown = displayValue(row.cells[field], summary); return <span className={`cell-value value-${valueKind(row.cells[field])}`} title={shown.title ?? shown.text}>{shown.text}</span>; }
  }))];
  const displayedSort: TableSort = { sortBy: currentSort?.field ?? PHYSICAL_LINE_SORT, descending: currentSort?.direction === 'desc' };
  const onTableSort = (next: TableSort) => {
    const value = Array.isArray(next) ? next[0] : next;
    if (!value?.sortBy) onSort(); else onSort(String(value.sortBy), value.descending ? 'desc' : 'asc');
  };
  const onScroll = (event: React.UIEvent<HTMLDivElement>) => {
    if (!total || total <= pageSize || event.currentTarget.scrollHeight <= event.currentTarget.clientHeight) return;
    const ratio = event.currentTarget.scrollTop / Math.max(1, event.currentTarget.scrollHeight - event.currentTarget.clientHeight);
    const maxPageOffset = Math.floor((total - 1) / pageSize) * pageSize;
    const requested = Math.min(maxPageOffset, Math.floor(ratio * maxPageOffset / pageSize) * pageSize);
    if (requested !== offset && requested !== state.requestedOffset) onPage(requested);
  };
  return <section className="surface grid-surface">
    <div className="data-grid" role="grid" aria-rowcount={total} aria-busy={loadingPage || !state.page.loaded} onScroll={onScroll}>
      <Table<JsonlRow> key={state.page.loaded ? 'loaded' : 'initial'} className={`jsonl-table ${hasPagination ? 'has-pagination' : ''}`} data={rows} columns={columns} rowKey="resultIndex" size="small" bordered hover stripe
        maxHeight="100%" loading={loadingPage || !state.page.loaded} sort={displayedSort} onSortChange={onTableSort}
        hideSortTips
        resizable tableLayout="fixed" onColumnResizeChange={({ columnsWidth }) => onColumnWidthsChange(columnsWidth)}
        scroll={{ type: 'virtual', rowHeight: 34, isFixedRowHeight: true, threshold: 40, bufferSize: 12 }}
        disableDataPage
        pagination={hasPagination ? { current: currentPage, pageSize, total, showPageSize: false, size: 'small', onCurrentChange: (page) => onPage((page - 1) * pageSize) } : undefined}
        rowClassName={({ row }) => row.error ? 'invalid' : ''} onRowClick={({ row }) => onRecord(row)} />
    </div>
  </section>;
}

export function App(): ReactNode {
  const initialView = vscode.getState() ?? {};
  const [state, dispatch] = useReducer(reducer, initialView, createInitialState);
  const stateRef = useRef(state); stateRef.current = state;
  const queryRevision = useRef(0), searchRevision = useRef(0);
  const childRequests = useRef(new Set<string>());
  const lastCriteria = useRef<string | undefined>(undefined);
  const [menu, setMenu] = useState<MenuState>();
  const [drawer, setDrawer] = useState<DrawerState>();
  const [fullText, setFullText] = useState<string>();
  const [toast, setToast] = useState<string>();
  const initialized = useRef(false);

  const announce = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast((current) => current === message ? undefined : current), 1600);
  }, []);
  const copied = useCallback((text: string) => { send({ type: 'copy', text }); announce(tr('copied')); }, [announce]);

  const recordDrawer = useCallback((physicalLine: number, text: string): DrawerState => ({
    title: tr('line', { line: physicalLine }), physicalLine,
    value: (() => { try { return JSON.parse(text) as unknown; } catch { return undefined; } })(), text,
    actions: <><Button size="small" variant="outline" icon={<CopyIcon />} onClick={() => copied(text)}>{tr('copyLine')}</Button><Button size="small" variant="outline" icon={<TabIcon />} onClick={() => send({ type: 'openTemp', text })}>{tr('tempTab')}</Button></>
  }), [copied]);

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      if (!isHostMessage(event.data)) return;
      const message = event.data as HostMessage;
      if (message.type === 'init') { setLocale(message.summary.locale); initialized.current = true; lastCriteria.current = undefined; childRequests.current.clear(); dispatch({ type: 'init', summary: message.summary, view: message.uiState }); }
      else if (message.type === 'children') {
        childRequests.current.delete(`${message.generation}:${message.parentId}:${message.offset}`);
        dispatch({ type: 'treeChildren', generation: message.generation, parentId: message.parentId, offset: message.offset, nodes: message.nodes });
      }
      else if (message.type === 'page') dispatch({ type: 'page', queryRevision: message.queryRevision, offset: message.offset, page: { rows: message.rows, total: message.total, scannedRows: message.scannedRows, matchedRows: message.matchedRows, isComplete: message.isComplete } });
      else if (message.type === 'record') setDrawer((current) => current?.physicalLine === message.physicalLine ? recordDrawer(message.physicalLine, message.content) : current);
      else if (message.type === 'search') dispatch({ type: 'search', searchRevision: message.searchRevision, query: message.query, result: message.result });
      else if (message.type === 'progress') dispatch({ type: 'progress', records: message.records });
      else if (message.type === 'error') {
        childRequests.current.clear();
        dispatch({ type: 'error', message: message.message });
      }
    };
    window.addEventListener('message', onMessage); send({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, [recordDrawer]);

  useEffect(() => {
    vscode.setState(state.view);
    const timer = window.setTimeout(() => send({ type: 'persist', state: state.view }), 300);
    return () => window.clearTimeout(timer);
  }, [state.view]);

  useEffect(() => {
    if (!state.error) return;
    const timer = window.setTimeout(() => dispatch({ type: 'clearError' }), ERROR_TOAST_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [state.error]);

  useEffect(() => {
    const summary = state.summary;
    if (!summary || !initialized.current) return;
    const timer = window.setTimeout(() => {
      const query = state.view.query?.trim() ?? '';
      if (summary.kind === 'json') {
        const revision = ++searchRevision.current;
        dispatch({ type: 'startSearch', searchRevision: revision });
        if (query) send({ type: 'jsonSearch', query, searchRevision: revision });
        else dispatch({ type: 'clearSearch', searchRevision: revision });
      } else {
        const revision = ++queryRevision.current;
        dispatch({ type: 'startQuery', queryRevision: revision });
        const sort = sortSpec(state.view.sort);
        const criteria = JSON.stringify({ query, sort });
        const hasPreviousRequest = lastCriteria.current !== undefined;
        lastCriteria.current = criteria;
        if (query || sort || hasPreviousRequest) send({ type: 'query', queryRevision: revision, ...(query ? { jmesPath: query } : {}), ...(sort ? { sort } : {}) });
        else send({ type: 'page', offset: 0, queryRevision: revision });
      }
    }, summary.kind === 'jsonl' ? 120 : 180);
    return () => window.clearTimeout(timer);
  }, [state.summary, state.view.query, state.view.sort]);

  const requestChildren = useCallback((node: JsonNodeView, offset: number) => {
    const current = stateRef.current;
    const requestKey = `${current.tree.generation}:${node.nodeId}:${offset}`;
    if (current.tree.loading.has(node.nodeId) || childRequests.current.has(requestKey)) return;
    childRequests.current.add(requestKey);
    dispatch({ type: 'treeLoading', nodeId: node.nodeId });
    send({ type: 'children', nodeId: node.nodeId, parentId: node.nodeId, generation: current.tree.generation, offset, limit: Math.min(500, node.childrenCount - offset) });
  }, []);

  const onServerMenu = useCallback((event: React.MouseEvent, node: JsonNodeView) => {
    const items: MenuItem[] = [
      ...(node.key !== undefined ? [{ label: tr('copyKey'), icon: <KeyIcon />, action: () => copied(String(node.key)) }] : []),
      ...(node.childrenCount === 0 ? [{ label: tr('copyValue'), icon: <CopyIcon />, action: () => copied(node.displayValue ?? '') }] : []),
      { label: tr('copyJson'), icon: <CopyIcon />, action: () => { send({ type: 'copy', nodeId: node.nodeId, format: 'pretty' }); announce(tr('copied')); } },
      { label: tr('copyPath'), icon: <CodeIcon />, action: () => copied(node.jsonPath) },
      { label: tr('openTemp'), icon: <TabIcon />, action: () => node.type === 'string' && node.displayValue !== undefined ? send({ type: 'openTemp', text: temporaryText(node.displayValue) }) : send({ type: 'openTemp', nodeId: node.nodeId }) }
    ];
    setMenu({ x: event.clientX, y: event.clientY, items });
  }, [announce, copied]);

  const onValueMenu = useCallback((event: React.MouseEvent, key: string | undefined, value: unknown, path?: string) => {
    const items: MenuItem[] = [
      ...(key !== undefined ? [{ label: tr('copyKey'), icon: <KeyIcon />, action: () => copied(key) }] : []),
      { label: tr('copyValue'), icon: <CopyIcon />, action: () => copied(typeof value === 'string' ? value : jsonText(value)) },
      ...(path !== undefined ? [{ label: tr('copyPath'), icon: <CodeIcon />, action: () => copied(path) }] : []),
      { label: tr('openTemp'), icon: <TabIcon />, action: () => send({ type: 'openTemp', text: temporaryText(value) }) }
    ];
    setMenu({ x: event.clientX, y: event.clientY, items });
  }, [copied]);
  const onCellMenu = useCallback((event: React.MouseEvent, row: JsonlRow, cellValue: unknown, cellText: string, field?: string) => {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, items: [
      { label: tr('copyLine'), icon: <CopyIcon />, action: () => copied(row.raw) },
      { label: tr('copyCell'), icon: <CopyIcon />, action: () => copied(cellText) },
      { label: tr('openRowTemp'), icon: <TabIcon />, action: () => send({ type: 'openTemp', physicalLine: row.physicalLine }) },
      ...(cellValue !== undefined ? [{ label: tr('openCellTemp'), icon: <TabIcon />, action: () => field
        ? send({ type: 'openTemp', physicalLine: row.physicalLine, field })
        : send({ type: 'openTemp', text: temporaryText(cellValue) }) }] : [])
    ] });
  }, [copied]);
  const openLongText = useCallback((text: string) => setFullText(text), []);

  useEffect(() => {
    const suppressNativeMenu = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : undefined;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      event.preventDefault();
      setMenu(undefined);
    };
    document.addEventListener('contextmenu', suppressNativeMenu);
    return () => document.removeEventListener('contextmenu', suppressNativeMenu);
  }, []);

  const onSort = (field?: string, direction?: 'asc' | 'desc') => {
    const current = state.view.sort;
    if (!field) dispatch({ type: 'setSort' });
    else if (direction) dispatch({ type: 'setSort', sort: { field, direction } });
    else if (field === PHYSICAL_LINE_SORT) dispatch({ type: 'setSort', sort: { field, direction: current?.field === field || !current ? current?.direction === 'desc' ? 'asc' : 'desc' : 'asc' } });
    else if (current?.field === field && current.direction === 'desc') dispatch({ type: 'setSort' });
    else dispatch({ type: 'setSort', sort: { field, direction: current?.field === field ? 'desc' : 'asc' } });
  };
  const onColumnWidthsChange = (columnWidths: Record<string, number>) => {
    dispatch({ type: 'setColumnWidths', columnWidths: { ...state.view.columnWidths, ...columnWidths } });
  };
  const onPage = (offset: number) => { dispatch({ type: 'requestPage', offset }); send({ type: 'page', offset, queryRevision: state.queryRevision }); };
  const onRecord = (row: JsonlRow) => {
    if (!row.rawTruncated) { setDrawer(recordDrawer(row.physicalLine, row.raw)); return; }
    setDrawer({ title: tr('line', { line: row.physicalLine }), physicalLine: row.physicalLine, loading: true });
    send({ type: 'record', physicalLine: row.physicalLine });
  };

  const summary = state.summary;
  useEffect(() => { document.querySelector('#app')?.setAttribute('aria-busy', String(!summary)); }, [summary]);
  if (!summary) return <main className="loading-screen"><span className="loading-spinner" aria-hidden /><span>{tr('preparing')}</span></main>;
  const extra = summary.kind === 'json' ? (state.searchResult?.query ? tr('expression', { value: state.searchResult.query }) : undefined) : tr('results', { count: state.page.total });
  return <main className={summary.kind === 'jsonl' ? 'jsonl-layout' : undefined}>
    <Toolbar summary={summary} query={state.view.query ?? ''} onQuery={(query) => dispatch({ type: 'setQuery', query })} onFormat={() => send({ type: 'format' })} onRepair={() => send({ type: 'repair' })} onExport={() => send({ type: 'export', queryRevision: state.queryRevision })} onOpenSource={() => send({ type: 'openSource' })} />
    <StatusBar summary={summary} extra={extra} progress={state.progressRecords} />
    {summary.kind === 'json'
      ? <JsonTreeView state={state} dispatch={dispatch} requestChildren={requestChildren} onServerMenu={onServerMenu} onValueMenu={onValueMenu} openText={openLongText} />
      : <JsonlGrid state={state} onSort={onSort} onPage={onPage} onRecord={onRecord} onCellMenu={onCellMenu} onColumnWidthsChange={onColumnWidthsChange} />}
    {menu && <ContextMenu menu={menu} close={() => setMenu(undefined)} />}
    <Drawer visible={Boolean(drawer)} placement="right" size="66.6667vw" header={drawer && <DrawerHeader title={drawer.title} actions={drawer.actions} />} footer={false} closeBtn showOverlay closeOnOverlayClick preventScrollThrough closeOnEscKeydown destroyOnClose onClose={() => setDrawer(undefined)}>
      {drawer && <div className="drawer-content">
        {drawer.loading ? <div className="drawer-loading"><span className="loading-spinner" aria-hidden /><span>{tr('loading')}</span></div>
          : drawer.value !== undefined ? <div className="tree drawer-tree" role="tree"><ValueTree value={drawer.value} maxDepth={maxAutoDepth(summary)} jsonPath="@" onMenu={onValueMenu} onLongText={openLongText} /></div> : <pre className={`text-viewer ${drawer.text ? '' : 'invalid-text'}`}>{drawer.text}</pre>}
      </div>}
    </Drawer>
    <Drawer visible={fullText !== undefined} placement="right" size="66.6667vw" header={<DrawerHeader title={tr('fullContent')} actions={fullText !== undefined && <Button size="small" variant="outline" icon={<CopyIcon />} onClick={() => copied(fullText)}>{tr('copyContent')}</Button>} />} footer={false} closeBtn showOverlay closeOnOverlayClick preventScrollThrough closeOnEscKeydown destroyOnClose onClose={() => setFullText(undefined)}>
      {fullText !== undefined && <div className="drawer-content">
        <pre className="text-viewer">{fullText}</pre>
      </div>}
    </Drawer>
    {state.error && <div className="toast error-toast" role="alert" onClick={() => dispatch({ type: 'clearError' })}>{state.error}</div>}
    {toast && <div className="toast" role="status">{toast}</div>}
    <div className="sr-only" aria-live="polite" aria-atomic="true">{toast ?? state.error ?? ''}</div>
  </main>;
}
