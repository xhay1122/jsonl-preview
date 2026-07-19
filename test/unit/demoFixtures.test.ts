import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseJsonDocument } from '../../src/worker/jsonService.js';
import { defaultSettings } from '../../src/shared/settings.js';

const demoDirectory = join(process.cwd(), 'demo');
const readDemo = (name: string) => readFileSync(join(demoDirectory, name), 'utf8');

function nonEmptyLines(name: string): string[] {
  return readDemo(name).split(/\r?\n/).filter((line) => line.trim().length > 0);
}

describe('demo fixtures', () => {
  it('keeps the successful JSON examples strict and parseable', () => {
    for (const name of ['catalog.json', 'edge-cases.json']) {
      expect(() => JSON.parse(readDemo(name)), name).not.toThrow();
    }
  });

  it('keeps every non-empty line in successful JSONL examples parseable', () => {
    for (const name of ['events.jsonl', 'metrics.ndjson', 'record-shapes.jsonl', 'exact-numbers.jsonl', 'empty-lines.jsonl', 'pagination.jsonl']) {
      for (const [index, line] of nonEmptyLines(name).entries()) {
        expect(() => JSON.parse(line), `${name}, record ${index + 1}`).not.toThrow();
      }
    }
  });

  it('contains enough rows to cross the default page boundary', () => {
    const rows = nonEmptyLines('pagination.jsonl').map((line) => JSON.parse(line) as { id: number });
    expect(rows).toHaveLength(defaultSettings.pageSize + 5);
    expect(rows.map((row) => row.id)).toEqual(Array.from({ length: defaultSettings.pageSize + 5 }, (_, index) => index + 1));
  });

  it('covers every supported JSONL root shape', () => {
    const values = nonEmptyLines('record-shapes.jsonl').map((line) => JSON.parse(line) as unknown);
    expect(values.map((value) => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value))
      .toEqual(['object', 'array', 'string', 'number', 'boolean', 'null', 'object', 'array']);
  });

  it('keeps malformed JSONL records isolated between valid records', () => {
    const results = nonEmptyLines('invalid-lines.jsonl').map((line) => {
      try { JSON.parse(line); return true; } catch { return false; }
    });
    expect(results).toEqual([true, false, false, false, true]);
  });

  it('exercises JSON compatibility settings independently of strict mode', () => {
    const text = readDemo('jsonc-options.json');
    expect(parseJsonDocument(text, defaultSettings).diagnostics.length).toBeGreaterThan(0);
    expect(parseJsonDocument(text, { ...defaultSettings, allowComments: true }).diagnostics.length).toBeGreaterThan(0);
    expect(parseJsonDocument(text, { ...defaultSettings, allowTrailingComma: true }).diagnostics.length).toBeGreaterThan(0);
    expect(parseJsonDocument(text, { ...defaultSettings, allowComments: true, allowTrailingComma: true }).diagnostics).toHaveLength(0);
  });

  it('keeps both repair examples invalid but automatically repairable', () => {
    for (const name of ['repairable.json', 'trailing-comma.json']) {
      const document = parseJsonDocument(readDemo(name), defaultSettings);
      expect(document.diagnostics.length, name).toBeGreaterThan(0);
      expect(document.repairs.length, name).toBeGreaterThan(0);
      expect(parseJsonDocument(document.repairs[0]!.result!, defaultSettings).diagnostics, name).toHaveLength(0);
    }
  });

  it('documents every demo data file', () => {
    const readme = readDemo('README.md');
    for (const name of readdirSync(demoDirectory).filter((entry) => /\.(?:json|jsonl|ndjson)$/.test(entry))) {
      expect(readme, name).toContain(`\`${name}\``);
    }
  });
});
