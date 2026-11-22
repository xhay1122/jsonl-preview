import { createContext, memo, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import Button from 'tdesign-react/es/button';
import Drawer from 'tdesign-react/es/drawer';
import Input from 'tdesign-react/es/input';
import Table, { type PrimaryTableCol, type TableSort } from 'tdesign-react/es/table';
import ChevronRightIcon from 'tdesign-icons-react/esm/components/chevron-right';
import ChevronDownIcon from 'tdesign-icons-react/esm/components/chevron-down';
import CodeIcon from 'tdesign-icons-react/esm/components/code';
import CopyIcon from 'tdesign-icons-react/esm/components/copy';
import EnterIcon from 'tdesign-icons-react/esm/components/enter';
import FileExportIcon from 'tdesign-icons-react/esm/components/file-export';
import FormatPainterIcon from 'tdesign-icons-react/esm/components/format-painter';
import KeyIcon from 'tdesign-icons-react/esm/components/key';
import SearchIcon from 'tdesign-icons-react/esm/components/search';
import BrowseIcon from 'tdesign-icons-react/esm/components/browse';
import TabIcon from 'tdesign-icons-react/esm/components/tab';
import ToolsIcon from 'tdesign-icons-react/esm/components/tools';
import { BrandIcon } from './brandIcon';
import type { JsonNodeView, JsonlRow, JsonSearchTarget } from '../shared/types.js';
import { checkQueryResultSize, literalMatches, matchGroupAt, queryProjection, scalarMatches, scalarRanges, type JsonSearchMode, type JsonSearchPreferences, type MatchGroup } from '../shared/jsonSearch.js';
import { messageOf } from '../shared/errors.js';
import { createInitialState, initialSearchMode, reducer, type AppState, type TreeState } from './state.js';
import { isHostMessage, type HostMessage, type SortState, type WebviewSummary } from './protocol.js';
import { send, vscode } from './bridge.js';
import { setLocale, tr } from './i18n.js';
import { timestampLabel, type TimeDisplayOptions } from '../shared/dateTime.js';
import { FindBar, SearchModeButton, highlightMatches, highlightTreeValue, isFindShortcut, nextMatchIndex, type FindNavigation } from './findBar.js';
import { IconAction } from './iconAction.js';
function jsonText(value: unknown, pretty = true): string {
  const result = JSON.stringify(value, null, pretty ? 2 : 0);
  return result === undefined ? String(value) : result;
}
function valueKind(value: unknown): string { return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value; }
function isContainer(value: unknown): value is Record<string, unknown> | unknown[] { return value !== null && typeof value === 'object'; }
function formatBytes(bytes: number): string { return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
function maxAutoDepth(summary: WebviewSummary): number {
  const value = Number(summary.maxAutoExpandDepth);
  return Number.isInteger(value) && value > 0 ? value : 10;
}
const PHYSICAL_LINE_SORT = '\u0000physicalLine';
const ERROR_TOAST_DURATION_MS = 4000;
const SYSTEM_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
function sortSpec(sort?: SortState | null, fieldPointers?: Record<string, string>): { path: string; direction: 'asc' | 'desc' } | { by: 'physicalLine'; direction: 'asc' | 'desc' } | undefined {
  if (!sort) return undefined;
  if (sort.field === PHYSICAL_LINE_SORT) return sort.direction === 'asc' ? undefined : { by: 'physicalLine', direction: 'desc' };
  const path = fieldPointers
    ? fieldPointers[sort.field]
    : '/' + sort.field.split('.').map((part) => part.replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
  return path === undefined ? undefined : { path, direction: sort.direction };
}
function temporaryText(value: unknown): string {
  if (typeof value === 'string') { try { return jsonText(JSON.parse(value)); } catch { return jsonText(value); } }
  return jsonText(value);
}

function selectedTextWithin(element: Element): string | undefined {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return undefined;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return undefined;
  const text = selection.toString();
  return text.length > 0 ? text : undefined;
}

function displayValue(value: unknown, summary: WebviewSummary, field?: string): { text: string; title?: string } {
  if (value === undefined) return { text: '—' };
  if (value === null) return { text: 'null' };
  // Column labels describe paths and may quote literal keys; use the actual
  // leaf property, matching the field passed by the record detail tree.
  const pointer = field === undefined ? undefined : summary.fieldPointers?.[field];
  const property = pointer === undefined
    ? (summary.fieldPointers === undefined && field !== undefined && !/[.\[\]]/.test(field) ? field : undefined)
    : pointer === '' ? undefined : pointer.slice(pointer.lastIndexOf('/') + 1).replace(/~1/g, '/').replace(/~0/g, '~');
  const formatted = timestampLabel(value, property, summary);
  if (formatted) return { text: formatted.text, title: String(value) };
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return { text: value, title: tr('timezoneUnknown') };
  if (typeof value === 'string') return { text: value };
  return { text: isContainer(value) ? jsonText(value, false) : String(value) };
}

interface MenuItem { label: string; alternateLabel?: string; action(alternate: boolean): void; icon?: ReactNode; alternateIcon?: ReactNode }
interface MenuState { x: number; y: number; items: MenuItem[] }
interface DrawerState { title: string; searchMode: JsonSearchMode; value?: unknown; text?: string; physicalLine?: number; loading?: boolean }
interface FullTextState { text: string; physicalLine?: number; pointer?: string }
const AltKeyContext = createContext(false);
const TimeDisplayContext = createContext<Pick<WebviewSummary, 'locale' | 'timezone'>>({});

function pointerSegment(value: string): string { return value.replace(/~/g, '~0').replace(/\//g, '~1'); }

interface TreeFind {
  matches: ReturnType<typeof scalarMatches>;
  active: { id: string; occurrence: number };
  ancestors: ReadonlySet<string>;
  pages?: ReadonlyMap<string, JsonSearchTarget['pages'][number]>;
  nodes?: ReadonlyMap<string, JsonNodeView>;
}
const TreeFindContext = createContext<TreeFind | undefined>(undefined);

function JsonScalarValue({ text, kind, scalar, findId, field, actions, onExpand, onCopy, onOpen }: {
  text: string; kind: string; scalar: unknown; findId?: string;
  field?: string; actions: boolean; onExpand(): void; onCopy(): void; onOpen(current: boolean): void;
}): ReactNode {
  const altPressed = useContext(AltKeyContext);
  const find = useContext(TreeFindContext);
  const time = useContext(TimeDisplayContext);
  const active = find !== undefined && find.active.id === findId;
  const match = findId === undefined ? undefined : find?.matches;
  const activeIndex = active ? find.active.occurrence : -1;
  const formatted = timestampLabel(scalar, field, time);
  const label = formatted?.text;
  const timeIndex = active && match && label ? activeIndex - [...match(text, scalar)].length : -1;
  const content = useMemo(() => match ? highlightTreeValue(text, match(text, scalar), activeIndex) : text, [activeIndex, match, scalar, text]);
  const annotation = formatted && <span className="timestamp-annotation" title={formatted.timezone}> ({match
    ? highlightMatches(formatted.text, match(formatted.text, formatted.text), timeIndex) : formatted.text})</span>;
  return <>
    <span className={`json-value value-${kind}${active ? ' active-match-value' : ''}`} title={text}>{content}{annotation}</span>
    {actions && <span className="inline-actions">
      <button className="inline-action" type="button" title={tr('expand')} aria-label={tr('expand')} onClick={(event) => { event.stopPropagation(); onExpand(); }}><BrowseIcon /></button>
      <button className="inline-action" type="button" title={tr('copyValue')} aria-label={tr('copyValue')} onClick={(event) => { event.stopPropagation(); onCopy(); }}><CopyIcon /></button>
      <button className="inline-action" type="button" title={altPressed ? tr('openCurrent') : tr('openTempHint')} aria-label={altPressed ? tr('openCurrent') : tr('openTemp')} onClick={(event) => { event.stopPropagation(); onOpen(event.altKey || altPressed); }}>{altPressed ? <EnterIcon /> : <TabIcon />}</button>
    </span>}
  </>;
}

function DrawerHeader({ title, actions }: { title: string; actions?: ReactNode }): ReactNode {
  return <div className="drawer-header-content"><span className="drawer-title">{title}</span>{actions && <div className="drawer-header-actions">{actions}</div>}</div>;
}

function FullContentView({ text, onContextMenu, inline = false, shortcutEnabled = true }: {
  text: string; onContextMenu(event: React.MouseEvent<HTMLElement>): void; inline?: boolean; shortcutEnabled?: boolean;
}): ReactNode {
  const [query, setQuery] = useState('');
  const [activeMatch, setActiveMatch] = useState(0);
  const [searchVisible, setSearchVisible] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const matches = useMemo(() => [...literalMatches(query)(text)], [query, text]);

  const onQuery = (value: string) => { setQuery(value); setActiveMatch(0); };
  useEffect(() => {
    container.current?.querySelector<HTMLElement>('[data-active-match="true"]')?.scrollIntoView?.({ block: 'center' });
  }, [activeMatch, matches]);
  useEffect(() => {
    if (!shortcutEnabled) return;
    const handleSearchKeys = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && (searchVisible || inline && query)) {
        event.preventDefault();
        event.stopPropagation();
        setSearchVisible(false);
        onQuery('');
        return;
      }
      if (!isFindShortcut(event)) return;
      event.preventDefault();
      if (searchVisible || inline) {
        const input = container.current?.querySelector<HTMLInputElement>('.drawer-search-input input');
        input?.focus();
        input?.select();
      } else setSearchVisible(true);
    };
    window.addEventListener('keydown', handleSearchKeys, true);
    return () => window.removeEventListener('keydown', handleSearchKeys, true);
  }, [inline, query, searchVisible, shortcutEnabled]);
  useEffect(() => {
    if (!searchVisible) return;
    const input = container.current?.querySelector<HTMLInputElement>('.drawer-search-input input');
    input?.focus();
    input?.select();
  }, [searchVisible]);

  const move = (direction: 1 | -1) => {
    setActiveMatch((current) => nextMatchIndex(current, matches.length, direction));
  };
  const find = (className: string) => <FindBar className={className} query={query}
    label={tr(inline ? 'searchRawRecord' : 'searchContent')} onQuery={onQuery}
    navigation={{ index: activeMatch, total: matches.length, move }}
    {...(inline ? {} : { onClose: () => { setSearchVisible(false); onQuery(''); } })} />;

  return <div ref={container} className="drawer-content full-content">
    {inline ? find('record-find') : searchVisible && <div className="drawer-search-overlay">{find('drawer-search')}</div>}
    <pre className="text-viewer full-content-viewer" onContextMenu={onContextMenu}>{highlightMatches(text, matches, activeMatch)}</pre>
  </div>;
}

function ContextMenu({ menu, close }: { menu: MenuState; close(): void }): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const altPressed = useContext(AltKeyContext);
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
    {menu.items.map((item) => <button key={item.label} type="button" className="menu-item" role="menuitem" onClick={(event) => { close(); item.action(event.altKey || altPressed); }}>
      {altPressed && item.alternateLabel ? item.alternateIcon ?? item.icon : item.icon}<span>{altPressed ? item.alternateLabel ?? item.label : item.label}</span>
    </button>)}
  </div>;
}

function ValueTree({ value, label = '@', level = 1, initiallyExpanded = true, maxDepth = 10, jsonPath, pointer, onMenu, onLongText, onCopyText, onOpenText }: {
  value: unknown; label?: string; level?: number; initiallyExpanded?: boolean; maxDepth?: number; jsonPath?: string; pointer?: string;
  onMenu?(event: React.MouseEvent, key: string | undefined, value: unknown, path?: string): void;
  onLongText?(text: string, pointer?: string): void; onCopyText?(text: string, pointer?: string): void; onOpenText?(text: string, current: boolean, pointer?: string): void;
}): ReactNode {
  const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item] as const) : isContainer(value) ? Object.entries(value) : [];
  const expandable = entries.length > 0;
  const [manuallyOpen, setOpen] = useState(expandable && initiallyExpanded && level <= maxDepth);
  const find = useContext(TreeFindContext);
  const forcedOpen = pointer !== undefined && find?.ancestors.has(pointer) === true;
  const open = expandable && (manuallyOpen || forcedOpen);
  const shown = typeof value === 'string' ? value : value === null ? 'null' : isContainer(value) ? '' : String(value);
  const childPath = (key: string) => jsonPath === undefined ? undefined : Array.isArray(value) ? `${jsonPath}[${key}]` : `${jsonPath}${/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? `.${key}` : `.${JSON.stringify(key)}`}`;
  const childPointer = (key: string) => pointer === undefined ? undefined : `${pointer}/${pointerSegment(key)}`;
  const toggle = () => { if (expandable && !forcedOpen) setOpen((current) => !current); };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!expandable || forcedOpen) return;
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
      {isContainer(value) ? <span className={`shape shape-${valueKind(value)}`}>{Array.isArray(value) ? '[ ]' : '{ }'}&nbsp; {entries.length}</span>
        : <JsonScalarValue text={shown} kind={valueKind(value)} scalar={value} field={label} {...(pointer === undefined ? {} : { findId: pointer })} actions={typeof value === 'string'} onExpand={() => onLongText?.(value as string, pointer)} onCopy={() => onCopyText?.(value as string, pointer)} onOpen={(current) => onOpenText?.(value as string, current, pointer)} />}
    </div>
    {open && <div role="group">{entries.map(([key, child]) => <ValueTree key={key} value={child} label={key} level={level + 1} initiallyExpanded={initiallyExpanded} maxDepth={maxDepth} jsonPath={childPath(key)} pointer={childPointer(key)} onMenu={onMenu} onLongText={onLongText} onCopyText={onCopyText} onOpenText={onOpenText} />)}</div>}
  </>;
}

interface ServerTreeNodeProps {
  nodeId: string; level: number; tree: TreeState; summary: WebviewSummary;
  dispatch: React.Dispatch<Parameters<typeof reducer>[1]>;
  requestChildren(node: JsonNodeView, offset: number): void;
  onMenu(event: React.MouseEvent, node: JsonNodeView): void;
  onLongText(text: string): void; onCopyText(text: string): void; onOpenText(text: string, current: boolean): void;
}

const ServerTreeNode = memo(function ServerTreeNodeComponent({ nodeId, level, tree, summary, dispatch, requestChildren, onMenu, onLongText, onCopyText, onOpenText }: ServerTreeNodeProps): ReactNode {
  const find = useContext(TreeFindContext);
  const node = tree.nodes[nodeId] ?? find?.nodes?.get(nodeId);
  if (!node) throw new Error(`Tree node ${nodeId} is missing.`);
  const expandable = node.childrenCount > 0;
  const searchPage = find?.pages?.get(nodeId);
  const autoOpen = tree.nodes[nodeId] !== undefined && tree.mode === 'expanded' && level <= maxAutoDepth(summary) && !tree.manuallyCollapsed.has(nodeId);
  const open = expandable && (tree.expanded.has(nodeId) || autoOpen || Boolean(searchPage));
  const loaded = tree.loadedCount[nodeId] ?? 0;
  const loading = tree.loading.has(nodeId);
  useEffect(() => {
    if (open && loaded === 0 && node.childrenCount > 0 && !loading && !searchPage) requestChildren(node, 0);
  }, [loaded, loading, node, open, requestChildren, searchPage]);
  const toggle = () => { if (expandable && !searchPage) dispatch({ type: 'toggleNode', nodeId, open: !open }); };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!expandable || searchPage) return;
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); }
    if (event.key === 'ArrowRight' && !open) { event.preventDefault(); dispatch({ type: 'toggleNode', nodeId, open: true }); }
    if (event.key === 'ArrowLeft' && open) { event.preventDefault(); dispatch({ type: 'toggleNode', nodeId, open: false }); }
  };
  const text = node.displayValue ?? (node.type === 'null' ? 'null' : '');
  const scalar = node.type === 'number' ? Number(text) : node.type === 'boolean' ? text === 'true' : node.type === 'null' ? null : text;
  const normalChildren = tree.children[nodeId] ?? [];
  const extra = searchPage?.nodes.slice(Math.max(0, loaded - searchPage.offset)).map((child) => child.nodeId) ?? [];
  const hasGap = searchPage !== undefined && searchPage.offset > loaded && extra.length > 0;
  const canLoadMore = loaded < node.childrenCount && (hasGap || loaded + extra.length < node.childrenCount);
  const more = canLoadMore && <button className="tree-load-more" type="button" disabled={loading} style={{ '--level': level } as CSSProperties} onClick={() => requestChildren(node, loaded)}>{loading ? tr('loading') : tr('loadMore', { loaded, total: node.childrenCount })}</button>;
  const renderChild = (childId: string) => <ServerTreeNode key={childId} nodeId={childId} level={level + 1} tree={tree} summary={summary} dispatch={dispatch} requestChildren={requestChildren} onMenu={onMenu} onLongText={onLongText} onCopyText={onCopyText} onOpenText={onOpenText} />;
  return <>
    <div className={`tree-row ${expandable ? 'expandable' : ''}`} role="treeitem" aria-level={level} aria-expanded={expandable ? open : undefined} tabIndex={0}
      style={{ '--level': level - 1 } as CSSProperties} onClick={toggle} onKeyDown={onKeyDown}
      onContextMenu={(event) => { event.preventDefault(); onMenu(event, node); }}>
      <ChevronRightIcon className={`chevron ${open ? 'open' : ''}`} aria-hidden />
      <span className="json-key">{node.key ?? '@'}</span>
      {node.type === 'object' || node.type === 'array' ? <span className={`shape shape-${node.type}`}>{node.type === 'array' ? '[ ]' : '{ }'}&nbsp; {node.childrenCount}</span>
        : <JsonScalarValue text={text} kind={node.type} scalar={scalar} findId={nodeId} {...(node.key === undefined ? {} : { field: node.key })} actions={node.type === 'string'} onExpand={() => onLongText(text)} onCopy={() => onCopyText(text)} onOpen={(current) => onOpenText(text, current)} />}
      {loading && <span className="loading-label">{tr('loading')}</span>}
    </div>
    {open && <div role="group">
      {normalChildren.map(renderChild)}
      {hasGap && <>
        {more}
        <div className="tree-search-window" style={{ '--level': level } as CSSProperties}>{tr('resultWindow', { first: searchPage.offset + 1, last: searchPage.offset + searchPage.nodes.length })}</div>
      </>}
      {extra.map(renderChild)}
      {!hasGap && more}
    </div>}
  </>;
}, (previous, next) => {
  if (previous.nodeId !== next.nodeId || previous.level !== next.level || previous.summary !== next.summary || previous.tree.mode !== next.tree.mode) return false;
  if (previous.dispatch !== next.dispatch || previous.requestChildren !== next.requestChildren || previous.onMenu !== next.onMenu || previous.onLongText !== next.onLongText || previous.onCopyText !== next.onCopyText || previous.onOpenText !== next.onOpenText) return false;
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

function Toolbar({ summary, query, onQuery, onFormat, onRepair, onExport, onOpenSource, jsonSearch }: {
  summary: WebviewSummary; query: string; onQuery(value: string): void; onFormat(): void; onRepair(): void; onExport(): void; onOpenSource(): void;
  jsonSearch: { mode: JsonSearchMode; onMode(mode: JsonSearchMode): void; navigation?: FindNavigation; error?: string };
}): ReactNode {
  const placeholder = summary.kind === 'json' ? tr('searchJson') : tr('searchJsonl');
  const { mode, onMode, ...find } = jsonSearch;
  return <header className="toolbar">
    <div className="brand"><span className="brand-mark"><BrandIcon /></span><span className="brand-title">{summary.kind === 'json' ? 'JSON Preview' : 'JSONL Preview'}</span></div>
    {summary.kind === 'json'
      ? <FindBar className="document-find" query={query} label={placeholder} onQuery={onQuery} {...find} />
      : <Input className="search-input" type="search" value={query} placeholder={placeholder} aria-label={placeholder} clearable prefixIcon={<SearchIcon />} onChange={onQuery} />}
    <div className="toolbar-actions flex items-center gap-2">
      {summary.kind === 'json' ? <>
        <IconAction label={tr('format')} icon={<FormatPainterIcon />} onClick={onFormat} />
        <IconAction label={tr('repair')} icon={<ToolsIcon />} onClick={onRepair} />
        <SearchModeButton mode={mode} onMode={onMode} />
      </> : <IconAction label={tr('export')} icon={<FileExportIcon />} onClick={onExport} />}
      <IconAction label={tr('source')} icon={<CodeIcon />} onClick={onOpenSource} primary />
    </div>
  </header>;
}

function StatusBar({ summary, extra, progress }: { summary: WebviewSummary; extra?: string; progress?: number }): ReactNode {
  const errors = tr(summary.errorsComplete === false ? 'errorsFound' : 'errors', { count: summary.errors });
  const items = [formatBytes(summary.byteLength), summary.kind === 'jsonl' ? tr('records', { count: summary.recordCount ?? 0 }) : undefined, errors, `${Math.round(summary.parseMilliseconds)} ms`, progress === undefined ? undefined : tr('indexed', { count: progress }), extra].filter(Boolean);
  return <div className="statusbar">{items.map((item) => <span key={String(item)}>{item}</span>)}</div>;
}

function JsonTreeView({ state, dispatch, requestChildren, onServerMenu, onValueMenu, openText, copyText, openTextTab }: {
  state: AppState; dispatch: React.Dispatch<Parameters<typeof reducer>[1]>; requestChildren(node: JsonNodeView, offset: number): void;
  onServerMenu(event: React.MouseEvent, node: JsonNodeView): void;
  onValueMenu(event: React.MouseEvent, key: string | undefined, value: unknown, path?: string): void;
  openText(text: string): void; copyText(text: string): void; openTextTab(text: string, current: boolean): void;
}): ReactNode {
  const summary = state.summary!;
  const result = state.searchResult;
  const target = result && 'matchCount' in result ? result.target : undefined;
  const query = result?.query ?? '';
  const match = useMemo(() => scalarMatches(query), [query]);
  const find = useMemo((): TreeFind | undefined => {
    if (!target) return undefined;
    const pages = new Map(target.pages.map((page) => [page.parentId, page]));
    const nodes = new Map<string, JsonNodeView>();
    for (const page of target.pages) for (const node of page.nodes) nodes.set(node.nodeId, node);
    return { matches: match, active: { id: target.nodeId, occurrence: target.occurrence }, ancestors: new Set(pages.keys()), pages, nodes };
  }, [match, target]);
  const tree = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (target) tree.current?.querySelector('[data-active-match="true"]')?.scrollIntoView?.({ block: 'center' });
  }, [target]);
  if (result && 'result' in result) return <section className="surface tree-surface">
    <div className="surface-heading"><span className="surface-title">{tr('queryResult')}</span></div>
    <div className="tree" role="tree" aria-label={tr('queryResultAria')}><ValueTree key={result.query} value={result.result} maxDepth={maxAutoDepth(summary)} jsonPath="@" onMenu={onValueMenu} onLongText={openText} onCopyText={copyText} onOpenText={openTextTab} /></div>
  </section>;
  return <section className="surface tree-surface">
    <div className="surface-heading">
      <span className="surface-title">{tr('structure')}</span>
      {summary.root && <Button variant="text" size="small" onClick={() => dispatch({ type: 'treeMode', mode: state.tree.mode === 'expanded' ? 'collapsed' : 'expanded' })}>{state.tree.mode === 'expanded' ? tr('collapseAll') : tr('expandAll')}</Button>}
    </div>
    <div className="tree" ref={tree} role="tree" aria-label={tr('structure')}>
      {!summary.root ? <div className="empty-state"><span className="empty-icon">!</span><h2>{tr('invalidJson')}</h2>{(summary.diagnostics ?? []).map((diagnostic) => <div className="error" key={`${diagnostic.offset}-${diagnostic.code}`}>{tr('location', { line: diagnostic.line, column: diagnostic.column })} · {diagnostic.message}</div>)}</div>
        : <TreeFindContext.Provider value={find}><ServerTreeNode nodeId={summary.root.nodeId} level={1} tree={state.tree} summary={summary} dispatch={dispatch} requestChildren={requestChildren} onMenu={onServerMenu} onLongText={openText} onCopyText={copyText} onOpenText={openTextTab} /></TreeFindContext.Provider>}
    </div>
  </section>;
}

type LocalSearch = { result: unknown } | { groups: MatchGroup<string>[]; count: number } | { error: string };

function searchRecord(value: unknown, query: string, mode: JsonSearchMode, time: TimeDisplayOptions): LocalSearch {
  try {
    const projection = queryProjection(() => value, query);
    if (projection) {
      checkQueryResultSize(projection.result);
      return projection;
    }
    const match = scalarMatches(query);
    const groups: MatchGroup<string>[] = [];
    const result: unknown[] = [];
    const pending: Array<{ node: unknown; pointer: string; field?: string }> = [{ node: value, pointer: '' }];
    let count = 0;
    while (pending.length) {
      const { node, pointer, field } = pending.pop()!;
      if (isContainer(node)) {
        const entries = Object.entries(node);
        for (let i = entries.length - 1; i >= 0; i--) {
          const [key, child] = entries[i]!;
          pending.push({ node: child, pointer: `${pointer}/${pointerSegment(key)}`, field: key });
        }
      } else {
        const ranges = scalarRanges(match, String(node), node, field, time);
        if (mode === 'filter') {
          if (!ranges.next().done) result.push(node);
          continue;
        }
        const first = count;
        for (const _ of ranges) count++;
        if (count > first) groups.push({ node: pointer, first });
      }
    }
    if (mode === 'filter') {
      checkQueryResultSize(result);
      return { result: result.reverse() };
    }
    return { groups, count };
  } catch (error) {
    return { error: messageOf(error) };
  }
}

function RecordTreeView({ value, summary, mode, shortcutEnabled, onMenu, onLongText, onCopyText, onOpenText, openResultText, copyResultText, openResultTab }: {
  value: unknown; summary: WebviewSummary; mode: JsonSearchMode; shortcutEnabled: boolean;
  onMenu: NonNullable<Parameters<typeof ValueTree>[0]['onMenu']>;
  onLongText(text: string, pointer?: string): void;
  onCopyText(text: string, pointer?: string): void;
  onOpenText(text: string, current: boolean, pointer?: string): void;
  openResultText(text: string): void; copyResultText(text: string): void; openResultTab(text: string, current: boolean): void;
}): ReactNode {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [index, setIndex] = useState(0);
  const tree = useRef<HTMLDivElement>(null);
  const trimmed = query.trim();
  useEffect(() => { setIndex(0); }, [mode]);
  useEffect(() => {
    if (!shortcutEnabled) return;
    const handleSearchKeys = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && query) {
        event.preventDefault();
        event.stopPropagation();
        setQuery('');
        setIndex(0);
      } else if (isFindShortcut(event)) {
        event.preventDefault();
        event.stopPropagation();
        const input = tree.current?.parentElement?.querySelector<HTMLInputElement>('.record-find input');
        input?.focus();
        input?.select();
      }
    };
    window.addEventListener('keydown', handleSearchKeys, true);
    return () => window.removeEventListener('keydown', handleSearchKeys, true);
  }, [query, shortcutEnabled]);
  useEffect(() => {
    if (!trimmed) { setDebouncedQuery(''); return; }
    const timer = window.setTimeout(() => setDebouncedQuery(trimmed), 180);
    return () => window.clearTimeout(timer);
  }, [trimmed]);
  const search = useMemo(() => trimmed && trimmed === debouncedQuery ? searchRecord(value, trimmed, mode, summary) : undefined,
    [debouncedQuery, mode, summary, trimmed, value]);
  const result = search && 'result' in search ? search : undefined;
  const error = search && 'error' in search ? search.error : undefined;
  const total = search && 'count' in search ? search.count : 0;
  const group = search && 'groups' in search ? matchGroupAt(search.groups, index) : undefined;
  const match = useMemo(() => scalarMatches(trimmed), [trimmed]);
  const find = useMemo((): TreeFind | undefined => {
    if (!group) return undefined;
    const ancestors = new Set<string>();
    for (let end = group.node.lastIndexOf('/'); end >= 0; end = group.node.lastIndexOf('/', end - 1)) {
      ancestors.add(group.node.slice(0, end));
      if (end === 0) break;
    }
    return { matches: match, active: { id: group.node, occurrence: index - group.first }, ancestors };
  }, [group, index, match]);
  useEffect(() => {
    if (find) tree.current?.querySelector('[data-active-match="true"]')?.scrollIntoView?.({ block: 'center' });
  }, [find]);
  return <div className="drawer-content">
    <FindBar className="record-find" label={tr('searchRecord')} query={query}
      onQuery={(text) => { setQuery(text.slice(0, 1024)); setIndex(0); }}
      {...(error ? { error } : {})}
      {...(mode === 'reveal' && !result && !error ? { navigation: { index, total, move: (direction: 1 | -1) => setIndex((current) => nextMatchIndex(current, total, direction)) } } : {})} />
    <div className="tree drawer-tree" ref={tree} role="tree" aria-label={tr('structure')} hidden={Boolean(result)}>
      <TreeFindContext.Provider value={find}>
        <ValueTree value={value} maxDepth={maxAutoDepth(summary)} jsonPath="@" pointer="" onMenu={onMenu}
          onLongText={onLongText} onCopyText={onCopyText} onOpenText={onOpenText} />
      </TreeFindContext.Provider>
    </div>
    {result && <div className="tree drawer-tree" role="tree" aria-label={tr('queryResultAria')}>
      <ValueTree key={trimmed} value={result.result} maxDepth={maxAutoDepth(summary)} jsonPath="@" onMenu={onMenu}
        onLongText={openResultText} onCopyText={copyResultText} onOpenText={openResultTab} />
    </div>}
  </div>;
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
            {fields.map((field) => { const shown = displayValue(row.cells[field], summary, field); return <div className="cell" role="gridcell" key={field}><span className={`cell-value value-${valueKind(row.cells[field])}`} title={shown.title ?? shown.text}>{shown.text}</span></div>; })}
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
    attrs: ({ type, row }) => type === 'th' ? { 'aria-sort': ariaSort(field), onClick: (event: React.MouseEvent) => { if (!(event.target as Element).closest('.t-table__sort-icon')) onSort(field); } } : { onContextMenu: (event: React.MouseEvent) => onCellMenu(event, row, row.cells[field], displayValue(row.cells[field], summary, field).text, field) },
    cell: ({ row }) => { const shown = displayValue(row.cells[field], summary, field); return <span className={`cell-value value-${valueKind(row.cells[field])}`} title={shown.title ?? shown.text}>{shown.text}</span>; }
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
const MemoizedJsonlGrid = memo(JsonlGrid);

export function App(): ReactNode {
  const initialView = vscode.getState() ?? {};
  const [state, dispatch] = useReducer(reducer, initialView, createInitialState);
  const stateRef = useRef(state); stateRef.current = state;
  const queryRevision = useRef(0), searchRevision = useRef(0);
  const requestedMatch = useRef(0);
  const childRequests = useRef(new Set<string>());
  const lastCriteria = useRef<string | undefined>(undefined);
  const [menu, setMenu] = useState<MenuState>();
  const [drawer, setDrawer] = useState<DrawerState>();
  const [fullText, setFullText] = useState<FullTextState>();
  const [toast, setToast] = useState<string>();
  const [altPressed, setAltPressed] = useState(false);
  const initialized = useRef(false);

  const announce = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast((current) => current === message ? undefined : current), 1600);
  }, []);
  const copied = useCallback((text: string) => { send({ type: 'copy', text }); }, []);
  const openTextTab = useCallback((text: string, current: boolean) => {
    if (current) send({ type: 'openCurrent', text: temporaryText(text) });
    else send({ type: 'openTemp', text: temporaryText(text) });
  }, []);

  const invalidateJsonSearch = useCallback(() => {
    requestedMatch.current = 0;
    dispatch({ type: 'startSearch', searchRevision: ++searchRevision.current });
  }, []);

  const changeToolbarQuery = useCallback((query: string) => {
    if (stateRef.current.summary?.kind === 'json') {
      query = query.slice(0, 1024);
      if (query === stateRef.current.view.query) return;
      invalidateJsonSearch();
    }
    dispatch({ type: 'setQuery', query });
  }, [invalidateJsonSearch]);

  const rememberSearchMode = useCallback((mode: JsonSearchMode) => {
    dispatch({ type: 'searchPreferences', preferences: { ...stateRef.current.searchPreferences, lastMode: mode } });
    send({ type: 'setSearchMode', mode });
  }, []);

  const changeDocumentMode = useCallback((mode: JsonSearchMode) => {
    invalidateJsonSearch();
    dispatch({ type: 'setSearchMode', mode });
    rememberSearchMode(mode);
  }, [invalidateJsonSearch, rememberSearchMode]);

  const changeRecordMode = useCallback((mode: JsonSearchMode) => {
    setDrawer((current) => current && { ...current, searchMode: mode });
    rememberSearchMode(mode);
  }, [rememberSearchMode]);

  const requestJsonSearch = useCallback((query: string, mode: JsonSearchMode, matchIndex = 0) => {
    const revision = ++searchRevision.current;
    dispatch({ type: 'startSearch', searchRevision: revision });
    send({ type: 'jsonSearch', query, mode, searchRevision: revision, matchIndex, systemTimezone: SYSTEM_TIMEZONE });
  }, []);

  const moveDocumentMatch = useCallback((direction: 1 | -1) => {
    const current = stateRef.current.searchResult;
    if (!current || !('matchCount' in current) || current.matchCount === 0) return;
    requestedMatch.current = nextMatchIndex(requestedMatch.current, current.matchCount, direction);
    requestJsonSearch(current.query, 'reveal', requestedMatch.current);
  }, [requestJsonSearch]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => { if (event.key === 'Alt') setAltPressed(true); };
    const onKeyUp = (event: globalThis.KeyboardEvent) => { if (event.key === 'Alt') setAltPressed(false); };
    const onBlur = () => setAltPressed(false);
    window.addEventListener('keydown', onKeyDown); window.addEventListener('keyup', onKeyUp); window.addEventListener('blur', onBlur);
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp); window.removeEventListener('blur', onBlur); };
  }, []);

  const recordDrawer = useCallback((physicalLine: number, text: string, searchMode: JsonSearchMode): DrawerState => ({
    title: tr('line', { line: physicalLine }), physicalLine, searchMode,
    value: (() => { try { return JSON.parse(text) as unknown; } catch { return undefined; } })(), text
  }), []);

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      if (!isHostMessage(event.data)) return;
      const message = event.data as HostMessage;
      if (message.type === 'init') {
        setLocale(message.summary.locale);
        initialized.current = true;
        lastCriteria.current = undefined;
        childRequests.current.clear();
        invalidateJsonSearch();
        setDrawer(undefined);
        setFullText(undefined);
        dispatch({ type: 'init', summary: message.summary, view: message.uiState, ...(message.searchPreferences ? { searchPreferences: message.searchPreferences } : {}) });
      }
      else if (message.type === 'children') {
        childRequests.current.delete(`${message.generation}:${message.parentId}:${message.offset}`);
        dispatch({ type: 'treeChildren', generation: message.generation, parentId: message.parentId, offset: message.offset, nodes: message.nodes });
      }
      else if (message.type === 'page') dispatch({ type: 'page', queryRevision: message.queryRevision, offset: message.offset, page: { rows: message.rows, total: message.total, scannedRows: message.scannedRows, matchedRows: message.matchedRows, isComplete: message.isComplete, ...(message.errors === undefined ? {} : { errors: message.errors }), ...(message.errorsComplete === undefined ? {} : { errorsComplete: message.errorsComplete }) } });
      else if (message.type === 'record') setDrawer((current) => current?.physicalLine === message.physicalLine ? recordDrawer(message.physicalLine, message.content, current.searchMode) : current);
      else if (message.type === 'copied') announce(tr('copied'));
      else if (message.type === 'search' || message.type === 'searchError') dispatch(message);
      else if (message.type === 'searchPreferences') dispatch({ type: 'searchPreferences', preferences: message });
      else if (message.type === 'progress') dispatch({ type: 'progress', records: message.records });
      else if (message.type === 'error') {
        childRequests.current.clear();
        dispatch({ type: 'error', message: message.message });
      }
    };
    window.addEventListener('message', onMessage); send({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, [announce, invalidateJsonSearch, recordDrawer]);

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
    if (summary?.kind !== 'json' || !initialized.current) return;
    const query = state.view.query?.trim() ?? '';
    if (!query) return;
    const timer = window.setTimeout(() => requestJsonSearch(query, state.searchMode), 180);
    return () => window.clearTimeout(timer);
  }, [state.summary?.kind, state.tree.generation, state.view.query, state.searchMode, requestJsonSearch]);

  useEffect(() => {
    const summary = stateRef.current.summary;
    if (summary?.kind !== 'jsonl' || !initialized.current) return;
    const timer = window.setTimeout(() => {
      const query = state.view.query?.trim() ?? '';
      const revision = ++queryRevision.current;
      dispatch({ type: 'startQuery', queryRevision: revision });
      const sort = sortSpec(state.view.sort, summary.fieldPointers);
      const criteria = JSON.stringify({ query, sort });
      const hasPreviousRequest = lastCriteria.current !== undefined;
      lastCriteria.current = criteria;
      if (query || sort || hasPreviousRequest) send({ type: 'query', queryRevision: revision, ...(query ? { jmesPath: query, systemTimezone: SYSTEM_TIMEZONE } : {}), ...(sort ? { sort } : {}) });
      else send({ type: 'page', offset: 0, queryRevision: revision });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [state.tree.generation, state.view.query, state.view.sort]);

  useEffect(() => {
    if (drawer || fullText || state.summary?.kind !== 'json') return;
    const handleSearchKeys = (event: globalThis.KeyboardEvent) => {
      const input = document.querySelector<HTMLInputElement>('.document-find input');
      if (event.key === 'Escape' && input === document.activeElement && input?.value) {
        event.preventDefault();
        changeToolbarQuery('');
      } else if (input && isFindShortcut(event)) {
        event.preventDefault();
        input.focus();
        input.select();
      }
    };
    window.addEventListener('keydown', handleSearchKeys, true);
    return () => window.removeEventListener('keydown', handleSearchKeys, true);
  }, [changeToolbarQuery, drawer, fullText, state.summary?.kind]);

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
      { label: tr('copyJson'), icon: <CopyIcon />, action: () => send({ type: 'copy', nodeId: node.nodeId, format: 'pretty' }) },
      { label: tr('copyPath'), icon: <CodeIcon />, action: () => copied(node.jsonPath) },
      { label: tr('openTemp'), alternateLabel: tr('openCurrent'), icon: <TabIcon />, alternateIcon: <EnterIcon />, action: (current) => node.type === 'string' && node.displayValue !== undefined ? send({ type: current ? 'openCurrent' : 'openTemp', text: temporaryText(node.displayValue) }) : send({ type: current ? 'openCurrent' : 'openTemp', nodeId: node.nodeId }) }
    ];
    setMenu({ x: event.clientX, y: event.clientY, items });
  }, [copied]);

  const onValueMenu = useCallback((event: React.MouseEvent, key: string | undefined, value: unknown, path?: string) => {
    const items: MenuItem[] = [
      ...(key !== undefined ? [{ label: tr('copyKey'), icon: <KeyIcon />, action: () => copied(key) }] : []),
      { label: tr('copyValue'), icon: <CopyIcon />, action: () => copied(typeof value === 'string' ? value : jsonText(value)) },
      ...(path !== undefined ? [{ label: tr('copyPath'), icon: <CodeIcon />, action: () => copied(path) }] : []),
      { label: tr('openTemp'), alternateLabel: tr('openCurrent'), icon: <TabIcon />, alternateIcon: <EnterIcon />, action: (current) => send({ type: current ? 'openCurrent' : 'openTemp', text: temporaryText(value) }) }
    ];
    setMenu({ x: event.clientX, y: event.clientY, items });
  }, [copied]);
  const onCellMenu = useCallback((event: React.MouseEvent, row: JsonlRow, cellValue: unknown, cellText: string, field?: string) => {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, items: [
      { label: tr('copyLine'), icon: <CopyIcon />, action: () => { if (row.rawTruncated) send({ type: 'copy', physicalLine: row.physicalLine }); else copied(row.raw); } },
      { label: tr('copyCell'), icon: <CopyIcon />, action: () => {
        const pointer = field ? stateRef.current.summary?.fieldPointers?.[field] : undefined;
        if (field && row.truncatedCells?.includes(field) && pointer !== undefined) send({ type: 'copy', physicalLine: row.physicalLine, pointer });
        else copied(cellText);
      } },
      { label: tr('openRowTemp'), alternateLabel: tr('openRowCurrent'), icon: <TabIcon />, alternateIcon: <EnterIcon />, action: (current) => send({ type: current ? 'openCurrent' : 'openTemp', physicalLine: row.physicalLine }) },
      ...(cellValue !== undefined ? [{ label: tr('openCellTemp'), alternateLabel: tr('openCellCurrent'), icon: <TabIcon />, alternateIcon: <EnterIcon />, action: (current: boolean) => field
        ? send({ type: current ? 'openCurrent' : 'openTemp', physicalLine: row.physicalLine, field })
        : send({ type: current ? 'openCurrent' : 'openTemp', text: temporaryText(cellValue) }) }] : [])
    ] });
  }, [copied]);
  const onFullTextMenu = useCallback((event: React.MouseEvent<HTMLElement>) => {
    const text = selectedTextWithin(event.currentTarget);
    if (text === undefined) return;
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, items: [
      { label: tr('copySelected'), icon: <CopyIcon />, action: () => copied(text) },
      { label: tr('openSelectedTemp'), alternateLabel: tr('openCurrent'), icon: <TabIcon />, alternateIcon: <EnterIcon />, action: (current) => send({ type: current ? 'openCurrent' : 'openTemp', text }) }
    ] });
  }, [copied]);
  const openLongText = useCallback((text: string) => setFullText({ text }), []);

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

  const onSort = useCallback((field?: string, direction?: 'asc' | 'desc') => {
    const current = stateRef.current.view.sort;
    if (!field) dispatch({ type: 'setSort' });
    else if (direction) dispatch({ type: 'setSort', sort: { field, direction } });
    else if (field === PHYSICAL_LINE_SORT) dispatch({ type: 'setSort', sort: { field, direction: current?.field === field || !current ? current?.direction === 'desc' ? 'asc' : 'desc' : 'asc' } });
    else if (current?.field === field && current.direction === 'desc') dispatch({ type: 'setSort' });
    else dispatch({ type: 'setSort', sort: { field, direction: current?.field === field ? 'desc' : 'asc' } });
  }, []);
  const onColumnWidthsChange = useCallback((columnWidths: Record<string, number>) => {
    dispatch({ type: 'setColumnWidths', columnWidths: { ...stateRef.current.view.columnWidths, ...columnWidths } });
  }, []);
  const onPage = useCallback((offset: number) => {
    dispatch({ type: 'requestPage', offset });
    send({ type: 'page', offset, queryRevision: stateRef.current.queryRevision });
  }, []);
  const onRecord = useCallback((row: JsonlRow) => {
    const searchMode = initialSearchMode(stateRef.current.searchPreferences);
    if (!row.rawTruncated) { setDrawer(recordDrawer(row.physicalLine, row.raw, searchMode)); return; }
    setDrawer({ title: tr('line', { line: row.physicalLine }), physicalLine: row.physicalLine, searchMode, loading: true });
    send({ type: 'record', physicalLine: row.physicalLine });
  }, [recordDrawer]);

  const summary = state.summary;
  useEffect(() => { document.querySelector('#app')?.setAttribute('aria-busy', String(!summary)); }, [summary]);
  if (!summary) return <main className="loading-screen"><span className="loading-spinner" aria-hidden /><span>{tr('preparing')}</span></main>;
  const extra = summary.kind === 'json' ? (state.searchResult?.query ? tr('expression', { value: state.searchResult.query }) : undefined) : tr('results', { count: state.page.total });
  const match = state.searchResult && 'matchCount' in state.searchResult ? state.searchResult : undefined;
  const showNavigation = state.searchMode === 'reveal' && !state.searchError && (!state.searchResult || match);
  const hasDrawerContent = drawer && !drawer.loading && drawer.text !== undefined;
  return <TimeDisplayContext.Provider value={summary}><AltKeyContext.Provider value={altPressed}><main className={summary.kind === 'jsonl' ? 'jsonl-layout' : undefined}>
    <Toolbar summary={summary} query={state.view.query ?? ''} onQuery={changeToolbarQuery} onFormat={() => send({ type: 'format' })} onRepair={() => send({ type: 'repair' })} onExport={() => send({ type: 'export', queryRevision: state.queryRevision })} onOpenSource={() => send({ type: 'openSource' })}
      jsonSearch={{ mode: state.searchMode, onMode: changeDocumentMode, ...(state.searchError ? { error: state.searchError } : {}),
        ...(showNavigation ? { navigation: { index: match?.matchIndex ?? 0, total: match?.matchCount ?? 0, move: moveDocumentMatch } } : {}) }} />
    <StatusBar summary={summary} extra={extra} progress={state.progressRecords} />
    {summary.kind === 'json'
      ? <JsonTreeView state={state} dispatch={dispatch} requestChildren={requestChildren} onServerMenu={onServerMenu} onValueMenu={onValueMenu} openText={openLongText} copyText={copied} openTextTab={openTextTab} />
      : <MemoizedJsonlGrid state={state} onSort={onSort} onPage={onPage} onRecord={onRecord} onCellMenu={onCellMenu} onColumnWidthsChange={onColumnWidthsChange} />}
    {menu && <ContextMenu menu={menu} close={() => setMenu(undefined)} />}
    <Drawer visible={Boolean(drawer)} placement="right" size="66.6667vw" header={drawer && <DrawerHeader title={drawer.title} actions={hasDrawerContent && <>
      {drawer.value !== undefined && <SearchModeButton mode={drawer.searchMode} onMode={changeRecordMode} />}
      <IconAction label={tr('copyLine')} icon={<CopyIcon />} onClick={() => drawer.physicalLine ? send({ type: 'copy', physicalLine: drawer.physicalLine }) : copied(drawer.text!)} />
      <IconAction label={tr(altPressed ? 'currentTab' : 'tempTab')} tooltip={tr(altPressed ? 'openCurrent' : 'openTempHint')}
        icon={altPressed ? <EnterIcon /> : <TabIcon />} onClick={(event) => {
          const type = event.altKey || altPressed ? 'openCurrent' : 'openTemp';
          send(drawer.physicalLine ? { type, physicalLine: drawer.physicalLine } : { type, text: drawer.text! });
        }} />
    </>} />} footer={false} closeBtn showOverlay closeOnOverlayClick preventScrollThrough={false} closeOnEscKeydown onClose={() => setDrawer(undefined)}>
      {drawer && <div className="drawer-content">
        {drawer.loading ? <div className="drawer-loading"><span className="loading-spinner" aria-hidden /><span>{tr('loading')}</span></div>
          : drawer.value !== undefined ? <RecordTreeView key={drawer.physicalLine} value={drawer.value} summary={summary} mode={drawer.searchMode} shortcutEnabled={!fullText} onMenu={onValueMenu}
            onLongText={(text, pointer) => setFullText({ text, ...(drawer.physicalLine && pointer !== undefined ? { physicalLine: drawer.physicalLine, pointer } : {}) })}
            onCopyText={(text, pointer) => drawer.physicalLine && pointer !== undefined ? send({ type: 'copy', physicalLine: drawer.physicalLine, pointer }) : copied(text)}
            onOpenText={(text, current, pointer) => drawer.physicalLine && pointer !== undefined ? send({ type: current ? 'openCurrent' : 'openTemp', physicalLine: drawer.physicalLine, pointer }) : openTextTab(text, current)}
            openResultText={openLongText} copyResultText={copied} openResultTab={openTextTab} />
          : hasDrawerContent && <FullContentView key={drawer.physicalLine} text={drawer.text!} inline shortcutEnabled={!fullText} onContextMenu={onFullTextMenu} />}
      </div>}
    </Drawer>
    <Drawer visible={fullText !== undefined} placement="right" size="66.6667vw" header={<DrawerHeader title={tr('fullContent')} actions={fullText !== undefined && <Button size="small" variant="outline" icon={<CopyIcon />} onClick={() => fullText.physicalLine && fullText.pointer !== undefined ? send({ type: 'copy', physicalLine: fullText.physicalLine, pointer: fullText.pointer }) : copied(fullText.text)}>{tr('copyContent')}</Button>} />} footer={false} closeBtn showOverlay closeOnOverlayClick preventScrollThrough={false} closeOnEscKeydown onClose={() => setFullText(undefined)}>
      {fullText !== undefined && <FullContentView text={fullText.text} onContextMenu={onFullTextMenu} />}
    </Drawer>
    {state.error && <div className="toast error-toast" role="alert" onClick={() => dispatch({ type: 'clearError' })}>{state.error}</div>}
    {toast && <div className="toast" role="status">{toast}</div>}
    <div className="sr-only" aria-live="polite" aria-atomic="true">{toast ?? state.error ?? ''}</div>
  </main></AltKeyContext.Provider></TimeDisplayContext.Provider>;
}
