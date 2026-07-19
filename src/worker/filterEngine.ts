import type { Filter, FilterLiteral, SortSpec } from '../shared/types.js';
import { PreviewError } from '../shared/errors.js';

export const MISSING = Symbol('missing');

export function valueAtPointer(value: unknown, pointer: string): unknown | typeof MISSING {
  if (pointer === '' || pointer === '/') return value;
  if (!pointer.startsWith('/')) return MISSING;
  let current: unknown = value;
  for (const encoded of pointer.slice(1).split('/')) {
    const segment = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current) && /^\d+$/.test(segment)) current = current[Number(segment)];
    else if (current !== null && typeof current === 'object' && Object.prototype.hasOwnProperty.call(current, segment)) current = (current as Record<string, unknown>)[segment];
    else return MISSING;
  }
  return current === undefined ? MISSING : current;
}

function decimalParts(input: string): { sign: number; digits: string; exponent: number } | undefined {
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(input.trim());
  if (!match) return undefined;
  const sign = match[1] === '-' ? -1 : 1;
  const integer = match[2]!;
  const fraction = match[3] ?? '';
  const all = `${integer}${fraction}`.replace(/^0+/, '') || '0';
  if (all === '0') return { sign: 1, digits: '0', exponent: 0 };
  const trailing = all.match(/0+$/)?.[0].length ?? 0;
  return { sign, digits: all.slice(0, all.length - trailing), exponent: Number(match[4] ?? 0) - fraction.length + trailing };
}

export function compareDecimals(left: string, right: string): number {
  const a = decimalParts(left), b = decimalParts(right);
  if (!a || !b) throw new PreviewError('INVALID_NUMBER', 'Invalid decimal literal');
  if (a.sign !== b.sign) return a.sign < b.sign ? -1 : 1;
  const magnitudeA = a.digits.length + a.exponent;
  const magnitudeB = b.digits.length + b.exponent;
  if (magnitudeA !== magnitudeB) return (magnitudeA < magnitudeB ? -1 : 1) * a.sign;
  const length = Math.max(a.digits.length, b.digits.length);
  const paddedA = a.digits.padEnd(length, '0');
  const paddedB = b.digits.padEnd(length, '0');
  return (paddedA === paddedB ? 0 : paddedA < paddedB ? -1 : 1) * a.sign;
}

function literalValue(literal: FilterLiteral): unknown {
  if (literal.kind === 'null') return null;
  if (literal.kind === 'number') return literal.decimal;
  return literal.value;
}

function compare(left: unknown, literal: FilterLiteral, exactNumber?: string): number | undefined {
  if (literal.kind === 'number') {
    if (typeof left !== 'number') return undefined;
    return compareDecimals(exactNumber ?? String(left), literal.decimal);
  }
  const right = literalValue(literal);
  if (typeof left !== typeof right && left !== null && right !== null) return undefined;
  return left === right ? 0 : String(left) < String(right) ? -1 : 1;
}

export function matchesFilter(value: unknown, filter?: Filter, exactNumbers: ReadonlyMap<string, string> = new Map()): boolean {
  if (!filter) return true;
  if (filter.op === 'and') return filter.items.every((item) => matchesFilter(value, item, exactNumbers));
  const field = valueAtPointer(value, filter.path);
  if (filter.op === 'exists') return field !== MISSING;
  if (filter.op === 'isNull') return field === null;
  if (field === MISSING) return false;
  if (filter.op === 'contains') return typeof field === 'string' && field.includes(filter.value);
  if (filter.op === 'compare') {
    const order = compare(field, filter.value, exactNumbers.get(filter.path));
    if (order === undefined) return filter.cmp === 'ne';
    return { eq: order === 0, ne: order !== 0, gt: order > 0, gte: order >= 0, lt: order < 0, lte: order <= 0 }[filter.cmp];
  }
  return false;
}

function rank(value: unknown | typeof MISSING): number {
  if (value === MISSING) return 7;
  if (value === null) return 6;
  if (Array.isArray(value)) return 5;
  const type = typeof value;
  if (type === 'number') return 0;
  if (type === 'string') return 1;
  if (type === 'boolean') return 2;
  if (type === 'object') return 4;
  return 3;
}

export function compareForSort(left: unknown, right: unknown, spec: SortSpec, leftExact?: ReadonlyMap<string, string>, rightExact?: ReadonlyMap<string, string>): number {
  if ('by' in spec) return 0;
  const a = valueAtPointer(left, spec.path), b = valueAtPointer(right, spec.path);
  const nullishA = a === null || a === MISSING, nullishB = b === null || b === MISSING;
  if (nullishA || nullishB) {
    if (nullishA && nullishB) return rank(a) - rank(b);
    return (nullishA ? 1 : -1) * (spec.nulls === 'first' ? -1 : 1);
  }
  const rankDifference = rank(a) - rank(b);
  let result = rankDifference;
  if (rankDifference === 0) {
    if (typeof a === 'number' && typeof b === 'number') result = compareDecimals(leftExact?.get(spec.path) ?? String(a), rightExact?.get(spec.path) ?? String(b));
    else if (typeof a === 'string' && typeof b === 'string') result = a === b ? 0 : a < b ? -1 : 1;
    else if (typeof a === 'boolean' && typeof b === 'boolean') result = Number(a) - Number(b);
    else result = JSON.stringify(a).localeCompare(JSON.stringify(b));
  }
  return spec.direction === 'desc' ? -result : result;
}
