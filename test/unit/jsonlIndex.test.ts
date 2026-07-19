import { describe, expect, it } from 'vitest';
import { JsonlIndex } from '../../src/worker/jsonlIndex.js';
import { defaultSettings } from '../../src/shared/settings.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('JSONL index', () => {
  it('indexes BOM, CRLF, LF, invalid rows and final lines', async () => {
    const index = new JsonlIndex({ ...defaultSettings, ignoreEmptyLines: false });
    await index.openText('\uFEFF{"id":1}\r\n{"id":2,"name":"中😀"}\ninvalid\n\n{"id":3}');
    expect(Array.from({ length: index.lineCount }, (_, line) => { const meta = index.lineMetadata(line); return [meta.physicalLine, meta.eolByteLength]; })).toEqual([[1, 2], [2, 1], [3, 1], [4, 1], [5, 0]]);
    const rows = await index.page('default', 0, 10);
    expect(rows[1]?.cells.name).toBe('中😀');
    expect(rows[2]?.status).toBe('invalid');
    expect(rows[3]?.error?.code).toBe('EMPTY_LINE');
    expect(rows[4]?.cells.id).toBe(3);
    await index.close();
  });
  it('filters and stable-sorts while preserving raw export', async () => {
    const index = new JsonlIndex(defaultSettings);
    await index.openText('{"n":2,"raw":1e2}\n{"n":1,"raw":-0}\n{"n":2,"raw":3}');
    await index.applyQuery('filtered', { op: 'compare', path: '/n', cmp: 'gte', value: { kind: 'number', decimal: '1' } }, { path: '/n', direction: 'asc' }, () => false);
    expect((await index.page('filtered', 0, 10)).map((row) => row.physicalLine)).toEqual([2, 1, 3]);
    expect(await index.export('filtered', 'jsonl', 1024 * 1024)).toContain('"raw":1e2');
  });
  it('sorts by physical line without parsing a synthetic JSON field', async () => {
    const index = new JsonlIndex(defaultSettings);
    await index.openText('{"id":1}\n{"id":2}\n{"id":3}');
    const result = await index.applyQuery('reversed', undefined, { by: 'physicalLine', direction: 'desc' }, () => false);
    expect(result.scannedRows).toBe(0);
    expect((await index.page('reversed', 0, 10)).map((row) => row.physicalLine)).toEqual([3, 2, 1]);
    await index.close();
  });
  it('keeps immutable query snapshots isolated and enforces their budget', async () => {
    const index = new JsonlIndex(defaultSettings);
    await index.openText('{"group":"a"}\n{"group":"b"}\n{"group":"a"}');
    await index.applyQuery('a', { op: 'compare', path: '/group', cmp: 'eq', value: { kind: 'string', value: 'a' } }, undefined, () => false);
    await index.applyQuery('b', { op: 'compare', path: '/group', cmp: 'eq', value: { kind: 'string', value: 'b' } }, undefined, () => false);
    expect((await index.page('a', 0, 10)).map((row) => row.physicalLine)).toEqual([1, 3]);
    expect((await index.page('b', 0, 10)).map((row) => row.physicalLine)).toEqual([2]);
    await index.close();

    const bounded = new JsonlIndex({ ...defaultSettings, queryCacheBytes: 256 * 1024 });
    await bounded.openText(Array.from({ length: 20_000 }, () => '{}').join('\n'));
    await expect(bounded.applyQuery('oversized', undefined, undefined, () => false)).rejects.toMatchObject({ code: 'QUERY_CACHE_LIMIT' });
    await bounded.close();
  });
  it('uses exact numeric literals for filtering and sorting', async () => {
    const index = new JsonlIndex(defaultSettings);
    await index.openText('{"n":9007199254740993}\n{"n":9007199254740992}');
    await index.applyQuery('exact', { op: 'compare', path: '/n', cmp: 'eq', value: { kind: 'number', decimal: '9007199254740993' } }, undefined, () => false);
    expect((await index.page('exact', 0, 10)).map((row) => row.physicalLine)).toEqual([1]);
    await index.applyQuery('sorted', undefined, { path: '/n', direction: 'asc' }, () => false);
    expect((await index.page('sorted', 0, 10)).map((row) => row.physicalLine)).toEqual([2, 1]);
  });
  it('filters records with JMESPath expressions', async () => {
    const index = new JsonlIndex(defaultSettings);
    await index.openText('{"active":true,"score":2}\n{"active":false,"score":3}\n{"active":true,"score":0}');
    await index.applyQuery('jmes', undefined, undefined, () => false, 'active && score > `1`');
    expect((await index.page('jmes', 0, 10)).map((row) => row.physicalLine)).toEqual([1]);
    await expect(index.applyQuery('invalid', undefined, undefined, () => false, 'active[')).rejects.toMatchObject({ code: 'INVALID_JMESPATH' });
  });
  it('filters JSONL records by scalar value without flattening the rows', async () => {
    const index = new JsonlIndex(defaultSettings);
    await index.openText([
      '{"name":"Ada","nested":{"role":"admin"}}',
      '{"name":"Grace","tags":["reader","ADA-team"]}',
      '{"name":"Lin","active":true,"count":42}',
      '{"name":"True","active":false,"count":"42"}'
    ].join('\n'));

    await index.applyQuery('text', undefined, undefined, () => false, 'ada');
    expect((await index.page('text', 0, 10)).map((row) => row.physicalLine)).toEqual([1, 2]);

    await index.applyQuery('boolean', undefined, undefined, () => false, 'true');
    expect((await index.page('boolean', 0, 10)).map((row) => row.physicalLine)).toEqual([3]);

    await index.applyQuery('number', undefined, undefined, () => false, '42');
    expect((await index.page('number', 0, 10)).map((row) => row.physicalLine)).toEqual([3]);
    await index.close();
  });
  it('treats ASCII whitespace-only physical lines as empty', async () => {
    const index = new JsonlIndex(defaultSettings); await index.openText('  \t\n{"x":1}');
    expect(index.lineMetadata(0).status).toBe('empty'); expect(index.total()).toBe(1);
  });
  it('marks over-limit lines without parsing them', async () => {
    const index = new JsonlIndex({ ...defaultSettings, maxLineBytes: 8 });
    await index.openText('{"long":"value"}\n{"x":1}');
    expect((await index.page('default', 0, 2))[0]?.status).toBe('tooLarge');
  });
  it('rejects pages after a streamed source changes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jsonl-preview-source-'));
    const path = join(directory, 'data.jsonl');
    const index = new JsonlIndex(defaultSettings);
    try {
      await writeFile(path, '{"id":1}\n'); await index.openFile(path);
      await writeFile(path, '{"id":1}\n{"id":2}\n');
      await expect(index.page('default', 0, 10)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    } finally { await index.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
