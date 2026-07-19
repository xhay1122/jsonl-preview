import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { WorkerData, WorkerProgress, WorkerRequest, WorkerResponse } from '../worker/protocol.js';
import { PreviewError } from '../shared/errors.js';

type RequestInput = WorkerRequest extends infer Request ? Request extends WorkerRequest ? Omit<Request, 'requestId'> : never : never;
interface Pending { resolve(data: WorkerData): void; reject(error: Error): void; timer: NodeJS.Timeout }

export class WorkerClient implements vscode.Disposable {
  private worker: Worker;
  private readonly pending = new Map<string, Pending>();
  private readonly progressEmitter = new vscode.EventEmitter<WorkerProgress>();
  readonly onProgress = this.progressEmitter.event;
  private readonly restartEmitter = new vscode.EventEmitter<Error>();
  readonly onDidRestart = this.restartEmitter.event;
  private disposed = false;

  constructor(private readonly workerPath: string) { this.worker = this.createWorker(); }
  private createWorker(): Worker {
    const worker = new Worker(this.workerPath);
    worker.on('message', (message: WorkerResponse | WorkerProgress) => {
      if (!('requestId' in message)) { this.progressEmitter.fire(message); return; }
      const pending = this.pending.get(message.requestId); if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.requestId);
      if (message.ok) pending.resolve(message.data); else pending.reject(new PreviewError(message.code, message.message));
    });
    worker.on('error', (error) => this.restart(error));
    worker.on('exit', (code) => { if (code !== 0) this.restart(new Error(`Preview worker exited with code ${code}.`)); });
    return worker;
  }
  private restart(error: Error): void {
    if (this.disposed) return;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.worker.removeAllListeners(); this.worker = this.createWorker(); this.restartEmitter.fire(error);
  }
  request(input: RequestInput, timeoutMs = 30_000): Promise<WorkerData> {
    return this.requestWithId(input, timeoutMs).promise;
  }
  requestWithId(input: RequestInput, timeoutMs = 30_000): { requestId: string; promise: Promise<WorkerData> } {
    const requestId = randomUUID();
    const promise = new Promise<WorkerData>((resolve, reject) => {
      if (this.disposed) { reject(new PreviewError('DISPOSED', 'Preview worker is stopped.')); return; }
      const timer = setTimeout(() => { this.pending.delete(requestId); if (!this.disposed) this.worker.postMessage({ type: 'request/cancel', requestId: randomUUID(), sessionId: input.sessionId, targetRequestId: requestId }); reject(new PreviewError('TIMEOUT', 'Preview operation timed out.')); }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.worker.postMessage({ ...input, requestId } satisfies WorkerRequest);
    });
    return { requestId, promise };
  }
  async cancel(sessionId: string, targetRequestId: string): Promise<void> { await this.request({ type: 'request/cancel', sessionId, targetRequestId }); }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.worker.removeAllListeners(); void this.worker.terminate();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new PreviewError('DISPOSED', 'Preview worker is stopped.')); }
    this.pending.clear(); this.progressEmitter.dispose(); this.restartEmitter.dispose();
  }
}
