import { describe, expect, it } from 'vitest';
import { compareDecimals, compareForSort, matchesFilter, valueAtPointer } from '../../src/worker/filterEngine.js';

describe('filter engine', () => {
  it('compares decimal literals without rounding', () => {
    expect(compareDecimals('9007199254740993', '9007199254740992')).toBe(1);
    expect(compareDecimals('-0', '0')).toBe(0);
    expect(compareDecimals('1.2300e2', '123')).toBe(0);
    expect(compareDecimals('-1e-100', '-2e-100')).toBe(1);
  });
  it('uses RFC 6901 pointers without confusing dots', () => {
    const value = { '': 0, 'a.b': 1, a: { b: 2 }, 'a/b': { '~x': 3 } };
    expect(valueAtPointer(value, '')).toBe(value);
    expect(valueAtPointer(value, '/')).toBe(0);
    expect(valueAtPointer(value, '/a.b')).toBe(1);
    expect(valueAtPointer(value, '/a/b')).toBe(2);
    expect(valueAtPointer(value, '/a~1b/~0x')).toBe(3);
  });
  it('does not coerce types and combines filters', () => {
    expect(matchesFilter({ n: 2, text: 'hello' }, { op: 'and', items: [
      { op: 'compare', path: '/n', cmp: 'gt', value: { kind: 'number', decimal: '1.9' } },
      { op: 'contains', path: '/text', value: 'ell' }
    ] })).toBe(true);
    expect(matchesFilter({ n: '2' }, { op: 'compare', path: '/n', cmp: 'eq', value: { kind: 'number', decimal: '2' } })).toBe(false);
  });
  it('sorts mixed values stably by the documented type groups', () => {
    const rows = [{ k: null, i: 0 }, { k: 'a', i: 1 }, { k: 2, i: 2 }, { i: 3 }, { k: false, i: 4 }];
    rows.sort((a, b) => compareForSort(a, b, { path: '/k', direction: 'asc' }) || a.i - b.i);
    expect(rows.map((row) => row.i)).toEqual([2, 1, 4, 0, 3]);
  });
});
