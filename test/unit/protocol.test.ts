import { describe, expect, it } from 'vitest';
import { validateWorkerRequest } from '../../src/worker/protocol.js';
import { defaultSettings } from '../../src/shared/settings.js';

describe('worker protocol validation', () => {
  it('bounds page sizes and text chunk sizes', () => {
    expect(validateWorkerRequest({ type: 'jsonl/getPage', requestId: '1', sessionId: 's', revision: 'r', queryId: 'default', queryRevision: 0, offset: 0, limit: 1000 })).toBe(true);
    expect(validateWorkerRequest({ type: 'jsonl/getPage', requestId: '1', sessionId: 's', revision: 'r', queryId: 'default', queryRevision: 0, offset: 0, limit: 1001 })).toBe(false);
    expect(validateWorkerRequest({ type: 'session/openText', requestId: '1', sessionId: 's', revision: 'r', kind: 'json', chunks: ['x'.repeat(256 * 1024 + 1)], settings: defaultSettings })).toBe(false);
    expect(validateWorkerRequest({ type: 'jsonl/getRecord', requestId: '1', sessionId: 's', revision: 'r', physicalLine: 1 })).toBe(true);
    expect(validateWorkerRequest({ type: 'jsonl/getRecord', requestId: '1', sessionId: 's', revision: 'r', physicalLine: 0 })).toBe(false);
    expect(validateWorkerRequest({ type: 'jsonl/getCell', requestId: '1', sessionId: 's', revision: 'r', physicalLine: 1, field: 'request.messages' })).toBe(true);
    expect(validateWorkerRequest({ type: 'jsonl/getCellValue', requestId: '1', sessionId: 's', revision: 'r', physicalLine: 1, pointer: '/request/messages', format: 'plain' })).toBe(true);
    expect(validateWorkerRequest({ type: 'jsonl/getCellValue', requestId: '1', sessionId: 's', revision: 'r', physicalLine: 1, pointer: '', format: 'json' })).toBe(true);
    expect(validateWorkerRequest({ type: 'jsonl/getCell', requestId: '1', sessionId: 's', revision: 'r', physicalLine: 1, field: '' })).toBe(false);
  });
  it('rejects unsupported native regular-expression filters', () => {
    expect(validateWorkerRequest({ type: 'jsonl/applyQuery', requestId: '1', sessionId: 's', revision: 'r', queryId: 'q', queryRevision: 1, filter: { op: 'regex', path: '/x', value: '(a|aa)+$' } })).toBe(false);
    expect(validateWorkerRequest({ type: 'jsonl/applyQuery', requestId: '1', sessionId: 's', revision: 'r', queryId: 'q', queryRevision: 1, filter: { op: 'exists', path: '' } })).toBe(true);
  });
  it('accepts only the dedicated physical-line sort shape', () => {
    const base = { type: 'jsonl/applyQuery', requestId: '1', sessionId: 's', revision: 'r', queryId: 'q', queryRevision: 1 } as const;
    expect(validateWorkerRequest({ ...base, sort: { by: 'physicalLine', direction: 'desc' } })).toBe(true);
    expect(validateWorkerRequest({ ...base, sort: { by: 'physicalLine', path: '/id', direction: 'desc' } })).toBe(false);
    expect(validateWorkerRequest({ ...base, sort: { path: '', direction: 'asc' } })).toBe(true);
  });
});
