import fs from 'node:fs';
import path from 'node:path';
import type { LogEvent } from '../../shared/domain';
import { redact } from './redact';

type Level = LogEvent['level'];

/**
 * Structured JSONL logger. Every `data` payload passes through `redact`, which
 * drops content-bearing keys (prompt, content, text, image, audio, apiKey, ...)
 * and masks credential patterns, so ordinary logs never contain conversations,
 * screenshots or secrets.
 */
export class Logger {
  private readonly ring: LogEvent[] = [];
  private stream: fs.WriteStream | null = null;
  private bytesWritten = 0;
  private readonly maxBytes = 5 * 1024 * 1024;
  private readonly keepFiles = 5;

  constructor(
    private readonly dir: string | null,
    private readonly echo = false,
  ) {
    if (dir) {
      fs.mkdirSync(dir, { recursive: true });
      this.open();
    }
  }

  private get file(): string {
    return path.join(this.dir as string, 'keo.log');
  }

  private open(): void {
    try {
      this.bytesWritten = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
      this.stream = fs.createWriteStream(this.file, { flags: 'a' });
      this.stream.on('error', () => {
        this.stream = null;
      });
    } catch {
      this.stream = null;
    }
  }

  private rotate(): void {
    if (!this.dir) return;
    this.stream?.end();
    this.stream = null;
    try {
      for (let i = this.keepFiles - 1; i >= 1; i--) {
        const from = path.join(this.dir, `keo.${i}.log`);
        const to = path.join(this.dir, `keo.${i + 1}.log`);
        if (fs.existsSync(from)) fs.renameSync(from, to);
      }
      if (fs.existsSync(this.file)) fs.renameSync(this.file, path.join(this.dir, 'keo.1.log'));
    } catch {
      /* rotation is best effort; logging continues in the current file */
    }
    this.open();
  }

  log(level: Level, event: string, data?: Record<string, unknown>, correlationId?: string): void {
    const entry: LogEvent = { ts: new Date().toISOString(), level, event };
    if (correlationId) entry.correlationId = correlationId;
    if (data) entry.data = redact(data) as Record<string, unknown>;
    this.ring.push(entry);
    if (this.ring.length > 1000) this.ring.shift();
    const line = `${JSON.stringify(entry)}\n`;
    if (this.stream) {
      this.stream.write(line);
      this.bytesWritten += Buffer.byteLength(line);
      if (this.bytesWritten > this.maxBytes) this.rotate();
    }
    if (this.echo) process.stdout.write(line);
  }

  debug(event: string, data?: Record<string, unknown>, cid?: string): void {
    this.log('debug', event, data, cid);
  }
  info(event: string, data?: Record<string, unknown>, cid?: string): void {
    this.log('info', event, data, cid);
  }
  warn(event: string, data?: Record<string, unknown>, cid?: string): void {
    this.log('warn', event, data, cid);
  }
  error(event: string, data?: Record<string, unknown>, cid?: string): void {
    this.log('error', event, data, cid);
  }

  recent(limit: number): LogEvent[] {
    return this.ring.slice(-limit).reverse();
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.stream) return resolve();
      this.stream.end(() => resolve());
      this.stream = null;
    });
  }
}
