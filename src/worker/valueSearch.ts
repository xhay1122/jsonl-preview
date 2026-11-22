import type { TimeDisplayOptions } from '../shared/dateTime.js';
import { scalarMatches, scalarRanges } from '../shared/jsonSearch.js';

export { isPlainValueQuery } from '../shared/jsonSearch.js';

/**
 * Builds the scalar-value matcher once per query. The returned function walks
 * one JSON value without materialising a flattened copy of the record.
 */
export function createJsonValueMatcher(query: string, time: TimeDisplayOptions): (value: unknown) => boolean {
  const match = scalarMatches(query);

  return (value: unknown): boolean => {
    const pending: Array<{ value: unknown; field?: string }> = [{ value }];
    while (pending.length) {
      const { value: candidate, field } = pending.pop()!;
      if (candidate !== null && typeof candidate === 'object') {
        if (Array.isArray(candidate)) {
          for (const child of candidate) pending.push({ value: child });
        } else {
          for (const [key, child] of Object.entries(candidate)) pending.push({ value: child, field: key });
        }
        continue;
      }
      for (const _ of scalarRanges(match, String(candidate), candidate, field, time)) return true;
    }
    return false;
  };
}
