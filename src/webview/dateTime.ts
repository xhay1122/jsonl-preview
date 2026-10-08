interface TimeDisplayOptions { locale?: string; timezone?: string }
const formatters = new Map<string, { formatter: Intl.DateTimeFormat; timezone: string }>();

/** Only infer conventional Unix units; shorter values require a field unit. */
export function parseTimestamp(value: unknown, field?: string): number | undefined {
  const tokens = (field ?? '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[_\-.\s/]+/);
  const temporalField = tokens.some((token) => ['date', 'time', 'timestamp', 'datetime', 'at'].includes(token));
  if (temporalField && (typeof value === 'number' || (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value)))) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return undefined;
    const unit = tokens.at(-1);
    let milliseconds: number;
    if (unit === 'ms' || unit === 'millisecond' || unit === 'milliseconds') milliseconds = numeric;
    else if (unit === 's' || unit === 'sec' || unit === 'second' || unit === 'seconds') milliseconds = numeric * 1000;
    else if (numeric === 0) milliseconds = 0;
    else {
      if (!Number.isInteger(numeric)) return undefined;
      const digits = String(Math.abs(numeric)).length;
      if (digits === 10) milliseconds = numeric * 1000;
      else if (digits === 13) milliseconds = numeric;
      else return undefined;
    }
    return Number.isFinite(new Date(milliseconds).getTime()) ? milliseconds : undefined;
  }
  if (typeof value !== 'string') return undefined;
  const iso = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-](\d{2}):?(\d{2}))$/i.exec(value);
  if (!iso) return undefined;
  const year = Number(iso[1]), month = Number(iso[2]), day = Number(iso[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]!
    || Number(iso[4]) > 23 || Number(iso[5]) > 59 || Number(iso[6] ?? 0) > 59
    || Number(iso[9] ?? 0) > 23 || Number(iso[10] ?? 0) > 59) return undefined;
  const milliseconds = Date.parse(value.toUpperCase());
  return Number.isFinite(milliseconds) ? milliseconds : undefined;
}

export function formatTimestamp(milliseconds: number, options: TimeDisplayOptions): { text: string; timezone: string } | undefined {
  const language = options.locale?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
  const zone = options.timezone && options.timezone !== 'system' ? options.timezone : 'system';
  const key = `${language}:${zone}`;
  try {
    let cached = formatters.get(key);
    if (!cached) {
      const formatter = new Intl.DateTimeFormat(language, {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: language === 'zh-CN' ? '2-digit' : 'numeric', minute: '2-digit', second: '2-digit',
        fractionalSecondDigits: 3, ...(zone !== 'system' ? { timeZone: zone } : {})
      });
      cached = { formatter, timezone: formatter.resolvedOptions().timeZone };
      formatters.set(key, cached);
    }
    return { text: cached.formatter.format(new Date(milliseconds)), timezone: cached.timezone };
  } catch { return undefined; }
}
