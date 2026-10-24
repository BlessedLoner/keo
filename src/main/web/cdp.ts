import type { Readable, Writable } from 'node:stream';

/**
 * The Chrome DevTools protocol over the browser's own pipe (`--remote-debugging-pipe`):
 * file descriptor 3 carries commands to the browser, 4 carries its replies, each a JSON
 * message ended by a NUL byte. No TCP port is ever opened, so nothing else on the computer
 * or the network can reach the browser's controls.
 */
export class CdpPipe {
  private nextId = 1;
  private buffer = '';
  private readonly pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void; method: string }>();
  private readonly listeners = new Set<(method: string, params: Record<string, unknown>, sessionId: string | undefined) => void>();
  closed = false;
  private readonly closeListeners = new Set<() => void>();

  constructor(
    private readonly out: Writable,
    input: Readable,
  ) {
    input.setEncoding('utf8');
    input.on('data', (chunk: string) => this.receive(chunk));
    input.on('close', () => this.close());
    input.on('error', () => this.close());
    out.on('error', () => this.close());
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let end: number;
    while ((end = this.buffer.indexOf('\0')) >= 0) {
      const raw = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      let msg: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
      try {
        msg = JSON.parse(raw);
      } catch {
        continue;
      }
      if (typeof msg.id === 'number') {
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new CdpError(p.method, msg.error.message ?? 'error'));
        else p.resolve(msg.result ?? {});
      } else if (msg.method) {
        for (const l of this.listeners) l(msg.method, msg.params ?? {}, msg.sessionId);
      }
    }
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.closed) return Promise.reject(new CdpError(method, 'The browser window is closed.'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, method });
      this.out.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });
  }

  on(fn: (method: string, params: Record<string, unknown>, sessionId: string | undefined) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onClose(fn: () => void): void {
    this.closeListeners.add(fn);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new CdpError(p.method, 'The browser window is closed.'));
    this.pending.clear();
    for (const l of this.closeListeners) l();
  }
}

export class CdpError extends Error {
  constructor(
    readonly method: string,
    message: string,
  ) {
    super(message);
  }
}
