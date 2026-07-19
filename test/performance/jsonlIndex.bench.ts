import { bench, describe } from 'vitest';
import { JsonlIndex } from '../../src/worker/jsonlIndex.js';
import { defaultSettings } from '../../src/shared/settings.js';

const records = Array.from({ length: 100_000 }, (_, index) => JSON.stringify({ id: index, level: index % 10 === 0 ? 'error' : 'info', timestamp: 1_700_000_000 + index, message: `record-${index}` })).join('\n');

describe('JSONL representative workload', () => {
  bench('index 100k records and read first page', async () => {
    const index = new JsonlIndex(defaultSettings); await index.openText(records); await index.page('default', 0, 100); await index.close();
  }, { iterations: 3, warmupIterations: 1, time: 0 });

  bench('filter and stable-sort 100k records', async () => {
    const index = new JsonlIndex(defaultSettings); await index.openText(records);
    await index.applyQuery('bench', { op: 'compare', path: '/level', cmp: 'eq', value: { kind: 'string', value: 'error' } }, { path: '/timestamp', direction: 'desc' }, () => false); await index.page('bench', 0, 100); await index.close();
  }, { iterations: 3, warmupIterations: 1, time: 0 });
});
