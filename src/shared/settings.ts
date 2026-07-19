export interface PreviewSettings {
  indent: number;
  allowComments: boolean;
  allowTrailingComma: boolean;
  maxAutoExpandDepth: number;
  pageSize: number;
  schemaSampleSize: number;
  ignoreEmptyLines: boolean;
  maxLineBytes: number;
  maxSortableRows: number;
  queryCacheBytes: number;
  normalModeMaxBytes: number;
  timezone: string;
}

export const defaultSettings: PreviewSettings = {
  indent: 2,
  allowComments: false,
  allowTrailingComma: false,
  maxAutoExpandDepth: 10,
  pageSize: 1000,
  schemaSampleSize: 1000,
  ignoreEmptyLines: true,
  maxLineBytes: 5 * 1024 * 1024,
  maxSortableRows: 1_000_000,
  queryCacheBytes: 128 * 1024 * 1024,
  normalModeMaxBytes: 100 * 1024 * 1024,
  timezone: 'system'
};
