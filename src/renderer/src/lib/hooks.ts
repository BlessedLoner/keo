import { useCallback, useEffect, useRef, useState } from 'react';
import type { InvokeChannel, InvokeInput, InvokeOutputs, PushChannel } from '@shared/ipc';
import { errText, invoke, subscribe } from './api';

export interface Query<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

/**
 * Loads an IPC query and re-loads it when any of the given push channels fire.
 * Keeps the last good data while refreshing so the UI does not flicker.
 */
export function useInvoke<C extends InvokeChannel>(
  channel: C,
  input: InvokeInput<C> | undefined,
  opts: { refreshOn?: PushChannel[]; enabled?: boolean; pollMs?: number } = {},
): Query<InvokeOutputs[C]> {
  const [data, setData] = useState<InvokeOutputs[C]>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const key = JSON.stringify(input ?? {});
  const enabled = opts.enabled ?? true;
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const my = ++seq.current;
    setLoading(true);
    try {
      const v = await invoke(channel, JSON.parse(key) as InvokeInput<C>);
      if (my === seq.current) {
        setData(v);
        setError(null);
      }
    } catch (e) {
      if (my === seq.current) setError(errText(e));
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [channel, key, enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const refreshOn = (opts.refreshOn ?? []).join(',');
  useEffect(() => {
    if (!refreshOn) return;
    let timer: number | null = null;
    const debounced = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => void refresh(), 60);
    };
    const offs = refreshOn.split(',').map((ch) => subscribe(ch as PushChannel, debounced));
    return () => {
      offs.forEach((o) => o());
      if (timer) window.clearTimeout(timer);
    };
  }, [refreshOn, refresh]);

  useEffect(() => {
    if (!opts.pollMs) return;
    const t = window.setInterval(() => void refresh(), opts.pollMs);
    return () => window.clearInterval(t);
  }, [opts.pollMs, refresh]);

  return { data, error, loading, refresh };
}

/** Runs an action, tracking busy state and reporting errors through `onError`. */
export function useAction<A extends unknown[], R>(fn: (...a: A) => Promise<R>, onError: (msg: string) => void) {
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async (...a: A): Promise<R | undefined> => {
      setBusy(true);
      try {
        return await fn(...a);
      } catch (e) {
        onError(errText(e));
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [fn, onError],
  );
  return { run, busy };
}
