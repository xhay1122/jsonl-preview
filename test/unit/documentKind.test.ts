import { describe, expect, it } from 'vitest';
import { previewDocumentKind } from '../../src/shared/documentKind.js';

describe('previewDocumentKind', () => {
  it('uses a recognized file extension when one is present', () => {
    expect(previewDocumentKind('/data/events.jsonl', '{"id":1}')).toBe('jsonl');
    expect(previewDocumentKind('/data/events.ndjson', '[1,2]')).toBe('jsonl');
    expect(previewDocumentKind('/data/events.json', '{"id":1}\n{"id":2}')).toBe('json');
  });

  it('detects JSON pasted into an untitled document', () => {
    expect(previewDocumentKind('/Untitled-1', '{\n  "items": [1, 2]\n}')).toBe('json');
  });

  it('detects JSON Lines pasted into an untitled document', () => {
    expect(previewDocumentKind('/Untitled-1', '{"id":1}\n{"id":2}\n')).toBe('jsonl');
  });

  it('detects JSON and JSON Lines in text files from their content', () => {
    expect(previewDocumentKind('/data/payload.txt', '{"id":1}')).toBe('json');
    expect(previewDocumentKind('/data/events.txt', '{"id":1}\n{"id":2}\n')).toBe('jsonl');
  });

  it('falls back to JSON so malformed content gets JSON diagnostics', () => {
    expect(previewDocumentKind('/Untitled-1', '{"incomplete":')).toBe('json');
  });
});
