import { describe, expect, it, vi } from 'vitest';
import { parseTree } from 'jsonc-parser';

vi.mock('jsonc-parser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jsonc-parser')>();
  return { ...actual, parseTree: vi.fn(actual.parseTree) };
});
import { selectionJsonCandidates } from '../../src/shared/selectionJson.js';

describe('selectionJsonCandidates', () => {
  it('extracts the payload from a full runtime log with a bracketed component', () => {
    const log = '2000-01-01T00:00:00.000Z INFO demo-request-001 example_app::worker::run: [DemoWorker] task completed duration_ms=12 payload={"sample_total":2}';
    expect(selectionJsonCandidates(log)).toEqual(['{"sample_total":2}']);
  });

  it.each(['[2000-01-01 00:00:00]', '[24680]', '[2000-01-01T00:00:00.000Z]', '[2000-01-01T08:00:00+08:00]'])('extracts payloads after numeric log metadata: %s', (prefix) => {
    const json = '{"sample":true}';
    expect(selectionJsonCandidates(`  ${prefix} INFO payload=${json}`)).toEqual([json]);
    expect(selectionJsonCandidates(`${prefix} INFO payload=${json}\n${prefix} DEBUG payload=[1,2]\n`))
      .toEqual([json, '[1,2]']);
  });

  it.each(['\n', '\r\n', '\n\n', ' \t\r\n'])('ignores trailing selection whitespace after a log suffix: %j', (ending) => {
    expect(selectionJsonCandidates(`{"sample":true} elapsed=7${ending}`)).toEqual(['{"sample":true}']);
    expect(selectionJsonCandidates(`[1,2] elapsed=7${ending}`)).toEqual(['[1,2]']);
  });

  it.each(['INFO payload=[73] elapsed=7', 'payload=[73] INFO completed', '[73] elapsed=7', '  [73] completed'])('keeps single-number array payloads: %s', (text) => {
    expect(selectionJsonCandidates(text)).toEqual(['[73]']);
  });

  it('keeps request and response candidates in source order', () => {
    expect(selectionJsonCandidates('request=[73] response={"sample":true}'))
      .toEqual(['[73]', '{"sample":true}']);
  });

  it.each(['\n', '\r\n', '\r'])('distinguishes line prefixes from payload arrays across %j', (newline) => {
    const text = `[24680] INFO payload=[73] elapsed=7${newline}\t[13579] DEBUG payload=[91] done`;
    expect(selectionJsonCandidates(text)).toEqual(['[73]', '[91]']);
  });

  it.each(['[24680]', '[1,2]', '[1 2] INFO payload={"sample":true}', '[1,{"sample":true},]', '[1,{"sample":true},] INFO payload={"next":2}', '{"sample":true} elapsed=7\nother text'])('preserves arrays and genuinely multiline structured selections: %s', (text) => {
    expect(selectionJsonCandidates(text)).toEqual([text]);
  });

  it.each(['%s trailing text', 'prefix %s suffix', 'prefix %s'])('handles JSON anywhere in arbitrary log formats: %s', (format) => {
    const json = '[{"nested":{"items":[1,2]}}]';
    expect(selectionJsonCandidates(format.replace('%s', json))).toEqual([json]);
  });

  it('ignores brackets and escaped quotes within JSON strings and preserves raw numbers', () => {
    const json = '{"message":"a \\"quoted\\" } [ value","id":1234567890123456789012345}';
    expect(selectionJsonCandidates(`payload=${json} done`)).toEqual([json]);
  });

  it('offers separate values in source order without nested duplicates', () => {
    expect(selectionJsonCandidates('request={"a":{}} response=[1,{"b":2}]\nnext={"c":3}'))
      .toEqual(['{"a":{}}', '[1,{"b":2}]', '{"c":3}']);
  });

  it.each(['  {"a":1} \n', '{\n"a":[1,2]\n}', '{"a":1}\n{"b":2}\n', '42', '"hello"', 'null'])('preserves complete JSON/JSONL: %s', (text) => {
    expect(selectionJsonCandidates(text)).toEqual([text]);
  });

  it('preserves configured JSONC and trailing commas', () => {
    const text = '// comment\n{"a":1,}';
    expect(selectionJsonCandidates(text, { disallowComments: false, allowTrailingComma: true })).toEqual([text]);
  });

  it('finds valid values after invalid or incomplete log brackets', () => {
    expect(selectionJsonCandidates('[INFO data={"ok":true} done')).toEqual(['{"ok":true}']);
    expect(selectionJsonCandidates('bad={"oops":"unterminated\nnext={"ok":true}')).toEqual(['{"ok":true}']);
  });

  it.each(['no JSON here elapsed=12', '[INFO] {not json}', 'payload={"a":', ''])('returns no candidates for invalid input: %s', (text) => {
    expect(selectionJsonCandidates(text)).toEqual([]);
  });

  it.each([
    '{"sample":{"ready":true},}',
    '{"sample":1,}',
    '42\n{"sample":{"ready":true},}',
    '{"sample":1}\n{"sample":{"ready":true},}',
    '{"sample":{"ready":true},}\n{"sample":2}',
    '{"sample":{"ready":true}'
  ])('retains malformed structured input for diagnostics: %s', (text) => {
    expect(selectionJsonCandidates(text)).toEqual([text]);
  });

  it('does not offer children of an invalid embedded container', () => {
    expect(selectionJsonCandidates('payload={"sample":{"ready":true},}')).toEqual([]);
  });

  it.each([
    '{"sample":1, /* } ] " ignored */ "ready":true}',
    '{"sample":1, // } ] " ignored\n "ready":true}'
  ])('handles structural characters inside embedded JSONC comments', (json) => {
    expect(selectionJsonCandidates(`INFO ${json} done`, { disallowComments: false })).toEqual([json]);
    expect(selectionJsonCandidates(`INFO ${json} done`, { disallowComments: true })).toEqual([]);
  });

  it('never reparses overlapping invalid containers', () => {
    vi.mocked(parseTree).mockClear();
    const text = `payload=${'['.repeat(100)}invalid${']'.repeat(100)}`;
    expect(selectionJsonCandidates(text)).toEqual([]);
    expect(parseTree).toHaveBeenCalledTimes(2);
  });

  it.each([2000, 4000])('skips synchronous parsing for %i nested containers', (depth) => {
    vi.mocked(parseTree).mockClear();
    const text = `payload=${'['.repeat(depth)}invalid${']'.repeat(depth)}`;
    expect(selectionJsonCandidates(text)).toEqual([text]);
    expect(parseTree).not.toHaveBeenCalled();
  });

  it('bounds input size and the number of candidate parses', () => {
    for (const text of ['x'.repeat(2 * 1024 * 1024 + 1), 'payload={} '.repeat(300)]) {
      vi.mocked(parseTree).mockClear();
      expect(selectionJsonCandidates(text)).toEqual([text]);
      expect(parseTree).not.toHaveBeenCalled();
    }
  });

});
