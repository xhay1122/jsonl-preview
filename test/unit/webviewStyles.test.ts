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

  it('reserves header space for the close button and keeps it above header actions', () => {
    expect(declarations('.t-drawer__header')).toMatch(/padding-right:\s*calc\(var\(--td-comp-size-xs\) \+ var\(--td-comp-margin-s\) \* 2\)/);
    expect(declarations('.t-drawer__close-btn')).toMatch(/z-index:\s*1/);
    expect(declarations('.drawer-header-actions')).toMatch(/flex:\s*0 1 auto/);
  });

  it('wraps complete short values while keeping the long-value action on one line', () => {
    expect(declarations('.drawer-tree .tree-row')).toMatch(/align-items:\s*flex-start/);
    expect(declarations('.drawer-tree .json-value:not(.long-value)')).toMatch(/white-space:\s*pre-wrap/);
    expect(declarations('.drawer-tree .json-value:not(.long-value)')).toMatch(/overflow-wrap:\s*anywhere/);
    expect(declarations('.inline-action')).toMatch(/flex:\s*0 0 auto/);
    expect(declarations('.inline-action')).toMatch(/white-space:\s*nowrap/);
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
