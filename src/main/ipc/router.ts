import type { IpcMainInvokeEvent } from 'electron';
import { INVOKE_PREFIX, invokeSchemas, type InvokeChannel, type IpcResult } from '../../shared/ipc';
import { formatZodError } from '../capabilities/registry';
import type { Logger } from '../logging/logger';
import { redactString } from '../logging/redact';
import { errorCode, errorMessage, KeoError } from '../util/errors';
import type { HandlerMap } from './handlers';
import { channelAllowed, type WindowRole } from './roles';

/** Minimal view of the sender used for validation (keeps this unit-testable). */
export interface SenderInfo {
  senderId: number;
  frameUrl: string | null;
  isMainFrame: boolean;
}

export interface SenderPolicy {
  /** Role of a Keo window by its WebContents id; null for anything else. */
  roleOf(webContentsId: number): WindowRole | null;
  /** Exact origin Keo's renderer is served from (app://keo or the dev server). */
  trustedOrigin: string;
}

/**
 * scheme://host[:port] for any URL. Node's URL.origin is "null" for
 * non-special schemes such as app://, so it cannot be used here.
 */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (!u.host) return null;
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch {
    return null;
  }
}

export function senderAllowed(info: SenderInfo, policy: SenderPolicy): { ok: boolean; reason?: string; role?: WindowRole } {
  const role = policy.roleOf(info.senderId);
  if (!role) return { ok: false, reason: 'unknown_webcontents' };
  if (!info.isMainFrame) return { ok: false, reason: 'subframe' };
  if (!info.frameUrl) return { ok: false, reason: 'no_frame_url' };
  const origin = originOf(info.frameUrl);
  if (!origin) return { ok: false, reason: 'bad_url' };
  if (origin !== policy.trustedOrigin) return { ok: false, reason: 'untrusted_origin' };
  return { ok: true, role };
}

/**
 * Validates sender + input for every invoke, then calls the handler. Errors
 * are converted to a safe {code, message} shape; stacks never cross IPC.
 */
export async function dispatch(
  channel: string,
  rawInput: unknown,
  sender: SenderInfo,
  handlers: HandlerMap,
  policy: SenderPolicy,
  log: Logger,
): Promise<IpcResult<unknown>> {
  const allowed = senderAllowed(sender, policy);
  if (!allowed.ok) {
    log.warn('ipc.sender_rejected', { channel: channel.slice(0, 60), reason: allowed.reason });
    return { ok: false, error: { code: 'forbidden', message: 'Request rejected.' } };
  }
  if (!Object.prototype.hasOwnProperty.call(invokeSchemas, channel)) {
    log.warn('ipc.unknown_channel', { channel: channel.slice(0, 60) });
    return { ok: false, error: { code: 'unknown_channel', message: 'Unknown request.' } };
  }
  const ch = channel as InvokeChannel;
  if (!channelAllowed(allowed.role as WindowRole, ch)) {
    log.warn('ipc.role_rejected', { channel: ch, role: allowed.role });
    return { ok: false, error: { code: 'forbidden', message: 'This window cannot do that.' } };
  }
  const parsed = invokeSchemas[ch].safeParse(rawInput ?? {});
  if (!parsed.success) {
    log.warn('ipc.invalid_input', { channel: ch, issues: parsed.error.issues.length });
    return { ok: false, error: { code: 'invalid_input', message: formatZodError(parsed.error) } };
  }
  try {
    const handler = handlers[ch] as (i: unknown) => unknown;
    const value = await handler(parsed.data);
    return { ok: true, value };
  } catch (err) {
    const code = err instanceof KeoError ? err.code : errorCode(err);
    if (!(err instanceof KeoError)) log.error('ipc.handler_error', { channel: ch, error: errorMessage(err) });
    return { ok: false, error: { code, message: redactString(err instanceof KeoError ? err.message : 'Internal error. See Diagnostics.', 600) } };
  }
}

export function registerIpc(
  ipcMain: { handle(channel: string, fn: (e: IpcMainInvokeEvent, input: unknown) => unknown): void },
  handlers: HandlerMap,
  policy: SenderPolicy,
  log: Logger,
): void {
  for (const ch of Object.keys(invokeSchemas)) {
    ipcMain.handle(INVOKE_PREFIX + ch, (e, input) =>
      dispatch(
        ch,
        input,
        { senderId: e.sender.id, frameUrl: e.senderFrame?.url ?? null, isMainFrame: !!e.senderFrame && e.senderFrame === e.sender.mainFrame },
        handlers,
        policy,
        log,
      ),
    );
  }
}
