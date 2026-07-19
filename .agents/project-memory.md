# JSON / JSONL Preview project memory

Last checked against the working tree: 2026-07-19.

## Product and implementation shape

This repository is a VS Code workspace extension for safe, paged previews of `.json`,
`.jsonl`, and `.ndjson` files. The runtime is deliberately split into three parts:

1. The extension host owns VS Code integration, document revisions, edits, exports, and
   session lifetime (`src/extension.ts`, `src/editors`, `src/document`).
2. A Node worker owns parsing, indexing, filtering, sorting, and JSON repair planning
   (`src/worker`). CPU-heavy or whole-file work should stay here.
3. A React webview renders the JSON tree and JSONL grid and communicates only through the
   typed message protocol (`src/webview`).

Build output is three bundles: `dist/extension.js`, `dist/worker.js`, and
`dist/webview.js` plus its CSS. `vscode` remains external to the extension bundle.

## Source-of-truth warning

`docs/technical-design.md` contains useful original goals, but it is partly mojibake and
includes planned features that are not necessarily implemented. For current behavior use,
in order: executable tests, `src`, `package.json`, then `README.md`. Do not implement a
design-document item merely because it is listed there; first confirm it is still wanted.

## Data-source and mode rules

- Normal mode uses `TextDocumentSource`, snapshots `document.getText()`, and identifies a
  revision as `v<document.version>`. It therefore includes unsaved edits.
- Large-file mode is read-only and currently supports saved `file:` resources only. It uses
  `ByteStreamSource` and is selected only for JSONL/NDJSON above
  `jsonlPreview.largeFileThresholdMB` when no dirty document is open.
- Streaming sessions are pinned to a stable `(size, mtimeMs, dev, ino)` signature. The
  worker rechecks it before opening the file. Preserve this time-of-check/time-of-use guard.
- JSON never uses large-file streaming. A file that cannot stream is constrained by
  `jsonlPreview.normalModeMaxFileMB` (100 MB by default).
- The extension host may chunk a normal-mode snapshot into 256 KiB strings, but large-file
  content must not be materialized and copied through the extension host or webview.
- `DocumentCoordinator` shares sessions only when URI, source mode, revision, document kind,
  and settings hash all match. It reference-counts them and invalidates all sessions after a
  worker restart.

## Correctness and safety invariants

- Treat byte offsets and VS Code UTF-16 offsets as different units. Shared branded types
  exist for this reason; Unicode and emoji are regression cases.
- A physical JSONL line is a record boundary. Preserve original 1-based physical line
  numbers, LF/CRLF/no-final-newline behavior, blank-line policy, and per-line error isolation.
- A malformed, empty (when configured as invalid), or oversized JSONL line must not prevent
  other lines from being indexed and displayed. Oversized lines get a truncated preview and
  `LINE_TOO_LARGE` diagnostic.
- Numeric filtering and sorting must preserve raw decimal spellings where needed. Never rely
  solely on JavaScript `number` for integers beyond `Number.MAX_SAFE_INTEGER`, precise
  decimals, exponent forms, or `-0`.
- Duplicate JSON keys are representable. JSON Pointer/JSONPath can be ambiguous; retain the
  occurrence/ambiguity behavior instead of silently claiming a unique path.
- Native JavaScript regular-expression filters are intentionally rejected at the worker
  protocol boundary. Do not add them without a bounded-time engine and corresponding tests.
- Every worker request is untrusted input and must remain size/depth/range validated in
  `src/worker/protocol.ts`. Webview messages also need validation at both sides of the bridge.
- Long-running query results are guarded by document `revision` and UI `queryRevision`.
  Stale pages, searches, repairs, formats, and exports must never overwrite newer state.
- Repairs are limited to validated, high-confidence minimal edits. Show a diff and ask for
  confirmation before applying them. All source changes go through VS Code edits so they are
  undoable.
- Keep the webview CSP strict and render file content as data, never executable markup.
  The extension supports untrusted workspaces and must not execute workspace code or upload
  file content.
- Persistent view state is metadata only. It is capped at 16 KiB per entry and 100 entries;
  do not store file content, sampled values, or query results in `workspaceState`.
- File conversion/export should avoid publishing partial output. Local conversion uses a
  temporary sibling and rename; overwrite requires explicit confirmation.

## Protocol change checklist

When adding or changing a message:

1. Update the relevant union in `src/worker/protocol.ts` or `src/webview/protocol.ts`.
2. Update runtime validation, including limits for strings, arrays, nesting, offsets, pages,
   and byte sizes.
3. Update sender and receiver, and preserve `revision`/`queryRevision` checks.
4. Add protocol rejection tests plus a behavior test at the nearest useful boundary.

Known sharp edge: `jsonlPreview.jsonl.pageSize` defaults to 1000 and permits 1000, while
`validateWorkerRequest()` currently caps `jsonl/getPage.limit` at 500. The initial query page
can still contain 1000 rows because it is produced inside `applyQuery`, but a later explicit
page request uses the configured page size and can be rejected. Treat this as an existing
configuration/protocol mismatch to fix with a regression test, not as an intentional limit.

## Development workflow

- Install reproducibly: `npm ci`
- Type-check: `npm run check`
- Build all three bundles: `npm run build`
- Full verification: `npm test` (builds first, then runs Vitest)
- Benchmarks: `npm run benchmark`
- 100 MB smoke test: `npm run performance:100mb`
- Release gate: `npm run package`
- Create VSIX: `npm run vsix`
- Extension debugging: launch **Run JSON(L) Preview** from `.vscode/launch.json`; it builds
  first. `npm run watch` is available for bundle watching.

Before handing off a code change, normally run `npm run check` and the narrowest relevant
Vitest file; run `npm test` for cross-boundary, build, protocol, or release-facing changes.
CI runs check and tests on Linux, Windows, and macOS, with benchmarks separately on Linux.

## Test and demo map

- `test/unit/jsonService.test.ts`: tree ranges/paths, exact literals, repair confidence,
  JMESPath behavior.
- `test/unit/jsonlIndex.test.ts`: line endings, pagination/query cache, bad/oversized lines,
  stable and exact-number sorting.
- `test/unit/filterEngine.test.ts`: typed filters and decimal comparison.
- `test/unit/protocol.test.ts` and `webviewProtocol.test.ts`: trust-boundary validation.
- `test/unit/documentCoordinator.test.ts`: session sharing, release, restart, and file limits.
- `test/unit/webviewState.test.ts` and `webviewApp.test.tsx`: stale-response rejection and UI
  interaction behavior.
- `test/integration/worker.test.ts`: actual worker-thread boundary and stale revisions.
- `test/performance`: representative benchmark and generated 100 MB smoke workload.
- `demo/README.md` maps hand-test files to edge cases. Some fixtures are deliberately invalid;
  read that file before treating every demo as a successful-parse fixture.

High-value manual checks include `pagination.jsonl` crossing the default 1000-row boundary,
`invalid-lines.jsonl` retaining valid neighbors, `exact-numbers.jsonl` preserving numeric
order, `empty-lines.jsonl` under both policies, and the repair preview files remaining invalid
until the user applies a suggested edit.

## Maintenance conventions

- TypeScript is strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
  Omit absent optional properties rather than assigning `undefined` unless the type allows it.
- Source imports use `.js` extensions because the project uses NodeNext resolution and bundles
  TypeScript with esbuild.
- Configuration has three representations that must stay aligned: `package.json` contribution
  defaults/ranges, `settings()` in `src/extension.ts`, and `PreviewSettings` plus protocol
  validation. Add/update tests when changing any setting.
- User-facing extension contribution strings are localized through `package.nls.json` and
  `package.nls.zh-cn.json`; webview strings currently live in `src/webview/i18n.ts`.
- Generated directories and packages (`dist`, `node_modules`, coverage, `*.vsix`) are ignored.
  Do not treat generated bundle edits as source changes.
