import * as vscode from 'vscode';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export interface DocumentSource {
  readonly uri: string;
  readonly revision: string;
  readonly mode: 'text' | 'byte-stream';
  readonly capabilities: { dirtyContent: boolean; randomRead: boolean; streaming: boolean };
  stat(): Promise<{ byteLength?: number }>;
  readText?(): Promise<string>;
  readRange?(startByte: number, length: number): Promise<Uint8Array>;
  stream?(): AsyncIterable<Uint8Array>;
}

export class TextDocumentSource implements DocumentSource {
  readonly uri: string;
  readonly revision: string;
  readonly mode = 'text' as const;
  readonly capabilities = { dirtyContent: true, randomRead: false, streaming: false };
  private readonly text: string;
  constructor(document: vscode.TextDocument, text = document.getText()) {
    this.uri = document.uri.toString(); this.revision = `v${document.version}`; this.text = text;
  }
  async stat(): Promise<{ byteLength: number }> { return { byteLength: Buffer.byteLength(this.text) }; }
  async readText(): Promise<string> { return this.text; }
}

export class ByteStreamSource implements DocumentSource {
  readonly uri: string;
  readonly mode = 'byte-stream' as const;
  readonly capabilities = { dirtyContent: false, randomRead: true, streaming: true };
  readonly revision: string;
  private constructor(readonly path: string, readonly size: number, readonly mtimeMs: number, readonly dev: number, readonly ino: number) {
    this.uri = vscode.Uri.file(path).toString(); this.revision = createHash('sha256').update(`${path}:${size}:${mtimeMs}:${dev}:${ino}`).digest('hex').slice(0, 20);
  }
  static async create(uri: vscode.Uri): Promise<ByteStreamSource> {
    if (uri.scheme !== 'file') throw new Error('Streaming mode supports local and remote-host file URIs only.');
    const info = await stat(uri.fsPath); return new ByteStreamSource(uri.fsPath, info.size, info.mtimeMs, info.dev, info.ino);
  }
  async stat(): Promise<{ byteLength: number }> { return { byteLength: this.size }; }
  async readRange(startByte: number, length: number): Promise<Uint8Array> {
    const handle = await open(this.path, 'r');
    try { const buffer = new Uint8Array(length); const result = await handle.read(buffer, 0, length, startByte); return buffer.subarray(0, result.bytesRead); } finally { await handle.close(); }
  }
  async *stream(): AsyncIterable<Uint8Array> { for await (const chunk of createReadStream(this.path)) yield chunk as Buffer; }
}

export class WholeFileSource implements DocumentSource {
  readonly uri: string;
  readonly revision: string;
  readonly mode = 'text' as const;
  readonly capabilities = { dirtyContent: false, randomRead: false, streaming: false };
  constructor(private readonly resource: vscode.Uri, private readonly byteLength: number, revision: string) { this.uri = resource.toString(); this.revision = revision; }
  async stat(): Promise<{ byteLength: number }> { return { byteLength: this.byteLength }; }
  async readText(): Promise<string> { return new TextDecoder().decode(await vscode.workspace.fs.readFile(this.resource)); }
}

export async function wholeFileSource(uri: vscode.Uri): Promise<WholeFileSource> {
  const info = await vscode.workspace.fs.stat(uri);
  return new WholeFileSource(uri, info.size, `${info.size}:${info.mtime}`);
}
