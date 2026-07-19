import { describe, expect, it } from 'vitest';
import { validateWorkerRequest } from '../../src/worker/protocol.js';
import { defaultSettings } from '../../src/shared/settings.js';

describe('worker protocol validation', () => {
  it('bounds page sizes and text chunk sizes', () => {
    expect(validateWorkerRequest({ type: 'jsonl/getPage', requestId: '1', sessionId: 's', revision: 'r', queryId: 'default', queryRevision: 0, offset: 0, limit: 1000 })).toBe(true);
    expect(validateWorkerRequest({ type: 'jsonl/getPage', requestId: '1', sessionId: 's', revision: 'r', queryId: 'default', queryRevision: 0, offset: 0, limit: 1001 })).toBe(false);
    expect(validateWorkerRequest({ type: 'session/openText', requestId: '1', sessionId: 's', revision: 'r', kind: 'json', chunks: ['x'.repeat(256 * 1024 + 1)], settings: defaultSettings })).toBe(false);
  });
  it('rejects unsupported native regular-expression filters', () => {
    expect(validateWorkerRequest({ type: 'jsonl/applyQuery', requestId: '1', sessionId: 's', revision: 'r', queryId: 'q', queryRevision: 1, filter: { op: 'regex', path: '/x', value: '(a|aa)+$' } })).toBe(false);
  });
  it('accepts only the dedicated physical-line sort shape', () => {
    const base = { type: 'jsonl/applyQuery', requestId: '1', sessionId: 's', revision: 'r', queryId: 'q', queryRevision: 1 } as const;
    expect(validateWorkerRequest({ ...base, sort: { by: 'physicalLine', direction: 'desc' } })).toBe(true);
    expect(validateWorkerRequest({ ...base, sort: { by: 'physicalLine', path: '/id', direction: 'desc' } })).toBe(false);
  });
});
