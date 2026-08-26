const zh = {
  timezoneUnknown: '时区未知', expand: '查看', loading: '加载中…', loadMore: '加载更多（{loaded}/{total}）',
  searchJson: '按值搜索，或输入 JMESPath，如 users[?active].name', searchJsonl: "按值筛选行，或输入 JMESPath，如 level == 'error'", format: '格式化', repair: '修复', export: '导出', source: '查看源码', originalOrder: '按原始行号排序',
  records: '{count} 条记录', errors: '{count} 个错误', indexed: '已索引 {count} 条', queryResult: '搜索 / JMESPath 查询结果', queryResultAria: '查询结果',
  structure: '文档结构', collapseAll: '全部收起', expandAll: '全部展开', invalidJson: '无法解析 JSON', location: '第 {line}:{column} 行',
  sourceLine: '在源码中定位此行', copied: '已复制到剪贴板',
  copyKey: '复制属性名', copyValue: '复制值', copyCell: '复制单元内容', copyJson: '复制 JSON', copyPath: '复制 JSONPath', openTemp: '在临时 Tab 打开', openTempHint: '在临时 Tab 打开（按住 Alt/Option 在当前 Tab 打开）', openCurrent: '在当前 Tab 打开', openRowTemp: '临时 Tab 打开（整行）', openRowCurrent: '当前 Tab 打开（整行）', openCellTemp: '临时 Tab 打开（单元格）', openCellCurrent: '当前 Tab 打开（单元格）',
  fullContent: '完整内容', searchContent: '在完整内容中搜索', closeSearch: '关闭搜索', previousMatch: '上一个匹配项', nextMatch: '下一个匹配项', matchCount: '{current}/{total}', copyContent: '复制内容', copySelected: '复制选中内容', openSelectedTemp: '临时 Tab 打开', line: '第 {line} 行', copyLine: '复制整行', tempTab: '临时 Tab 打开', currentTab: '当前 Tab 打开', preparing: '正在准备预览…', expression: '表达式：{value}', results: '{count} 条结果'
} as const;

const en: Record<keyof typeof zh, string> = {
  timezoneUnknown: 'Unknown timezone', expand: 'View', loading: 'Loading…', loadMore: 'Load more ({loaded}/{total})',
  searchJson: 'Search values or enter JMESPath, e.g. users[?active].name', searchJsonl: "Filter rows by value or enter JMESPath, e.g. level == 'error'", format: 'Format', repair: 'Repair', export: 'Export', source: 'View Source', originalOrder: 'Sort by original line number',
  records: '{count} records', errors: '{count} errors', indexed: 'Indexed {count}', queryResult: 'Search / JMESPath result', queryResultAria: 'Query result',
  structure: 'Document structure', collapseAll: 'Collapse All', expandAll: 'Expand All', invalidJson: 'Unable to parse JSON', location: 'Line {line}:{column}',
  sourceLine: 'Reveal this line in source', copied: 'Copied to clipboard',
  copyKey: 'Copy Property Name', copyValue: 'Copy Value', copyCell: 'Copy Cell', copyJson: 'Copy JSON', copyPath: 'Copy JSONPath', openTemp: 'Open in Temporary Tab', openTempHint: 'Open in Temporary Tab (hold Alt/Option to open in Current Tab)', openCurrent: 'Open in Current Tab', openRowTemp: 'Open in Temporary Tab (Row)', openRowCurrent: 'Open in Current Tab (Row)', openCellTemp: 'Open in Temporary Tab (Cell)', openCellCurrent: 'Open in Current Tab (Cell)',
  fullContent: 'Full Content', searchContent: 'Search full content', closeSearch: 'Close search', previousMatch: 'Previous match', nextMatch: 'Next match', matchCount: '{current}/{total}', copyContent: 'Copy Content', copySelected: 'Copy Selected Content', openSelectedTemp: 'Open Selection in Temporary Tab', line: 'Line {line}', copyLine: 'Copy Row', tempTab: 'Temporary Tab', currentTab: 'Current Tab', preparing: 'Preparing preview…', expression: 'Expression: {value}', results: '{count} results'
};

let messages: Record<keyof typeof zh, string> = en;

export function setLocale(locale: string | undefined): void { messages = locale?.toLowerCase().startsWith('zh') ? zh : en; }
export function tr(key: keyof typeof zh, values: Record<string, string | number> = {}): string {
  return Object.entries(values).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), messages[key]);
}
