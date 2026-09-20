import { createScanner, SyntaxKind, parseTree, type ParseError, type ParseOptions } from 'jsonc-parser';

// Selection extraction runs on the extension host. Fall back to the original
// document (whose diagnostics run in the worker) when these budgets are exceeded.
const MAX_CHARACTERS = 2 * 1024 * 1024;
const MAX_DEPTH = 128;
const MAX_PARSES = 256;

function numericLogPrefixEnd(text: string, offset: number): number | undefined {
  // Only recognize metadata at the first non-indented position of a log line.
  // Values after a field name (or any other text) must remain candidates.
  let before = offset - 1;
  while (before >= 0 && (text[before] === ' ' || text[before] === '\t')) before--;
  if (before >= 0 && text[before] !== '\n' && text[before] !== '\r') return undefined;
  // Require a log level, not just any word after a single-number array.
  // Do not match commas, nested values, or a newline after the closing bracket:
  // those may be real (including malformed) arrays or JSONL records.
  const prefix = /\[(?:[0-9]+|[0-9]{4}-[0-9]{2}-[0-9]{2}[ Tt][0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:[Zz]|[+-][0-9]{2}:?[0-9]{2})?)\][ \t]+(?=(?:TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)(?:[ \t]|$))/iy;
  prefix.lastIndex = offset;
  return prefix.test(text) ? prefix.lastIndex : undefined;
}

function looksStructured(text: string, offset = 0): boolean {
  const scanner = createScanner(text, true);
  scanner.setPosition(offset);
  const first = scanner.scan();
  if (first === SyntaxKind.OpenBraceToken) return true;
  if (first !== SyntaxKind.OpenBracketToken) return false;
  if (numericLogPrefixEnd(text, scanner.getTokenOffset()) !== undefined) return false;
  // Bracketed logger names such as [DemoWorker] are not JSON arrays.
  return scanner.scan() !== SyntaxKind.Unknown;
}

/** Preserve complete or damaged JSON/JSONL; otherwise find embedded containers. */
export function selectionJsonCandidates(text: string, options: ParseOptions = {}): string[] {
  if (text.length > MAX_CHARACTERS) return [text];
  const spans: Array<{ start: number; end: number }> = [];
  const stack: string[] = [];
  let start = 0, quoted = false, escaped = false;
  let comment: 'line' | 'block' | undefined;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (comment === 'line') {
      if (char === '\n' || char === '\r') comment = undefined;
      continue;
    }
    if (comment === 'block') {
      if (char === '*' && text[index + 1] === '/') { comment = undefined; index++; }
      continue;
    }
    if (quoted) {
      if (char === '\n' || char === '\r') { quoted = false; escaped = false; stack.length = 0; }
      else if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    // Ignore comment structure even when comments are disabled; validation will
    // reject that entire value rather than extract a fragment from its comment.
    if (stack.length && char === '/' && (text[index + 1] === '/' || text[index + 1] === '*')) {
      comment = text[++index] === '/' ? 'line' : 'block';
      continue;
    }
    if (char === '"' && stack.length) { quoted = true; continue; }
    if (char === '{' || char === '[') {
      if (!stack.length) {
        if (char === '[') {
          const prefixEnd = numericLogPrefixEnd(text, index);
          if (prefixEnd !== undefined) { index = prefixEnd - 1; continue; }
        }
        if (char === '[' && !looksStructured(text, index)) continue;
        start = index;
      }
      stack.push(char === '{' ? '}' : ']');
      if (stack.length > MAX_DEPTH) return [text];
    } else if (char === '}' || char === ']') {
      const close = stack.pop();
      if (close !== char) stack.length = 0;
      else if (!stack.length) {
        spans.push({ start, end: index + 1 });
        if (spans.length > MAX_PARSES) return [text];
      }
    }
  }

  let parses = 0, characters = 0;
  const valid = (value: string): boolean => {
    if (++parses > MAX_PARSES || (characters += value.length) > MAX_CHARACTERS * 3) throw new Error('Extraction budget exceeded');
    const errors: ParseError[] = [];
    return Boolean(parseTree(value, errors, options)) && errors.length === 0;
  };
  try {
    if (valid(text)) return [text];
    const lines = text.split(/\r?\n/).filter((line) => line.trim());
    // Preserve mixed-validity JSONL too, including records with scalar roots.
    const structured = looksStructured(text);
    if (lines.length > 1 && (looksStructured(lines[0]!) || valid(lines[0]!))) return [text];

    const candidates: string[] = [];
    for (const span of spans) {
      const content = text.slice(span.start, span.end);
      if (valid(content)) candidates.push(content);
      // A malformed outer container must never become a valid child preview.
      else if (structured) return [text];
    }
    if (structured) {
      // Allow a valid value followed by a same-line log suffix. Ambiguous or
      // damaged structured selections, including mixed-validity JSONL, stay whole.
      const span = spans[0];
      const suffix = span ? text.slice(span.end).trimEnd() : '';
      if (spans.length !== 1 || candidates.length !== 1 || /[\r\n]/.test(suffix) || /^[\s]*[,}\]:]/.test(suffix)) return [text];
    }
    return candidates;
  } catch {
    return [text];
  }
}
