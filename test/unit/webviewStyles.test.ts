import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(join(process.cwd(), 'src', 'webview', 'styles.css'), 'utf8');

function declarations(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = styles.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  if (!match) throw new Error(`Missing CSS rule for ${selector}`);
  return match[1]!;
}

describe('webview drawer styles', () => {
  it('keeps the full-screen drawer host transparent and paints only the content panel', () => {
    expect(declarations('.t-drawer')).toMatch(/background:\s*transparent/);
    expect(declarations('.t-drawer__content-wrapper')).toMatch(/background:\s*var\(--vscode-editorWidget-background\)/);
  });

  it('keeps the drawer body scrollable within the viewport', () => {
    expect(declarations('.t-drawer__content-wrapper')).toMatch(/height:\s*100%/);
    expect(declarations('.t-drawer__body')).toMatch(/overflow:\s*auto/);
    expect(declarations('.t-drawer__body')).toMatch(/min-height:\s*0/);
  });
});

describe('webview JSONL grid styles', () => {
  it('uses a single remaining-height scroll area and shared row widths', () => {
    expect(declarations('.jsonl-layout')).toMatch(/height:\s*100vh/);
    expect(declarations('.grid')).toMatch(/height:\s*100%/);
    expect(declarations('.grid-row')).toMatch(/width:\s*100%/);
    expect(declarations('.virtual-window')).toMatch(/width:\s*100%/);
  });

  it('does not expose a second horizontal scrollbar in the fixed header', () => {
    const header = declarations('.jsonl-table .t-table__affixed-header-elm');
    expect(header).toMatch(/overflow-x:\s*hidden/);
    expect(header).toMatch(/scrollbar-width:\s*none/);
    expect(declarations('.jsonl-table .t-table__affixed-header-elm::-webkit-scrollbar')).toMatch(/height:\s*0/);
  });
});
