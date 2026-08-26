import { isHostMessage } from '../../src/webview/protocol.js';
import { describe, expect, it } from 'vitest';

describe('webview host message validation', () => {
  it('accepts versioned page messages', () => {
    expect(isHostMessage({ type: 'page', rows: [], total: 0, offset: 0, queryRevision: 4 })).toBe(true);
    expect(isHostMessage({ type: 'copied' })).toBe(true);
  });

  it('rejects malformed messages before they reach React state', () => {
    expect(isHostMessage({ type: 'page', rows: 'not-an-array', total: 0, offset: 0, queryRevision: 4 })).toBe(false);
    expect(isHostMessage({ type: 'children', parentId: 'root', generation: 'old', offset: 0, nodes: [] })).toBe(false);
    expect(isHostMessage({ type: 'unknown' })).toBe(false);
  });
});
