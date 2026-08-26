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
  it('lets scalar values use the row width instead of a fixed viewport cap', () => {
    expect(declarations('.json-value')).toMatch(/flex:\s*1 1 auto/);
    expect(declarations('.json-value')).not.toMatch(/max-width/);
  });

  it('keeps the full-screen drawer host transparent and paints only the content panel', () => {
    expect(declarations('.t-drawer')).toMatch(/background:\s*transparent/);
    expect(declarations('.t-drawer__content-wrapper')).toMatch(/background:\s*var\(--vscode-editorWidget-background\)/);
  });

  it('keeps the drawer body scrollable within the viewport', () => {
    expect(declarations('.t-drawer__content-wrapper')).toMatch(/height:\s*100%/);
    expect(declarations('.t-drawer__body')).toMatch(/overflow:\s*auto/);
    expect(declarations('.t-drawer__body')).toMatch(/min-height:\s*0/);
  });

  it('reserves header space for the close button and keeps it above header actions', () => {
    expect(declarations('.t-drawer__header')).toMatch(/padding-right:\s*calc\(var\(--td-comp-size-xs\) \+ var\(--td-comp-margin-s\) \* 2\)/);
    expect(declarations('.t-drawer__close-btn')).toMatch(/z-index:\s*1/);
    expect(declarations('.drawer-header-actions')).toMatch(/flex:\s*0 1 auto/);
  });

  it('keeps full-content search visible while its text scrolls', () => {
    expect(declarations('.drawer-search')).toMatch(/position:\s*sticky/);
    expect(declarations('.drawer-search')).toMatch(/top:\s*0/);
    expect(declarations('.full-content-viewer mark')).toMatch(/background:\s*#fff59d/);
    expect(declarations('.full-content-viewer mark')).toMatch(/border-radius:\s*3px/);
    expect(declarations('.full-content-viewer mark.active-match')).toMatch(/background:\s*#f9a825/);
    expect(declarations('.full-content-viewer mark.active-match')).toMatch(/outline:\s*1px solid/);
  });

  it('uses the shared responsive three-line clamp and reveals the value action on interaction', () => {
    expect(styles).not.toMatch(/\.drawer-tree \.json-value\s*\{/);
    expect(declarations('.json-value')).toMatch(/-webkit-line-clamp:\s*3/);
    expect(declarations('.json-value')).toMatch(/line-clamp:\s*3/);
    expect(declarations('.json-value')).toMatch(/white-space:\s*normal/);
    expect(declarations('.json-value')).toMatch(/overflow-wrap:\s*anywhere/);
    expect(declarations('.tree-row')).toMatch(/position:\s*relative/);
    expect(declarations('.inline-actions')).toMatch(/position:\s*absolute/);
    expect(declarations('.inline-actions')).toMatch(/opacity:\s*0/);
    expect(declarations('.inline-actions')).toMatch(/transform:\s*translateX\(4px\)/);
    expect(styles).not.toMatch(/\.inline-actions::before\s*\{/);
    expect(declarations('.inline-action')).toMatch(/width:\s*26px/);
    expect(declarations('.tree-row:hover .inline-actions, .inline-actions:focus-within')).toMatch(/opacity:\s*1/);
    expect(declarations('.tree-row:hover .inline-actions, .inline-actions:focus-within')).toMatch(/pointer-events:\s*auto/);
  });
});

describe('webview JSONL grid styles', () => {
  it('uses the active editor background for the initial table loading overlay', () => {
    expect(declarations(':root')).toMatch(/--td-mask-disabled:\s*color-mix\(in srgb,\s*var\(--vscode-editor-background\) 72%,\s*transparent\)/);
  });

  it('maps the fixed table header surface to the active VS Code theme', () => {
    expect(declarations(':root')).toMatch(/--td-bg-color-secondarycontainer:\s*var\(--surface\)/);
    expect(declarations(':root')).toMatch(/--td-bg-color-secondarycontainer-hover:\s*var\(--vscode-list-hoverBackground\)/);
    expect(styles).toMatch(/\.jsonl-table \.t-table__header\.t-table__header--fixed > tr > th\s*\{[^}]*background:\s*var\(--surface\)/);
  });

  it('uses a single remaining-height scroll area and shared row widths', () => {
    expect(declarations('.jsonl-layout')).toMatch(/height:\s*100vh/);
    expect(declarations('.grid')).toMatch(/height:\s*100%/);
    expect(declarations('.grid-row')).toMatch(/width:\s*100%/);
    expect(declarations('.virtual-window')).toMatch(/width:\s*100%/);
  });

  it("reserves the paginator's actual height instead of clipping it at the bottom", () => {
    expect(declarations('.jsonl-table')).toMatch(/display:\s*flex/);
    expect(declarations('.jsonl-table')).toMatch(/flex-direction:\s*column/);
    expect(declarations('.jsonl-table.has-pagination .t-table__content')).toMatch(/flex:\s*1 1 auto/);
    expect(declarations('.jsonl-table.has-pagination .t-table__content')).toMatch(/height:\s*auto/);
    expect(declarations('.jsonl-table .t-table__pagination-wrap')).toMatch(/flex:\s*0 0 auto/);
    expect(declarations('.jsonl-table .t-table__pagination')).toMatch(/padding:\s*8px 12px/);
  });

  it('does not expose a second horizontal scrollbar in the fixed header', () => {
    const header = declarations('.jsonl-table .t-table__affixed-header-elm');
    expect(header).toMatch(/overflow-x:\s*hidden/);
    expect(header).toMatch(/scrollbar-width:\s*none/);
    expect(declarations('.jsonl-table .t-table__affixed-header-elm::-webkit-scrollbar')).toMatch(/height:\s*0/);
  });
});
