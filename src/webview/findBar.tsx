import type { ReactNode } from 'react';
import Input from 'tdesign-react/es/input';
import ChevronDownIcon from 'tdesign-icons-react/esm/components/chevron-down';
import ChevronUpIcon from 'tdesign-icons-react/esm/components/chevron-up';
import CloseIcon from 'tdesign-icons-react/esm/components/close';
import SearchIcon from 'tdesign-icons-react/esm/components/search';
import FilterIcon from 'tdesign-icons-react/esm/components/filter';
import type { JsonSearchMode, MatchRange } from '../shared/jsonSearch.js';
import { IconAction } from './iconAction.js';
import { tr } from './i18n.js';

export interface FindNavigation {
  index: number;
  total: number;
  move(direction: 1 | -1): void;
}

export function nextMatchIndex(index: number, total: number, direction: 1 | -1): number {
  return total ? (index + direction + total) % total : 0;
}

export function isFindShortcut(event: KeyboardEvent): boolean {
  return event.key.toLowerCase() === 'f' && (event.ctrlKey || event.metaKey) && !event.altKey;
}

const modeLabel = (mode: JsonSearchMode) => tr(mode === 'filter' ? 'searchFilter' : 'searchReveal');

export function SearchModeButton({ mode, onMode }: { mode: JsonSearchMode; onMode(mode: JsonSearchMode): void }): ReactNode {
  const next = mode === 'filter' ? 'reveal' : 'filter';
  return <IconAction label={modeLabel(mode)} icon={mode === 'filter' ? <FilterIcon /> : <SearchIcon />}
    tooltip={tr('searchModeToggle', { mode: modeLabel(mode), next: modeLabel(next) })}
    onClick={() => onMode(next)} />;
}

export function FindBar({ query, label, onQuery, className = '', navigation, onClose, error }: {
  query: string;
  label: string;
  onQuery(query: string): void;
  className?: string;
  navigation?: FindNavigation;
  onClose?(): void;
  error?: string;
}): ReactNode {
  return <div className={`find-bar ${className}`}>
    <div className="find-controls">
      <label className="drawer-search-input">
        <span className="sr-only">{label}</span>
        <Input type="search" value={query} placeholder={label} status={error ? 'error' : 'default'} clearable prefixIcon={<SearchIcon />}
          onChange={onQuery} onEnter={(_, context) => {
            if (!context.e.nativeEvent.isComposing) navigation?.move(context.e.shiftKey ? -1 : 1);
          }} />
      </label>
      {navigation && <>
        <span className="match-count" aria-live="polite">{tr('matchCount', { current: navigation.total ? navigation.index + 1 : 0, total: navigation.total })}</span>
        <button type="button" className="match-navigation" title={tr('previousMatch')} aria-label={tr('previousMatch')} disabled={!navigation.total} onClick={() => navigation.move(-1)}><ChevronUpIcon /></button>
        <button type="button" className="match-navigation" title={tr('nextMatch')} aria-label={tr('nextMatch')} disabled={!navigation.total} onClick={() => navigation.move(1)}><ChevronDownIcon /></button>
      </>}
      {onClose && <button type="button" className="match-navigation search-close" title={tr('closeSearch')} aria-label={tr('closeSearch')} onClick={onClose}><CloseIcon /></button>}
    </div>
    {error && <div className="find-error" role="alert">{error}</div>}
  </div>;
}

export function highlightMatches(text: string, matches: Iterable<MatchRange>, activeIndex: number): ReactNode {
  const parts: ReactNode[] = [];
  let position = 0, index = 0;
  for (const match of matches) {
    const active = index++ === activeIndex;
    parts.push(text.slice(position, match.start),
      <mark key={match.start} className={active ? 'find-highlight active-match' : 'find-highlight'} data-active-match={active}>{text.slice(match.start, match.end)}</mark>);
    position = match.end;
  }
  if (!parts.length) return text;
  parts.push(text.slice(position));
  return parts;
}

export function highlightTreeValue(text: string, matches: Iterable<MatchRange>, activeIndex: number): ReactNode {
  if (text.length <= 4096) return highlightMatches(text, matches, activeIndex);

  // Long values normally display a clamped preview. Around the active match,
  // display a short excerpt so even a late hit can be scrolled into view.
  let start = 0, end = 4096, index = 0, active: MatchRange | undefined;
  const nearby: MatchRange[] = [];
  for (const match of matches) {
    if (index === activeIndex) {
      active = match;
      start = Math.max(0, match.start - 160);
      end = Math.min(text.length, match.end + 160);
    }
    if ((activeIndex < 0 || active) && match.start >= end) break;
    if (index >= activeIndex - 160) nearby.push(match);
    index++;
  }
  const visible = nearby.filter((match) => match.start < end && match.end > start);
  const parts = visible.map((match) => ({ start: Math.max(start, match.start) - start, end: Math.min(end, match.end) - start }));
  return <>{start > 0 && '…'}{highlightMatches(text.slice(start, end), parts, active ? visible.indexOf(active) : -1)}{end < text.length && '…'}</>;
}
