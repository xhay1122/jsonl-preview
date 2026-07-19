export function isPlainValueQuery(query: string): boolean {
  const trimmed = query.trim();
  if (!trimmed) return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed === null || typeof parsed !== 'object';
  } catch {
    return !/[\[\]{}|&?*`]/.test(trimmed);
  }
}

/**
 * Builds the scalar-value matcher once per query. The returned function walks
 * one JSON value without materialising a flattened copy of the record.
 */
export function createJsonValueMatcher(query: string): (value: unknown) => boolean {
  const trimmed = query.trim();
  let needle: unknown = trimmed;
  try { needle = JSON.parse(trimmed); } catch { /* use the text as entered */ }
  const textNeedle = typeof needle === 'string' ? needle.toLocaleLowerCase() : undefined;

  return (value: unknown): boolean => {
    const pending: unknown[] = [value];
    while (pending.length) {
      const candidate = pending.pop();
      if (candidate !== null && typeof candidate === 'object') {
        if (Array.isArray(candidate)) {
          for (let index = 0; index < candidate.length; index++) pending.push(candidate[index]);
        } else {
          for (const child of Object.values(candidate)) pending.push(child);
        }
        continue;
      }
      if (textNeedle === undefined) {
        if (Object.is(candidate, needle)) return true;
      } else if (String(candidate).toLocaleLowerCase().includes(textNeedle)) return true;
    }
    return false;
  };
}

export function searchJsonValues(value: unknown, query: string): unknown[] {
  const trimmed = query.trim();
  let needle: unknown = trimmed;
  try { needle = JSON.parse(trimmed); } catch { /* use the text as entered */ }
  const textNeedle = typeof needle === 'string' ? needle.toLocaleLowerCase() : undefined;
  const matches: unknown[] = [];
  const pending: unknown[] = [value];
  while (pending.length) {
    const candidate = pending.pop();
    if (candidate !== null && typeof candidate === 'object') {
      for (const child of Array.isArray(candidate) ? candidate : Object.values(candidate)) pending.push(child);
      continue;
    }
    const exact = textNeedle === undefined && Object.is(candidate, needle);
    const contains = textNeedle !== undefined && String(candidate).toLocaleLowerCase().includes(textNeedle);
    if (exact || contains) matches.push(candidate);
  }
  return matches;
}
