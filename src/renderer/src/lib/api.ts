import type { InvokeChannel, InvokeInput, InvokeOutputs, PushChannel } from '@shared/ipc';
import type { PushPayloads } from '../../../preload/api';

/** Typed access to the preload bridge. The renderer has no other privileged API. */
export class KeoRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'KeoRequestError';
  }
}

export async function invoke<C extends InvokeChannel>(channel: C, input?: InvokeInput<C>): Promise<InvokeOutputs[C]> {
  const res = await window.keo.invoke(channel, input);
  if (res.ok) return res.value;
  throw new KeoRequestError(res.error.code, res.error.message);
}

export function subscribe<P extends PushChannel>(channel: P, fn: (payload: PushPayloads[P]) => void): () => void {
  return window.keo.on(channel, fn);
}

export function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
