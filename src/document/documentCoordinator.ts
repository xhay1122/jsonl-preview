import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { DocumentSource } from './documentSource.js';
import type { WorkerClient } from './workerClient.js';
import type { PreviewSettings } from '../shared/settings.js';
import type { SessionSummary } from '../shared/types.js';

export interface SessionHandle { id: string; key: string; revision: string; summary: SessionSummary }
interface SharedSession extends SessionHandle { refs: number }

export class DocumentCoordinator implements vscode.Disposable {
  private readonly sessions = new Map<string, SharedSession>();
  private readonly opening = new Map<string, Promise<SharedSession>>();
  private readonly restartSubscription: vscode.Disposable;
  private disposed = false;
  constructor(private readonly client: WorkerClient) { this.restartSubscription = client.onDidRestart(() => { this.sessions.clear(); this.opening.clear(); }); }

  async acquire(source: DocumentSource, kind: 'json' | 'jsonl', settings: PreviewSettings): Promise<SessionHandle> {
    if (this.disposed) throw new Error('Document coordinator is disposed.');
    const key = `${source.uri}:${source.mode}:${source.revision}:${kind}:${createHash(JSON.stringify(settings))}`;
    const existing = this.sessions.get(key);
    if (existing) { existing.refs++; return existing; }
    let pending = this.opening.get(key);
    if (!pending) {
      pending = this.open(source, kind, settings, key);
      this.opening.set(key, pending);
      void pending.finally(() => { if (this.opening.get(key) === pending) this.opening.delete(key); }).catch(() => undefined);
    }
    const session = await pending;
    session.refs++;
    return session;
  }

  private async open(source: DocumentSource, kind: 'json' | 'jsonl', settings: PreviewSettings, key: string): Promise<SharedSession> {
    const size = await source.stat();
    if (source.mode === 'text' && size.byteLength !== undefined && size.byteLength > settings.normalModeMaxBytes) throw new Error(`The file exceeds the ${Math.floor(settings.normalModeMaxBytes / 1024 / 1024)} MB normal-mode limit.`);
    const id = randomUUID();
    let data;
    if (source.mode === 'byte-stream') {
      const path = 'path' in source && typeof source.path === 'string' ? source.path : undefined;
      if (!path) throw new Error('This streaming source cannot be opened directly by the worker.');
      const expectedSize = 'size' in source && typeof source.size === 'number' ? source.size : undefined;
      const expectedMtimeMs = 'mtimeMs' in source && typeof source.mtimeMs === 'number' ? source.mtimeMs : undefined;
      const expectedDev = 'dev' in source && typeof source.dev === 'number' ? source.dev : undefined;
      const expectedIno = 'ino' in source && typeof source.ino === 'number' ? source.ino : undefined;
      if (expectedSize === undefined || expectedMtimeMs === undefined || expectedDev === undefined || expectedIno === undefined) throw new Error('The streaming source does not provide a stable file signature.');
      data = await this.client.request({ type: 'session/openFile', sessionId: id, revision: source.revision, path, expectedSize, expectedMtimeMs, expectedDev, expectedIno, settings }, 120_000);
    } else {
      const text = await source.readText!();
      const chunks: string[] = [];
      for (let offset = 0; offset < text.length; offset += 256 * 1024) chunks.push(text.slice(offset, offset + 256 * 1024));
      data = await this.client.request({ type: 'session/openText', sessionId: id, revision: source.revision, kind, chunks, settings }, 120_000);
    }
    const session: SharedSession = { id, key, revision: source.revision, summary: data as SessionSummary, refs: 0 };
    if (this.disposed) { void this.client.request({ type: 'session/dispose', sessionId: id }).catch(() => undefined); throw new Error('Document coordinator is disposed.'); }
    this.sessions.set(key, session);
    return session;
  }

  async release(handle: SessionHandle): Promise<void> {
    const session = this.sessions.get(handle.key); if (!session || session.id !== handle.id || --session.refs > 0) return;
    this.sessions.delete(handle.key);
    try { await this.client.request({ type: 'session/dispose', sessionId: session.id }); } catch { /* worker may already be gone */ }
  }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.restartSubscription.dispose(); for (const session of this.sessions.values()) void this.client.request({ type: 'session/dispose', sessionId: session.id }).catch(() => undefined); this.sessions.clear(); this.opening.clear(); }
}

function createHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(36);
}
