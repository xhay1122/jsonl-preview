import { describe, expect, it } from 'vitest';
import { childrenOf, formatJson, parseJsonDocument, queryJson, rootView, searchJson } from '../../src/worker/jsonService.js';
import { defaultSettings } from '../../src/shared/settings.js';

describe('JSON service', () => {
  it('keeps UTF-16 offsets, raw numbers, escaped paths and duplicate occurrences', () => {
    const text = '{"😀":{"a/b":9007199254740993},"x":1,"x":2}';
    const document = parseJsonDocument(text, defaultSettings); const root = rootView(document)!;
    const children = childrenOf(document, root.nodeId, 0, 10);
    expect(children[0]?.offset).toBe(text.indexOf('{', 1));
    const emojiChildren = childrenOf(document, children[0]!.nodeId, 0, 10);
    expect(root.jsonPath).toBe('@');
    expect(emojiChildren[0]).toMatchObject({ pointer: '/😀/a~1b', jsonPath: '@."😀"."a/b"', rawText: '9007199254740993' });
    expect(queryJson(document, emojiChildren[0]!.jsonPath).result).toBe(9007199254740992);
    expect(document.diagnostics.some((item) => item.code === 'duplicate-key')).toBe(true);
    expect(children.filter((item) => item.key === 'x')).toHaveLength(2);
  });
  it('offers only validated high-confidence repairs', () => {
    const missing = parseJsonDocument('{"a":[1,2', defaultSettings);
    expect(missing.repairs[0]?.text).toBe(']}');
    expect(JSON.parse(missing.repairs[0]!.result!)).toEqual({ a: [1, 2] });
    const quote = parseJsonDocument('{"a":"unterminated}', defaultSettings);
    expect(quote.repairs).toHaveLength(0);
  });
  it('formats without changing exact numeric spelling', () => {
    expect(formatJson('{"n":1.2300e+10,"z":-0}', 2)).toContain('1.2300e+10');
    expect(formatJson('{"n":1.2300e+10,"z":-0}', 2)).toContain('-0');
  });
  it('registers wide tree nodes lazily', () => {
    const document = parseJsonDocument(`[${Array.from({ length: 1000 }, (_, index) => index).join(',')}]`, defaultSettings);
    const root = rootView(document)!;
    expect(document.views.size).toBe(1);
    expect(childrenOf(document, root.nodeId, 0, 100)).toHaveLength(100);
    expect(document.views.size).toBe(101);
  });
  it('keeps deeply nested data browsable while disabling recursive queries', () => {
    const text = `${'['.repeat(520)}0${']'.repeat(520)}`;
    const document = parseJsonDocument(text, defaultSettings);
    expect(rootView(document)).toBeDefined();
    expect(document.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'maximum-depth' })]));
    expect(() => queryJson(document, '0')).toThrow(/safe query depth/i);
  });
  it('returns only the projected JMESPath result', () => {
    const document = parseJsonDocument('{"users":[{"name":"Ada","active":true},{"name":"Lin","active":false}]}', defaultSettings);
    expect(queryJson(document, 'users[?active].name').result).toEqual(['Ada']);
    expect(() => queryJson(document, 'users[')).toThrow();
  });
  it('distinguishes null projections, plain text containing a period and invalid expressions', () => {
    const document = parseJsonDocument('{"nested":{"empty":null},"value":"foo.bar@example.com","missing":"empty"}', defaultSettings);
    expect(searchJson(document, '"nested"."empty"', 'reveal')).toEqual({ result: null });
    expect(searchJson(document, 'nested.absent', 'reveal')).toEqual({ result: null });
    expect(searchJson(document, 'foo.bar@example.com', 'reveal')).toMatchObject({ matchCount: 1 });
    expect(() => searchJson(document, 'nested[', 'reveal')).toThrow();
  });
  it('targets distinct duplicate properties and supports scalar roots', () => {
    const document = parseJsonDocument('{"a":"yes","a":"yes"}', defaultSettings);
    const first = searchJson(document, 'yes', 'reveal');
    const next = searchJson(document, 'yes', 'reveal', 1);
    expect(first).toMatchObject({ matchCount: 2, target: { pages: [{ nodes: [{ key: 'a' }, { key: 'a' }] }] } });
    expect('target' in first && first.target?.nodeId).not.toEqual('target' in next && next.target?.nodeId);
    const root = parseJsonDocument('null', defaultSettings);
    expect(searchJson(root, 'null', 'reveal')).toEqual({ matchCount: 1, matchIndex: 0, target: { nodeId: rootView(root)!.nodeId, occurrence: 0, pages: [] } });
  });
  it('falls back to searching scalar values for plain input', () => {
    const document = parseJsonDocument('{"users":[{"name":"Ada Lovelace","active":true},{"name":"Lin","active":false}],"count":42}', defaultSettings);
    expect(queryJson(document, 'Ada').result).toEqual(['Ada Lovelace']);
    expect(queryJson(document, 'true').result).toEqual([true]);
    expect(queryJson(document, '42').result).toEqual([42]);
    expect(queryJson(document, 'missing').result).toEqual([]);
  });
  it('searches numeric substrings in source spelling and localized timestamps in both modes', () => {
    const document = parseJsonDocument('{"numeric":-123.450,"timestamp":1704067200,"iso":"2024-01-01T00:00:00Z"}', defaultSettings);
    const time = { locale: 'en', timezone: 'Asia/Shanghai' };
    expect(queryJson(document, '450', time).result).toEqual([-123.45]);
    expect(searchJson(document, '450', 'reveal', 0, time)).toMatchObject({ matchCount: 1 });
    expect(queryJson(document, '4067', time).result).toEqual([1704067200]);
    expect(queryJson(document, '2024-01', time).result).toEqual(['2024-01-01T00:00:00Z']);
    expect(queryJson(document, '8:00', time).result).toEqual(['2024-01-01T00:00:00Z', 1704067200]);
    expect(searchJson(document, '8:00', 'reveal', 0, time)).toMatchObject({ matchCount: 2, target: { occurrence: 0 } });
    expect(searchJson(document, '8:00', 'reveal', 0, { ...time, timezone: 'UTC' })).toEqual({ matchCount: 0, matchIndex: 0 });
  });
  it('reuses the materialized query value across searches', () => {
    const document = parseJsonDocument('{"users":[{"name":"Ada"}]}', defaultSettings);
    expect(queryJson(document, 'users[0].name').result).toBe('Ada');
    const cached = document.queryValue;
    expect(document.queryValueReady).toBe(true);
    expect(queryJson(document, 'Ada').result).toEqual(['Ada']);
    expect(document.queryValue).toBe(cached);
  });
});
