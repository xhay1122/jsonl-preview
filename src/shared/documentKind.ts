import { parseTree, type ParseError } from 'jsonc-parser';

export type PreviewDocumentKind = 'json' | 'jsonl';

export function previewDocumentKind(path: string, text: string): PreviewDocumentKind {
  if (/\.(?:jsonl|ndjson)$/i.test(path)) return 'jsonl';
  if (/\.json$/i.test(path)) return 'json';

  const errors: ParseError[] = [];
  if (parseTree(text, errors) && errors.length === 0) return 'json';

  const records = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (records.length > 1 && records.every((line) => {
    const lineErrors: ParseError[] = [];
    return Boolean(parseTree(line, lineErrors)) && lineErrors.length === 0;
  })) return 'jsonl';

  // Let the JSON preview surface useful parse and repair diagnostics for
  // empty, incomplete, or otherwise ambiguous untitled documents.
  return 'json';
}
