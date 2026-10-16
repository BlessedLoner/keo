/**
 * Structured application error. `code` is stable and safe to show; `message`
 * must never contain secrets (it is redacted again before crossing IPC/logs).
 */
export class KeoError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'KeoError';
    this.code = code;
    if (details) this.details = details;
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'Unknown error';
}

export function errorCode(err: unknown): string {
  if (err instanceof KeoError) return err.code;
  return 'internal';
}

export function nowIso(): string {
  return new Date().toISOString();
}
