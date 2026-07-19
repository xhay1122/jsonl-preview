export class PreviewError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
