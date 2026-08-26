# Demo files

Open these files in VS Code and run **JSON(L) Preview: Open Preview**, or use
**Open With...** and select **JSON / JSONL Preview**.

## JSON

| File | Coverage |
| --- | --- |
| `catalog.json` | Nested objects and arrays, Unicode, dates, nulls, booleans, and an integer larger than JavaScript's safe range. |
| `edge-cases.json` | Empty containers, escaped strings, special property names, duplicate keys, deep lazy expansion, timezone variants, and exact numeric spellings. |
| `jsonc-options.json` | Comments and trailing commas. It parses only when both JSON compatibility settings are enabled. |
| `repairable.json` | Missing closing delimiters at EOF; use it to test repair preview. |
| `trailing-comma.json` | A trailing comma in strict JSON; use it to test the remove-comma repair. |

Useful JSON queries include `products[?inStock].name` in `catalog.json` and
`deep.level1.level2.level3.level4.level5.level6.level7.level8.level9.level10.level11.value`
in `edge-cases.json`.

## JSONL / NDJSON

| File | Coverage |
| --- | --- |
| `events.jsonl` | Object records for filtering, sorting, date display, sparse columns, Unicode, and row details. |
| `metrics.ndjson` | Sparse and mixed fields, nested objects, arrays, nulls, and schema sampling. |
| `record-shapes.jsonl` | Object, array, string, number, boolean, null, and empty root records; non-object roots use the `$` column. |
| `exact-numbers.jsonl` | Integers beyond the safe range, equivalent numeric spellings, exponent notation, precise decimals, and `-0`. |
| `empty-lines.jsonl` | Blank and whitespace-only physical lines between valid records; toggle `jsonlPreview.jsonl.ignoreEmptyLines`. |
| `pagination.jsonl` | 1005 records, enough to exercise the default 1000-row page and **Load more** behavior. |
| `comprehensive-complex.jsonl` | 1000 large, deeply nested records with long text, arrays, sparse values, exact identifiers, Unicode, escaped content, and varied enterprise-style data. |
| `invalid-lines.jsonl` | Valid rows surrounding several independently malformed physical lines. |

Suggested JSONL checks:

- Filter `events.jsonl` with JMESPath `level == 'error'`.
- Sort `exact-numbers.jsonl` by `/value` and verify that the two large integers remain distinct.
- Open `record-shapes.jsonl` and verify that every physical line remains a separate row.
- Open `empty-lines.jsonl` with empty-line ignoring both enabled and disabled.
- Open `pagination.jsonl`, then load the final five rows.
- Open `comprehensive-complex.jsonl` to exercise large-file rendering, nested row details, search, filtering, sorting, and export with realistic complex records.

`repairable.json`, `trailing-comma.json`, `jsonc-options.json` under strict settings,
and the malformed rows in `invalid-lines.jsonl` are deliberately invalid. Do not
use them as fixtures that are expected to parse successfully.
