// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebviewRequest } from '../../src/webview/protocol.js';

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
    const input = screen.getByRole('searchbox');
    expect(input.getAttribute('placeholder')).toBe("Filter rows by value or enter JMESPath, e.g. level == 'error'");
    await userEvent.type(input, 'active');

    await waitFor(() => expect(bridge.messages).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'query', jmesPath: 'active' })])), { timeout: 1500 });
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
    expect(screen.getByRole('searchbox')).toBeTruthy();
    expect(screen.getByRole('grid')).toBeTruthy();
    expect(await screen.findByText('第 1 行')).toBeTruthy();
    const temporaryTab = screen.getByRole('button', { name: '临时 Tab 打开' });
    expect(temporaryTab.querySelector('.t-icon-tab')).toBeTruthy();
    expect(temporaryTab.getAttribute('title')).toBe('在临时 Tab 打开（按住 Alt/Option 在当前 Tab 打开）');
    expect(temporaryTab.closest('.t-drawer__header')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '当前 Tab 打开' })).toBeNull();
    fireEvent.keyDown(window, { key: 'Alt' });
    const currentTab = screen.getByRole('button', { name: '当前 Tab 打开' });
    expect(currentTab.querySelector('.t-icon-enter')).toBeTruthy();
    expect(currentTab.getAttribute('title')).toBe('在当前 Tab 打开');
    expect(screen.queryByRole('button', { name: '临时 Tab 打开' })).toBeNull();
    fireEvent.click(currentTab);
    expect(bridge.messages).toContainEqual({ type: 'openCurrent', text: '{"name":"Ada"}' });
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
    expect(bridge.messages).toContainEqual({ type: 'copy', text: 'Ada' });
    fireEvent.click(inlineActions[2]!);
    expect(bridge.messages).toContainEqual({ type: 'openTemp', text: '"Ada"' });
    fireEvent.click(inlineActions[2]!, { altKey: true });
    expect(bridge.messages).toContainEqual({ type: 'openCurrent', text: '"Ada"' });
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

    const expected = new Intl.DateTimeFormat(dateLocale, { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'UTC' }).format(new Date(value));
    expect(await screen.findByText(expected)).toBeTruthy();
  });

  it('loads a complete large record and opens long text in a copyable second drawer', async () => {
    render(<App />);
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'init', summary: { kind: 'jsonl', revision: 'large-row', byteLength: 30_000, parseMilliseconds: 1, errors: 0, recordCount: 1, fields: ['content'], locale: 'en' }, uiState: {}
    } }));
    const pageRequest = await waitFor(() => {
      const found = bridge.messages.findLast((message) => message.type === 'page');
      expect(found).toBeTruthy();
      return found;
    });
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'page', rows: [{ resultIndex: 1, physicalLine: 7, status: 'valid', raw: '{"content":"partial…', rawTruncated: true, cells: { content: 'large preview' } }],
      total: 1, scannedRows: 1, matchedRows: 1, isComplete: true, offset: 0,
      queryRevision: pageRequest && 'queryRevision' in pageRequest ? pageRequest.queryRevision : 1
    } }));

    await userEvent.click(await screen.findByText('large preview'));
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
    expect(bridge.messages).toContainEqual({ type: 'copy', text: completeText });

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
      queryRevision: request && 'queryRevision' in request ? request.queryRevision : 1
    } }));

    expect(await screen.findAllByText('5')).toHaveLength(2);
    expect(screen.getAllByText('ok')).toHaveLength(2);
    expect(document.querySelector('.t-pagination')).toBeNull();
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
});
