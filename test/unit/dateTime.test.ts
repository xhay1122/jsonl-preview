import { describe, expect, it } from 'vitest';
import { formatTimestamp, parseTimestamp } from '../../src/webview/dateTime.js';

describe('timestamp recognition', () => {
  it.each([
    ['timestamp', 1704067200, 1704067200000],
    ['date', '1704067200000', 1704067200000],
    ['createdAt', '1704067200', 1704067200000],
    ['timestamp', 0, 0],
    ['timestamp_ms', 86400000, 86400000],
    ['timestampMilliseconds', '86400000', 86400000],
    ['timestamp_seconds', 86400, 86400000],
    ['createdAtSec', '86400.5', 86400500],
    ['timestamp_ms', -86400000, -86400000],
    ['timestamp_s', -86400, -86400000],
    ['timestamp_ms', 1704067200, 1704067200],
    ['timestamp_seconds', 100000000000, 100000000000000]
  ])('respects inferred or explicit units for %s = %s', (field, value, expected) => {
    expect(parseTimestamp(value, field)).toBe(expected);
  });

  it.each([
    ['timestamp', 86400000], ['timestamp', '86400000'], ['date', -86400000],
    ['timestamp', 999999999], ['timestamp', 10000000000], ['timestamp', 100000000000],
    ['timestamp', 1704067200.5], ['timestamp_ms', 1e30], ['timestamp', Infinity],
    ['id', 1704067200], ['format', 1704067200], ['timestamp', null], ['timestamp', 'bad']
  ])('does not guess ambiguous or unrelated values (%s = %s)', (field, value) => {
    expect(parseTimestamp(value, field)).toBeUndefined();
  });

  it.each([
    '2024-02-30T00:00:00Z', '2023-02-29T00:00:00Z', '1900-02-29T00:00:00Z',
    '2024-04-31T00:00:00+08:00', '2024-00-01T00:00:00Z', '2024-13-01T00:00:00Z',
    '2024-01-00T00:00:00Z', '2024-01-01T24:00:00Z', '2024-01-01T00:60:00Z',
    '2024-01-01T00:00:60Z', '2024-01-01T00:00:00+24:00', '2024-01-01T00:00:00+08:60',
    '2024-01-01T00:00:00', '2024-01-01'
  ])('rejects invalid or timezone-free ISO dates: %s', (value) => {
    expect(parseTimestamp(value, 'date')).toBeUndefined();
  });

  it.each([
    '2024-02-29T00:00:00Z', '2000-02-29T00:00:00Z', '2024-02-29T00:30:00+08:00',
    '2024-02-29T23:30:00-05:00', '2024-01-01T00:00:00.123Z', '2024-01-01T08:00:00+0800'
  ])('accepts valid dates and applies their timezone offsets: %s', (value) => {
    expect(parseTimestamp(value)).toBe(Date.parse(value));
  });
});

describe('timestamp formatting', () => {
  it('formats using the selected timezone and reports it for the tooltip', () => {
    const options = { locale: 'zh-cn', timezone: 'Asia/Shanghai' };
    const expected = '1970年1月1日 08:00:00.000';
    expect(formatTimestamp(0, options)).toEqual({ text: expected, timezone: options.timezone });
    expect(formatTimestamp(0, options)).toEqual({ text: expected, timezone: options.timezone });
  });

  it.each([
    [0, 'zh-cn', 'Asia/Shanghai', '1970年1月1日 08:00:00.000'],
    [1704067200007, 'zh-cn', 'Asia/Shanghai', '2024年1月1日 08:00:00.007'],
    [1704067200123, 'zh-cn', 'UTC', '2024年1月1日 00:00:00.123'],
    [1704067200999, 'en', 'America/New_York', 'Dec 31, 2023, 7:00:00.999 PM'],
    [-1, 'en', 'UTC', 'Dec 31, 1969, 11:59:59.999 PM']
  ])('shows three millisecond digits for %s in %s (%s)', (milliseconds, locale, timezone, expected) => {
    expect(formatTimestamp(milliseconds, { locale, timezone })).toEqual({ text: expected, timezone });
  });

  it('falls back safely for invalid timezones or dates', () => {
    expect(formatTimestamp(0, { timezone: 'Invalid/Zone' })).toBeUndefined();
    expect(formatTimestamp(NaN, {})).toBeUndefined();
  });
});
