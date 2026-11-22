// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebviewRequest } from '../../src/webview/protocol.js';
import { defaultSettings } from '../../src/shared/settings.js';
import { childrenOf, parseJsonDocument, rootView, searchJson } from '../../src/worker/jsonService.js';

const bridge = vi.hoisted(() => {
  const messages: WebviewRequest[] = [];
  let saved: unknown = {};
  return {
    messages,
    api: {
      postMessage(message: WebviewRequest) { messages.push(message); },
      setState(state: unknown) { saved = state; },
      getState() { return saved; }
    },
    reset() { messages.length = 0; saved = {}; }
  };
});

vi.mock('../../src/webview/bridge.js', () => ({
  vscode: bridge.api,
  send: (message: WebviewRequest) => bridge.api.postMessage(message)
}));

import { App } from '../../src/webview/app.js';

describe('React webview app', () => {
  beforeEach(() => bridge.reset());
  afterEach(() => cleanup());

  it('renders initialization data and sends a debounced query intent', async () => {
    render(<App />);
    expect(bridge.messages).toContainEqual({ type: 'ready' });

    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'init',
      summary: { kind: 'jsonl', revision: 'v1', byteLength: 2048, parseMilliseconds: 4, errors: 0, recordCount: 2, fields: ['name'] },
      uiState: {}
    } }));

    expect(await screen.findByText('JSONL Preview')).toBeTruthy();
    const exportButton = screen.getByRole('button', { name: 'Export' });
    expect(exportButton.textContent?.trim()).toBe('');
    expect(exportButton.querySelector('.t-icon-file-export')).toBeTruthy();
    expect(exportButton.getAttribute('title')).toBeNull();
    fireEvent.mouseEnter(exportButton);
    expect(screen.getByRole('tooltip').textContent).toBe('Export');
    fireEvent.mouseLeave(exportButton);
    const input = screen.getByRole('searchbox');
    expect(input.getAttribute('placeholder')).toBe("Filter rows by value or enter JMESPath, e.g. level == 'error'");
    await userEvent.type(input, 'active');

    await waitFor(() => expect(bridge.messages).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'query', jmesPath: 'active' })])), { timeout: 1500 });
    const query = bridge.messages.findLast((message) => message.type === 'query');
    await userEvent.click(exportButton);
    expect(bridge.messages).toContainEqual({ type: 'export', queryRevision: query?.queryRevision });
    const beforeClear = bridge.messages.length;
    await userEvent.clear(input);
    await waitFor(() => expect(bridge.messages.slice(beforeClear).some((message) => message.type === 'query' && !('jmesPath' in message))).toBe(true), { timeout: 1500 });
  });

  it('automatically dismisses search syntax errors', async () => {
    vi.useFakeTimers();
    try {
      render(<App />);
      act(() => {
        window.dispatchEvent(new MessageEvent('message', { data: {
          type: 'init', summary: { kind: 'json', revision: 'v1', byteLength: 10, parseMilliseconds: 1, errors: 0, locale: 'en' }, uiState: {}
        } }));
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'error', message: 'Invalid JMESPath' } }));
      });

      expect(screen.getByRole('alert').textContent).toBe('Invalid JMESPath');
      act(() => vi.advanceTimersByTime(4000));
      expect(screen.queryByRole('alert')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reveals distant matches in the JSON tree, cycles through occurrences, and restores the original tree', async () => {
    const post = (data: unknown) => act(() => { window.dispatchEvent(new MessageEvent('message', { data })); });
    const items = Array.from({ length: 1054 }, (_, index) => index === 1051 ? { label: 'Needle and needle' } : index === 1053 ? { label: 'needle last' } : null);
    const documentModel = parseJsonDocument(JSON.stringify({ keep: 'context', items, count: 12345, timestamp: 1704067200 }), defaultSettings);
    const time = { locale: 'en', timezone: 'Asia/Shanghai' };
    const root = rootView(documentModel)!;
    render(<App />);
    post({
      type: 'init', searchPreferences: { defaultMode: 'remember', lastMode: 'reveal' },
      summary: { kind: 'json', revision: 'v1', byteLength: 300_000, parseMilliseconds: 1, errors: 0, ...time,
        root, children: childrenOf(documentModel, root.nodeId, 0, 100) }
    });
    const input = screen.getByRole('searchbox');
    const modeButton = screen.getByRole('button', { name: 'Reveal in tree' });
    expect(modeButton.nextElementSibling).toBe(screen.getByRole('button', { name: 'View Source' }));
    expect(modeButton.classList.contains('t-button--variant-outline')).toBe(true);
    for (const name of ['Format', 'Repair', 'Reveal in tree', 'View Source']) {
      const button = screen.getByRole('button', { name });
      expect(button.textContent?.trim()).toBe('');
      expect(button.querySelector('svg')).toBeTruthy();
      expect(button.getAttribute('title')).toBeNull();
      fireEvent.mouseEnter(button);
      expect(screen.getAllByRole('tooltip').some((tooltip) => tooltip.textContent?.includes(name))).toBe(true);
      fireEvent.mouseLeave(button);
    }
    expect(screen.getByText('items').closest('[role="treeitem"]')?.getAttribute('aria-expanded')).toBe('false');

    const respond = async (query: string, index = 0, mode: 'filter' | 'reveal' = 'reveal') => {
      const response = await waitFor(() => {
        const request = bridge.messages.findLast((message) => message.type === 'jsonSearch');
        if (request?.type !== 'jsonSearch' || request.query !== query || request.mode !== mode || request.matchIndex !== index) throw new Error('Waiting for search');
        return request;
      });
      post({ type: 'search', query, searchRevision: response.searchRevision, ...searchJson(documentModel, query, mode, index, time) });
    };
    fireEvent.change(input, { target: { value: 'needle' } });
    await respond('needle');
    expect(screen.getByText('context')).toBeTruthy();
    expect(screen.getByText('1/3')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next match' }).closest('.find-bar')).toBe(input.closest('.find-bar'));
    expect(document.querySelector('mark.active-match')?.textContent).toBe('Needle');
    expect(screen.getByText('Showing items 1001–1054')).toBeTruthy();
    expect(bridge.messages.some((message) => message.type === 'children')).toBe(false);

    await userEvent.click(screen.getByRole('button', { name: 'Next match' }));
    await respond('needle', 1);
    expect(document.querySelector('mark.active-match')?.textContent).toBe('needle');
    expect(screen.getByText('2/3')).toBeTruthy();
    input.focus();
    await userEvent.keyboard('{Enter}');
    await respond('needle', 2);
    expect(screen.getByText('3/3')).toBeTruthy();
    await userEvent.keyboard('{Enter}');
    await respond('needle');
    expect(screen.getByText('1/3')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Reveal in tree' }));
    expect(bridge.messages).toContainEqual({ type: 'setSearchMode', mode: 'filter' });
    expect((input as HTMLInputElement).value).toBe('needle');
    await respond('needle', 0, 'filter');
    expect(screen.getByRole('tree', { name: 'Query result' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Next match' })).toBeNull();

    fireEvent.change(input, { target: { value: '' } });
    expect(screen.getByText('items').closest('[role="treeitem"]')?.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('mark')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Results only' }));
    fireEvent.change(input, { target: { value: '234' } });
    await respond('234');
    expect(document.querySelector('mark.active-match')?.textContent).toBe('234');
    fireEvent.change(input, { target: { value: '8:00' } });
    await respond('8:00');
    expect(document.querySelector('.timestamp-annotation mark.active-match')?.textContent).toBe('8:00');
  });

  it('searches a JSONL record independently in both modes and isolates its keyboard shortcuts', async () => {
    const post = (data: unknown) => act(() => { window.dispatchEvent(new MessageEvent('message', { data })); });
    render(<App />);
    post({ type: 'init', searchPreferences: { defaultMode: 'filter', lastMode: 'reveal' },
      summary: { kind: 'jsonl', revision: 'v1', byteLength: 6000, parseMilliseconds: 1, errors: 1, fields: ['id'], recordCount: 3, locale: 'en', timezone: 'Asia/Shanghai', maxAutoExpandDepth: 1 } });
    const page = await waitFor(() => {
      const request = bridge.messages.findLast((message) => message.type === 'page');
      if (!request) throw new Error('Waiting for page');
      return request;
    });
    const record = JSON.stringify({ id: 'first-record', nested: { text: `Needle ${'x'.repeat(4800)} needle`, timestamp: 1704067200 },
      count: 4321, users: [{ name: 'Ada', active: true }], empty: null });
    post({ type: 'page', queryRevision: page.queryRevision, offset: 0, total: 3, scannedRows: 3, matchedRows: 3, isComplete: true, rows: [
      { physicalLine: 1, resultIndex: 1, status: 'valid', rawTruncated: true, raw: record.slice(0, 256), cells: { id: 'first-record' } },
      { physicalLine: 2, resultIndex: 2, status: 'valid', raw: '{"id":"second-record","text":"needle"}', cells: { id: 'second-record' } },
      { physicalLine: 3, resultIndex: 3, status: 'invalid', raw: '{"broken": needle needle', cells: { id: 'invalid-record' } }
    ] });
    await userEvent.click(screen.getByText('first-record'));
    expect(bridge.messages).toContainEqual({ type: 'record', physicalLine: 1 });
    post({ type: 'record', physicalLine: 1, content: record });
    const details = within(document.querySelector<HTMLElement>('.t-drawer__body')!);
    const actions = within(document.querySelector<HTMLElement>('.drawer-header-actions')!);
    const input = details.getByRole('searchbox') as HTMLInputElement;
    const modeButton = actions.getByRole('button', { name: 'Results only' });
    expect(modeButton.nextElementSibling).toBe(actions.getByRole('button', { name: 'Copy Row' }));
    for (const button of actions.getAllByRole('button')) {
      expect(button.textContent?.trim()).toBe('');
      expect(button.querySelector('svg')).toBeTruthy();
      expect(button.getAttribute('title')).toBeNull();
    }
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: 'needle' } });
    expect(await details.findByRole('tree', { name: 'Query result' })).toBeTruthy();
    await userEvent.click(modeButton);
    expect(input.value).toBe('needle');
    expect(await details.findByText('1/2')).toBeTruthy();
    expect(document.querySelector('mark.active-match')?.textContent).toBe('Needle');
    input.focus();
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}');
    expect(details.getByText('2/2')).toBeTruthy();
    expect(document.querySelector('mark.active-match')?.textContent).toBe('needle');
    expect(document.querySelector('mark.active-match')?.parentElement?.textContent?.startsWith('…')).toBe(true);

    fireEvent.change(input, { target: { value: '321' } });
    expect(await details.findByText('1/1')).toBeTruthy();
    expect(document.querySelector('mark.active-match')?.textContent).toBe('321');
    fireEvent.change(input, { target: { value: '8:00' } });
    await waitFor(() => expect(document.querySelector('.timestamp-annotation mark.active-match')?.textContent).toBe('8:00'));
    await userEvent.click(actions.getByRole('button', { name: 'Reveal in tree' }));
    const timeResult = await details.findByRole('tree', { name: 'Query result' });
    expect(within(timeResult).getByText('1704067200')).toBeTruthy();

    fireEvent.change(input, { target: { value: 'users[?active].name' } });
    const projected = await details.findByRole('tree', { name: 'Query result' });
    expect(within(projected).getByText('Ada')).toBeTruthy();
    expect(details.queryByRole('button', { name: 'Next match' })).toBeNull();
    fireEvent.change(input, { target: { value: 'users[' } });
    expect(await details.findByRole('alert')).toBeTruthy();
    fireEvent.change(input, { target: { value: 'empty' } });
    const nullResult = await details.findByRole('tree', { name: 'Query result' });
    expect(within(nullResult).getByText('null')).toBeTruthy();
    expect(details.queryByRole('alert')).toBeNull();
    expect(bridge.messages.some((message) => message.type === 'query' || message.type === 'jsonSearch')).toBe(false);

    await userEvent.click(document.querySelector<HTMLElement>('.t-drawer__close-btn')!);
    await waitFor(() => expect(document.querySelector('.t-drawer--open')).toBeNull());
    await userEvent.click(screen.getByText('second-record'));
    const nextDetails = within(document.querySelector<HTMLElement>('.t-drawer__body')!);
    expect((nextDetails.getByRole('searchbox') as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('button', { name: 'Results only' }).closest('.drawer-header-actions')).toBeTruthy();
    post({ type: 'record', physicalLine: 1, content: record });
    expect(nextDetails.getByText('second-record')).toBeTruthy();
    await userEvent.click(document.querySelector<HTMLElement>('.t-drawer__close-btn')!);
    await waitFor(() => expect(document.querySelector('.t-drawer--open')).toBeNull());
    await userEvent.click(screen.getByText('invalid-record'));
    const raw = within(document.querySelector<HTMLElement>('.t-drawer__body')!);
    fireEvent.change(raw.getByRole('searchbox', { name: 'Search raw record text' }), { target: { value: 'needle' } });
    expect(raw.getByText('1/2')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Results only' })).toBeNull();
  });

  it('keeps the grid and search visible while previewing a JSONL row', async () => {
    render(<App />);
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'init',
      summary: { kind: 'jsonl', revision: 'v1', byteLength: 40, parseMilliseconds: 1, errors: 0, recordCount: 2, fields: ['name'], locale: 'zh-cn' },
      uiState: {}
    } }));
    await waitFor(() => expect(bridge.messages.some((message) => message.type === 'page')).toBe(true));
    const page = bridge.messages.findLast((message) => message.type === 'page');
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'page', rows: [
        { resultIndex: 1, physicalLine: 1, status: 'valid', raw: '{"name":"Ada"}', cells: { name: 'Ada' } },
        { resultIndex: 2, physicalLine: 2, status: 'valid', raw: '{"name":"Grace"}', cells: { name: 'Grace' } }
      ],
      total: 2, scannedRows: 2, matchedRows: 2, isComplete: true, offset: 0,
      queryRevision: page && 'queryRevision' in page ? page.queryRevision : 1
    } }));
    await userEvent.click(await screen.findByText('Ada'));
    expect(screen.getByPlaceholderText("按值筛选行，或输入 JMESPath，如 level == 'error'")).toBeTruthy();
    expect(screen.getByRole('searchbox', { name: '在当前记录中搜索，或输入 JMESPath' })).toBeTruthy();
    expect(screen.getByRole('grid')).toBeTruthy();
    expect(await screen.findByText('第 1 行')).toBeTruthy();
    const temporaryTab = screen.getByRole('button', { name: '临时 Tab 打开' });
    expect(temporaryTab.querySelector('.t-icon-tab')).toBeTruthy();
    fireEvent.mouseEnter(temporaryTab);
    expect(screen.getByRole('tooltip').textContent).toBe('在临时 Tab 打开（按住 Alt/Option 在当前 Tab 打开）');
    expect(temporaryTab.closest('.t-drawer__header')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '当前 Tab 打开' })).toBeNull();
    fireEvent.keyDown(window, { key: 'Alt' });
    const currentTab = screen.getByRole('button', { name: '当前 Tab 打开' });
    expect(currentTab.querySelector('.t-icon-enter')).toBeTruthy();
    expect(screen.getByRole('tooltip').textContent).toBe('在当前 Tab 打开');
    fireEvent.mouseLeave(currentTab);
    expect(screen.queryByRole('button', { name: '临时 Tab 打开' })).toBeNull();
    fireEvent.click(currentTab);
    expect(bridge.messages).toContainEqual({ type: 'openCurrent', physicalLine: 1 });
    fireEvent.keyUp(window, { key: 'Alt' });
    expect(screen.getByRole('button', { name: '复制整行' }).closest('.t-drawer__header')).toBeTruthy();
    expect(document.querySelector('.t-drawer__close-btn')).toBeTruthy();
    expect(screen.getByRole('button', { name: '查看' }).classList.contains('inline-action')).toBe(true);
    const inlineActions = [...document.querySelectorAll<HTMLButtonElement>('.drawer-tree .inline-action')];
    expect(inlineActions).toHaveLength(3);
    expect(inlineActions[0]?.querySelector('.t-icon-browse')).toBeTruthy();
    expect(inlineActions[1]?.querySelector('.t-icon-copy')).toBeTruthy();
    expect(inlineActions[2]?.querySelector('.t-icon-tab')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Alt' });
    expect(inlineActions[2]?.getAttribute('aria-label')).toBe('在当前 Tab 打开');
    expect(inlineActions[2]?.querySelector('.t-icon-enter')).toBeTruthy();
    fireEvent.keyUp(window, { key: 'Alt' });
    fireEvent.click(inlineActions[1]!);
    expect(bridge.messages).toContainEqual({ type: 'copy', physicalLine: 1, pointer: '/name' });
    fireEvent.click(inlineActions[2]!);
    expect(bridge.messages).toContainEqual({ type: 'openTemp', physicalLine: 1, pointer: '/name' });
    fireEvent.click(inlineActions[2]!, { altKey: true });
    expect(bridge.messages).toContainEqual({ type: 'openCurrent', physicalLine: 1, pointer: '/name' });
    expect(document.querySelector('.drawer-tree .json-value')?.classList.contains('long-value')).toBe(false);
    expect(document.querySelector<HTMLElement>('.t-drawer__content-wrapper')?.style.width).toBe('66.6667vw');
    const mask = document.querySelector<HTMLElement>('.t-drawer__mask');
    expect(mask).toBeTruthy();
    expect(document.head.querySelector('style[data-id^="td_drawer_"]')).toBeNull();
    await userEvent.click(mask!);
    await waitFor(() => expect(document.querySelector('.t-drawer--open')).toBeNull());
    expect(document.querySelector('.drawer-content')).toBeNull();
    await userEvent.click(screen.getByText('Grace'));
    await waitFor(() => expect(document.querySelector('.t-drawer--open')).toBeTruthy());
    await userEvent.click(document.querySelector<HTMLElement>('.t-drawer__mask')!);
    await waitFor(() => expect(document.querySelector('.t-drawer--open')).toBeNull());
    await userEvent.click(screen.getByText('Ada'));
    await waitFor(() => expect(document.querySelector('.t-drawer--open')).toBeTruthy());
    expect(document.head.querySelector('style[data-id^="td_drawer_"]')).toBeNull();
  });

  it.each([
    ['zh-cn', 'zh-CN'],
    ['en', 'en-US']
  ])('formats JSONL date cells using the current %s language', async (locale, dateLocale) => {
    render(<App />);
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'init',
      summary: { kind: 'jsonl', revision: `date-${locale}`, byteLength: 80, parseMilliseconds: 1, errors: 0, recordCount: 1, fields: ['createdAt'], locale, timezone: 'UTC' },
      uiState: {}
    } }));
    const page = await waitFor(() => {
      const found = bridge.messages.findLast((message) => message.type === 'page');
      expect(found).toBeTruthy();
      return found;
    });
    const value = '2024-01-02T03:04:05Z';
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'page',
      rows: [{ resultIndex: 1, physicalLine: 1, status: 'valid', raw: JSON.stringify({ createdAt: value }), cells: { createdAt: value } }],
      total: 1, scannedRows: 1, matchedRows: 1, isComplete: true, offset: 0,
      queryRevision: page && 'queryRevision' in page ? page.queryRevision : 1
    } }));

    const expected = new Intl.DateTimeFormat(dateLocale, { year: 'numeric', month: 'short', day: 'numeric', hour: dateLocale === 'zh-CN' ? '2-digit' : 'numeric', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, timeZone: 'UTC' }).format(new Date(value));
    expect(await screen.findByText(expected)).toBeTruthy();
  });

  it('uses the same time recognition in JSONL cells and row details', async () => {
    render(<App />);
    const cells = { id: 1704067200, timestamp: 86400000, timestamp_ms: '86400000', date: '2024-02-30T00:00:00Z', createdAt: '2024-02-29T00:30:00+08:00' };
    act(() => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'init', summary: { kind: 'jsonl', revision: 'shared-times', byteLength: 200, parseMilliseconds: 1, errors: 0, recordCount: 1, fields: Object.keys(cells), locale: 'en', timezone: 'UTC' }, uiState: {}
    } })));
    const request = await waitFor(() => {
      const found = bridge.messages.findLast((message) => message.type === 'page' || message.type === 'query');
      expect(found).toBeTruthy();
      return found!;
    });
    act(() => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'page', rows: [{ resultIndex: 1, physicalLine: 1, status: 'valid', raw: JSON.stringify(cells), cells }],
      total: 1, scannedRows: 1, matchedRows: 1, isComplete: true, offset: 0,
      queryRevision: 'queryRevision' in request ? request.queryRevision : 1
    } })));
    const formatter = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, timeZone: 'UTC' });
    const early = formatter.format(new Date(86400000));
    const leap = formatter.format(new Date(cells.createdAt));
    const grid = screen.getByRole('grid');
    expect([...grid.querySelectorAll('.cell-value')].map((cell) => cell.textContent)).toEqual(['1704067200', '86400000', early, cells.date, leap]);
    fireEvent.click(screen.getByText('1704067200'));
    await screen.findByText('Line 1');
    const details = document.querySelector('.drawer-tree')!;
    expect([...details.querySelectorAll('.timestamp-annotation')].map((annotation) => annotation.textContent)).toEqual([` (${early})`, ` (${leap})`]);
    expect([...details.querySelectorAll('.json-value')].map((scalar) => scalar.firstChild?.textContent)).toEqual(Object.values(cells).map(String));
  });

  it.each([
    ['time.id', '/time/id', { time: { id: 1704067200 } }, 1704067200, undefined],
    ['["timestamp.ms"]', '/timestamp.ms', { 'timestamp.ms': 86400000 }, 86400000, 86400000],
    ['timestamp/ms', '/timestamp~1ms', { 'timestamp/ms': 86400000 }, 86400000, 86400000],
    ['timestamp~1ms', '/timestamp~01ms', { 'timestamp~1ms': 86400000 }, 86400000, undefined],
    ['["time"].createdAt', '/time/createdAt', { time: { createdAt: 1704067200 } }, 1704067200, 1704067200000],
    ['[""]', '/', { '': 1704067200 }, 1704067200, undefined],
    ['$', '', 1704067200, 1704067200, undefined]
  ])('matches table and detail time recognition for %s', async (field, pointer, record, value, milliseconds) => {
    render(<App />);
    act(() => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'init', summary: { kind: 'jsonl', revision: 'leaf-times', byteLength: 100, parseMilliseconds: 1, errors: 0, recordCount: 1,
        fields: [field], fieldPointers: { [field]: pointer }, locale: 'en', timezone: 'UTC' }, uiState: {}
    } })));
    const request = await waitFor(() => {
      const found = bridge.messages.findLast((message) => message.type === 'page' || message.type === 'query');
      expect(found).toBeTruthy();
      return found!;
    });
    act(() => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'page', rows: [{ resultIndex: 1, physicalLine: 1, status: 'valid', raw: JSON.stringify(record), cells: { [field]: value } }],
      total: 1, scannedRows: 1, matchedRows: 1, isComplete: true, offset: 0,
      queryRevision: 'queryRevision' in request ? request.queryRevision : 1
    } })));
    const formatted = milliseconds === undefined ? undefined : new Intl.DateTimeFormat('en-US', {
      year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, timeZone: 'UTC'
    }).format(new Date(milliseconds));
    const cell = screen.getByRole('grid').querySelector('.cell-value')!;
    expect(cell.textContent).toBe(formatted ?? String(value));
    fireEvent.contextMenu(cell);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy Cell' }));
    expect(bridge.messages).toContainEqual({ type: 'copy', text: formatted ?? String(value) });
    fireEvent.click(cell);
    await screen.findByText('Line 1');
    const detail = document.querySelector('.drawer-tree .json-value')!;
    expect(detail.firstChild?.textContent).toBe(String(value));
    expect(detail.querySelector('.timestamp-annotation')?.textContent).toBe(formatted === undefined ? undefined : ` (${formatted})`);
  });

  it('loads a complete large record and opens long text in a copyable second drawer', async () => {
    render(<App />);
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'init', summary: { kind: 'jsonl', revision: 'large-row', byteLength: 30_000, parseMilliseconds: 1, errors: 0, recordCount: 1, fields: ['content'], fieldPointers: { content: '/content' }, locale: 'en' }, uiState: {}
    } }));
    const pageRequest = await waitFor(() => {
      const found = bridge.messages.findLast((message) => message.type === 'page');
      expect(found).toBeTruthy();
      return found;
    });
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'page', rows: [{ resultIndex: 1, physicalLine: 7, status: 'valid', raw: '{"content":"partial…', rawTruncated: true, cells: { content: 'large preview' }, truncatedCells: ['content'] }],
      total: 1, scannedRows: 1, matchedRows: 1, isComplete: true, offset: 0,
      queryRevision: pageRequest && 'queryRevision' in pageRequest ? pageRequest.queryRevision : 1
    } }));

    const previewCell = await screen.findByText('large preview');
    fireEvent.contextMenu(previewCell);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Copy Row' }));
    expect(bridge.messages).toContainEqual({ type: 'copy', physicalLine: 7 });
    fireEvent.contextMenu(previewCell);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Copy Cell' }));
    expect(bridge.messages).toContainEqual({ type: 'copy', physicalLine: 7, pointer: '/content' });

    await userEvent.click(previewCell);
    expect(bridge.messages).toContainEqual({ type: 'record', physicalLine: 7 });
    expect(await screen.findByText('Loading…')).toBeTruthy();

    const completeText = 'complete text '.repeat(20);
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'record', physicalLine: 7, content: JSON.stringify({ content: completeText }) } }));
    const view = await screen.findByRole('button', { name: 'View' });
    await userEvent.click(view);
    expect(await screen.findByText('Full Content')).toBeTruthy();
    const copyContent = screen.getByRole('button', { name: 'Copy Content' });
    expect(copyContent.closest('.t-drawer__header')).toBeTruthy();
    await userEvent.click(copyContent);
    expect(bridge.messages).toContainEqual({ type: 'copy', physicalLine: 7, pointer: '/content' });

    const copyRow = screen.getByRole('button', { name: 'Copy Row' });
    await userEvent.click(copyRow);
    expect(bridge.messages).toContainEqual({ type: 'copy', physicalLine: 7 });

    expect(screen.queryByRole('searchbox', { name: 'Search full content' })).toBeNull();
    copyContent.focus();
    expect(document.activeElement).toBe(copyContent);
    const findShortcut = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(findShortcut);
    expect(findShortcut.defaultPrevented).toBe(true);
    const contentSearch = await screen.findByRole('searchbox', { name: 'Search full content' });
    expect(contentSearch.closest('.drawer-search-overlay')).toBeTruthy();
    expect(document.activeElement).toBe(contentSearch);
    await userEvent.type(contentSearch, 'TEXT');
    expect(screen.getByText('1/20')).toBeTruthy();
    expect(document.querySelectorAll('.full-content-viewer mark')).toHaveLength(20);
    expect(document.querySelector('.full-content-viewer mark.active-match')?.textContent).toBe('text');
    await userEvent.click(screen.getByRole('button', { name: 'Next match' }));
    expect(screen.getByText('2/20')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Previous match' }));
    expect(screen.getByText('1/20')).toBeTruthy();
    await userEvent.clear(contentSearch);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('searchbox', { name: 'Search full content' })).toBeNull();

    const viewer = document.querySelector<HTMLElement>('.full-content-viewer')!;
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.setStart(viewer.firstChild!, 0);
    range.setEnd(viewer.firstChild!, 13);
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent.contextMenu(viewer, { clientX: 20, clientY: 30 });
    expect(screen.getByRole('menuitem', { name: 'Copy Selected Content' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Open Selection in Temporary Tab' }).querySelector('.t-icon-tab')).toBeTruthy();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Copy Selected Content' }));
    expect(bridge.messages).toContainEqual({ type: 'copy', text: 'complete text' });

    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent.contextMenu(viewer, { clientX: 20, clientY: 30 });
    await userEvent.click(screen.getByRole('menuitem', { name: 'Open Selection in Temporary Tab' }));
    expect(bridge.messages).toContainEqual({ type: 'openTemp', text: 'complete text' });
  });

  it('shows row and cell copy actions only for JSONL table cells', async () => {
    render(<App />);
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'init', summary: { kind: 'jsonl', revision: 'menus', byteLength: 20, parseMilliseconds: 1, errors: 0, recordCount: 1, fields: ['name', 'missing'], locale: 'en' }, uiState: {}
    } }));
    const request = await waitFor(() => {
      const found = bridge.messages.findLast((message) => message.type === 'page');
      expect(found).toBeTruthy();
      return found;
    });
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'page', rows: [{ resultIndex: 1, physicalLine: 1, status: 'valid', raw: '{"name":"Ada"}', cells: { name: 'Ada' } }],
      total: 1, scannedRows: 1, matchedRows: 1, isComplete: true, offset: 0,
      queryRevision: request && 'queryRevision' in request ? request.queryRevision : 1
    } }));

    fireEvent.contextMenu(await screen.findByText('Ada'));
    expect(screen.getByRole('menuitem', { name: 'Copy Row' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Open in Temporary Tab (Row)' }).querySelector('.t-icon-tab')).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Open in Temporary Tab (Cell)' }).querySelector('.t-icon-tab')).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Open in Current Tab (Row)' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Open in Current Tab (Cell)' })).toBeNull();
    expect(screen.getAllByRole('menuitem')).not.toContain(document.activeElement);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Copy Cell' }));
    expect(bridge.messages).toContainEqual({ type: 'copy', text: 'Ada' });
    expect(screen.queryByRole('status')).toBeNull();
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'copied' } }));
    expect((await screen.findByRole('status')).textContent).toBe('Copied to clipboard');

    fireEvent.contextMenu(screen.getByText('Ada'));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Copy Row' }));
    expect(bridge.messages).toContainEqual({ type: 'copy', text: '{"name":"Ada"}' });

    fireEvent.contextMenu(screen.getByText('Ada'));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Open in Temporary Tab (Cell)' }));
    expect(bridge.messages).toContainEqual({ type: 'openTemp', physicalLine: 1, field: 'name' });

    fireEvent.contextMenu(screen.getByText('Ada'));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Open in Temporary Tab (Row)' }));
    expect(bridge.messages).toContainEqual({ type: 'openTemp', physicalLine: 1 });

    fireEvent.contextMenu(screen.getByText('Ada'));
    fireEvent.keyDown(window, { key: 'Alt' });
    expect(screen.getByRole('menuitem', { name: 'Open in Current Tab (Cell)' }).querySelector('.t-icon-enter')).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Open in Temporary Tab (Cell)' })).toBeNull();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Open in Current Tab (Cell)' }));
    expect(bridge.messages).toContainEqual({ type: 'openCurrent', physicalLine: 1, field: 'name' });
    fireEvent.keyUp(window, { key: 'Alt' });

    fireEvent.contextMenu(screen.getByText('Ada'));
    fireEvent.keyDown(window, { key: 'Alt' });
    await userEvent.click(screen.getByRole('menuitem', { name: 'Open in Current Tab (Row)' }));
    expect(bridge.messages).toContainEqual({ type: 'openCurrent', physicalLine: 1 });
    fireEvent.keyUp(window, { key: 'Alt' });

    fireEvent.contextMenu(screen.getByText('—'));
    expect(screen.getByRole('menuitem', { name: 'Copy Cell' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Open in Temporary Tab (Cell)' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Open in Temporary Tab (Row)' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Open in Current Tab (Cell)' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Open in Current Tab (Row)' })).toBeNull();

    expect(fireEvent.contextMenu(document.querySelector('main')!)).toBe(false);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(fireEvent.contextMenu(screen.getByRole('searchbox'))).toBe(true);
  });

  it('shows valid and malformed JSONL records on the first response without requiring a sort', async () => {
    render(<App />);
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'init', summary: { kind: 'jsonl', revision: 'invalid-lines', byteLength: 240, parseMilliseconds: 1, errors: 3, recordCount: 5, fields: ['id', 'status', 'message'], locale: 'en', pageSize: 1000 }, uiState: {}
    } }));
    const request = await waitFor(() => {
      const found = bridge.messages.findLast((message) => message.type === 'page');
      expect(found).toBeTruthy();
      return found;
    });
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'page', rows: [
        { resultIndex: 1, physicalLine: 1, status: 'valid', raw: '{"id":1,"status":"ok"}', cells: { id: 1, status: 'ok' } },
        { resultIndex: 2, physicalLine: 2, status: 'invalid', raw: '{"id":2', cells: {}, error: { code: 'INVALID_JSONL_RECORD', message: 'invalid', line: 2, column: 8, offset: 7, length: 1, severity: 'error' } },
        { resultIndex: 3, physicalLine: 5, status: 'valid', raw: '{"id":5,"status":"ok"}', cells: { id: 5, status: 'ok' } }
      ], total: 5, scannedRows: 5, matchedRows: 5, isComplete: true, offset: 0,
      errors: 4, errorsComplete: false,
      queryRevision: request && 'queryRevision' in request ? request.queryRevision : 1
    } }));

    expect(await screen.findAllByText('5')).toHaveLength(2);
    expect(screen.getAllByText('ok')).toHaveLength(2);
    expect(screen.getByText('4 errors found')).toBeTruthy();
    expect(document.querySelector('.t-pagination')).toBeNull();
    await new Promise((resolve) => window.setTimeout(resolve, 180));
    expect(bridge.messages.filter((message) => message.type === 'page' || message.type === 'query')).toHaveLength(1);
  });

  it('requests and renders the final server-side page', async () => {
    render(<App />);
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'init', summary: { kind: 'jsonl', revision: 'pagination', byteLength: 100, parseMilliseconds: 1, errors: 0, recordCount: 3, fields: ['name'], locale: 'en', pageSize: 2 }, uiState: {}
    } }));
    const initial = await waitFor(() => {
      const found = bridge.messages.findLast((message) => message.type === 'page');
      expect(found).toBeTruthy();
      return found;
    });
    const queryRevision = initial && 'queryRevision' in initial ? initial.queryRevision : 1;
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'page', rows: [
      { resultIndex: 1, physicalLine: 1, status: 'valid', raw: '{"name":"first"}', cells: { name: 'first' } },
      { resultIndex: 2, physicalLine: 2, status: 'valid', raw: '{"name":"second"}', cells: { name: 'second' } }
    ], total: 3, scannedRows: 3, matchedRows: 3, isComplete: true, offset: 0, queryRevision } }));

    await screen.findByText('first');
    const secondPage = await waitFor(() => {
      const found = [...document.querySelectorAll<HTMLButtonElement>('.t-pagination__number')].find((button) => button.textContent?.trim() === '2');
      expect(found).toBeTruthy();
      return found!;
    });
    await userEvent.click(secondPage);
    await waitFor(() => expect(bridge.messages).toContainEqual(expect.objectContaining({ type: 'page', offset: 2, queryRevision })));
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'page', rows: [
      { resultIndex: 3, physicalLine: 3, status: 'valid', raw: '{"name":"last"}', cells: { name: 'last' } }
    ], total: 3, scannedRows: 3, matchedRows: 3, isComplete: true, offset: 2, queryRevision } }));
    expect(await screen.findByText('last')).toBeTruthy();
  });

  it('loads wide JSON trees only after an explicit request', async () => {
    render(<App />);
    const root = { nodeId: 'root', type: 'array', offset: 0, length: 100, childrenCount: 1000, pointer: '', jsonPath: '@' };
    const child = { nodeId: 'child', key: '0', type: 'number', offset: 1, length: 1, childrenCount: 0, pointer: '/0', jsonPath: '@[0]', displayValue: '1', rawText: '1' };
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'init', summary: { kind: 'json', revision: 'v1', byteLength: 100, parseMilliseconds: 1, errors: 0, root, children: [child], locale: 'en' }, uiState: {}
    } }));
    expect(await screen.findByText('Load more (1/1000)')).toBeTruthy();
    expect(bridge.messages.some((message) => message.type === 'children')).toBe(false);
    await userEvent.click(screen.getByText('Load more (1/1000)'));
    expect(bridge.messages).toContainEqual(expect.objectContaining({ type: 'children', nodeId: 'root', offset: 1 }));
  });

  it.each([
    ['timestamp', 'number', '1704067200', 'UTC', 1704067200000],
    ['date', 'number', '1704067200000', 'Asia/Shanghai', 1704067200000],
    ['timestamp', 'number', '1704067200123', 'Asia/Shanghai', 1704067200123],
    ['createdAt', 'string', '2024-01-01T00:00:00.007Z', 'UTC', 1704067200007],
    ['timestamp_seconds', 'string', '1704067200.999', 'UTC', 1704067200999],
    ['created_at', 'string', '1704067200', 'America/New_York', 1704067200000],
    ['createdAt', 'string', '2024-01-01T00:00:00Z', 'system', 1704067200000],
    ['timestamp_ms', 'number', '86400000', 'UTC', 86400000],
    ['timestamp_seconds', 'string', '86400', 'UTC', 86400000],
    ['date', 'string', '2024-02-29T00:30:00+08:00', 'UTC', Date.parse('2024-02-29T00:30:00+08:00')],
    ['timestamp', 'number', '0', 'UTC', 0]
  ])('appends local time to JSON %s values in %s', async (key, type, value, timezone, milliseconds) => {
    render(<App />);
    const root = { nodeId: 'root', type: 'object', offset: 0, length: 100, childrenCount: 1, pointer: '', jsonPath: '@' };
    const child = { nodeId: 'child', key, type, offset: 1, length: value.length, childrenCount: 0, pointer: `/${key}`, jsonPath: `@.${key}`, displayValue: value };
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'init', summary: { kind: 'json', revision: 'times', byteLength: 100, parseMilliseconds: 1, errors: 0, root, children: [child], locale: 'zh-cn', timezone }, uiState: {}
    } }));
    await screen.findByText(key);
    const expected = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, ...(timezone === 'system' ? {} : { timeZone: timezone }) }).format(new Date(milliseconds));
    const scalar = document.querySelector('.json-value')!;
    expect(scalar.firstChild?.textContent).toBe(value);
    expect(scalar.querySelector('.timestamp-annotation')?.textContent).toBe(` (${expected})`);
    fireEvent.contextMenu(scalar);
    fireEvent.click(screen.getByRole('menuitem', { name: '复制值' }));
    expect(bridge.messages).toContainEqual({ type: 'copy', text: value });
  });

  it.each([
    ['id', '1704067200', 'UTC'],
    ['format', '1704067200', 'UTC'],
    ['timestamp', 'invalid', 'UTC'],
    ['timestamp', '86400000', 'UTC'],
    ['date', '2024-02-30T00:00:00Z', 'UTC'],
    ['date', '2024-01-01T00:00:00', 'UTC'],
    ['timestamp', '1704067200', 'Invalid/Zone']
  ])('keeps ambiguous or invalid JSON times unchanged (%s, %s, %s)', async (key, value, timezone) => {
    render(<App />);
    const root = { nodeId: 'root', key, type: 'string', offset: 0, length: value.length, childrenCount: 0, pointer: '', jsonPath: '@', displayValue: value };
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'init', summary: { kind: 'json', revision: 'invalid-times', byteLength: 100, parseMilliseconds: 1, errors: 0, root, locale: 'en', timezone }, uiState: {}
    } }));
    expect(await screen.findByText(value)).toBeTruthy();
    expect(document.querySelector('.timestamp-annotation')).toBeNull();
  });

  it('annotates nested JSON query results', async () => {
    render(<App />);
    act(() => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'init', summary: { kind: 'json', revision: 'query-times', byteLength: 100, parseMilliseconds: 1, errors: 0, locale: 'en', timezone: 'Asia/Shanghai' }, uiState: {}
    } })));
    await userEvent.type(screen.getByRole('searchbox'), 'event');
    const search = await waitFor(() => {
      const request = bridge.messages.findLast((message) => message.type === 'jsonSearch');
      expect(request).toBeTruthy();
      return request!;
    });
    act(() => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'search', searchRevision: 'searchRevision' in search ? search.searchRevision : 0, query: 'event', result: { query: 'event', result: { nested: { timestamp: 1704067200 } } }
    } })));
    await screen.findByText('timestamp');
    const expected = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, timeZone: 'Asia/Shanghai' }).format(new Date(1704067200000));
    expect(document.querySelector('.timestamp-annotation')?.textContent).toBe(` (${expected})`);
  });

  it('uses consistent semantic icons for property, value, JSONPath, viewing, and tab actions', async () => {
    render(<App />);
    const root = { nodeId: 'root', type: 'object', offset: 0, length: 12, childrenCount: 1, pointer: '', jsonPath: '@' };
    const child = { nodeId: 'child', key: 'answer', type: 'string', offset: 10, length: 4, childrenCount: 0, pointer: '/answer', jsonPath: '@.answer', displayValue: '42', rawText: '"42"' };
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'init', summary: { kind: 'json', revision: 'menu-icons', byteLength: 12, parseMilliseconds: 1, errors: 0, root, children: [child], locale: 'en' }, uiState: {}
    } }));

    fireEvent.contextMenu(await screen.findByText('42'));
    expect(screen.getByRole('menuitem', { name: 'Copy Property Name' }).querySelector('.t-icon-key')).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Copy Value' }).querySelector('.t-icon-copy')).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Copy JSONPath' }).querySelector('.t-icon-code')).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Open in Temporary Tab' }).querySelector('.t-icon-tab')).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Open in Current Tab' })).toBeNull();
    expect(screen.getByRole('button', { name: 'View' }).querySelector('.t-icon-browse')).toBeTruthy();
    expect(screen.getAllByRole('menuitem')).toHaveLength(5);
    fireEvent.keyDown(window, { key: 'Alt' });
    expect(screen.getByRole('menuitem', { name: 'Open in Current Tab' }).querySelector('.t-icon-enter')).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Open in Temporary Tab' })).toBeNull();
    fireEvent.keyUp(window, { key: 'Alt' });
  });

  it('renders nested children as soon as their async page arrives', async () => {
    render(<App />);
    const root = { nodeId: 'root', type: 'object', offset: 0, length: 100, childrenCount: 1, pointer: '', jsonPath: '@' };
    const branch = { nodeId: 'branch', key: 'items', type: 'array', offset: 1, length: 90, childrenCount: 2, pointer: '/items', jsonPath: '@.items' };
    const leaf = { nodeId: 'leaf', key: '0', type: 'null', offset: 2, length: 4, childrenCount: 0, pointer: '/items/0', jsonPath: '@.items[0]', displayValue: 'null', rawText: 'null' };
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'init', summary: { kind: 'json', revision: 'v1', byteLength: 100, parseMilliseconds: 1, errors: 0, root, children: [branch], locale: 'en' }, uiState: {}
    } }));

    const request = await waitFor(() => {
      const found = bridge.messages.findLast((message) => message.type === 'children' && message.nodeId === 'branch');
      expect(found).toBeTruthy();
      return found;
    });
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'children', parentId: 'branch', generation: request && 'generation' in request ? request.generation : 1, offset: 0, nodes: [leaf]
    } }));

    expect(await screen.findByText('null')).toBeTruthy();
    expect(screen.getByText('Load more (1/2)')).toBeTruthy();
  });

  it('requests a bounded data window while virtually scrolling large results', async () => {
    render(<App />);
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'init', summary: { kind: 'jsonl', revision: 'v1', byteLength: 1000, parseMilliseconds: 1, errors: 0, recordCount: 1000, fields: ['id'], locale: 'en', pageSize: 100 }, uiState: {} } }));
    await waitFor(() => expect(bridge.messages.some((message) => message.type === 'page')).toBe(true));
    const initial = bridge.messages.findLast((message) => message.type === 'page');
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'page', rows: [
      { resultIndex: 1, physicalLine: 1, status: 'valid', raw: '{"id":1}', cells: { id: 1 } },
      { resultIndex: 2, physicalLine: 2, status: 'valid', raw: '{"id":2}', cells: { id: 2 } }
    ], total: 1000, scannedRows: 1000, matchedRows: 1000, isComplete: true, offset: 0, queryRevision: initial && 'queryRevision' in initial ? initial.queryRevision : 1 } }));
    const grid = await screen.findByRole('grid');
    Object.defineProperties(grid, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 100 }, scrollTop: { configurable: true, value: 450 } });
    fireEvent.scroll(grid);
    await waitFor(() => expect(bridge.messages.some((message) => message.type === 'page' && message.offset === 400)).toBe(true));
    expect(grid.getAttribute('aria-busy')).toBe('true');
    expect(grid.querySelectorAll('[data-grid-row]')).toHaveLength(0);
    expect(document.querySelector('.t-loading')).toBeTruthy();
  });

  it('restores original line order from the index header after custom sorting', async () => {
    render(<App />);
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'init', summary: { kind: 'jsonl', revision: 'v1', byteLength: 100, parseMilliseconds: 1, errors: 0, recordCount: 2, fields: ['id'], locale: 'en' }, uiState: {} } }));
    const fieldHeader = await screen.findByRole('columnheader', { name: 'id' });
    await userEvent.click(fieldHeader);
    await waitFor(() => expect(bridge.messages.findLast((message) => message.type === 'query')).toEqual(expect.objectContaining({ sort: { path: '/id', direction: 'asc' } })), { timeout: 1500 });

    const physicalLineHeader = screen.getByRole('columnheader', { name: '#' });
    expect(physicalLineHeader.getAttribute('title')).toBeNull();
    await userEvent.click(physicalLineHeader);
    await waitFor(() => {
      const latest = bridge.messages.findLast((message) => message.type === 'query');
      expect(latest).toBeTruthy();
      expect(latest && 'sort' in latest).toBe(false);
    }, { timeout: 1500 });

    await userEvent.click(physicalLineHeader);
    await waitFor(() => expect(bridge.messages.findLast((message) => message.type === 'query')).toEqual(expect.objectContaining({ sort: { by: 'physicalLine', direction: 'desc' } })), { timeout: 1500 });
  });

  it('sorts timestamp ascending by default when that field exists', async () => {
    render(<App />);
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'init', summary: { kind: 'jsonl', revision: 'v1', byteLength: 100, parseMilliseconds: 1, errors: 0, recordCount: 2, fields: ['id', 'timestamp'], locale: 'en' }, uiState: {} } }));

    await waitFor(() => expect(bridge.messages.findLast((message) => message.type === 'query')).toEqual(expect.objectContaining({ sort: { path: '/timestamp', direction: 'asc' } })), { timeout: 1500 });
    expect(screen.getByRole('columnheader', { name: /timestamp/ }).getAttribute('aria-sort')).toBe('ascending');
  });

  it('sorts dotted display labels by their explicit JSON pointer', async () => {
    render(<App />);
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'init', summary: {
      kind: 'jsonl', revision: 'dots', byteLength: 100, parseMilliseconds: 1, errors: 0, recordCount: 1,
      fields: ['["a.b"]', 'a.b'], fieldPointers: { '["a.b"]': '/a.b', 'a.b': '/a/b' }, locale: 'en'
    }, uiState: {} } }));

    await userEvent.click(await screen.findByRole('columnheader', { name: '["a.b"]' }));
    await waitFor(() => expect(bridge.messages.findLast((message) => message.type === 'query')).toEqual(expect.objectContaining({ sort: { path: '/a.b', direction: 'asc' } })), { timeout: 1500 });
  });
});
