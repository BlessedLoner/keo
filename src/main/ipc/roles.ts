import type { InvokeChannel } from '../../shared/ipc';

/** Each Keo window gets only the IPC channels its job needs. */
export type WindowRole = 'main' | 'command' | 'companion' | 'results' | 'pencil';

const COMPANION: ReadonlySet<InvokeChannel> = new Set<InvokeChannel>([
  'presence:get',
  'presence:stopAll',
  'tasks:cancel',
  'app:quit',
  'presence:openMain',
  'companion:setInteractive',
  'companion:drag',
  'companion:hide',
  'commandBar:show',
  'pencil:start',
  'wake:status',
  'wake:setMuted',
  'grants:list',
  'grants:revokeAll',
  'livechat:list',
  'livechat:stop',
  'voice:modeStart',
  'voice:modeStop',
  'livechat:sendNow',
  'livechat:discardDraft',
  'settings:get',
]);

const COMMAND: ReadonlySet<InvokeChannel> = new Set<InvokeChannel>([
  ...COMPANION,
  'presence:report',
  'commandBar:hide',
  'commandBar:conversation',
  'chat:send',
  'chat:cancel',
  'chat:active',
  'conversations:messages',
  'tasks:list',
  'tasks:get',
  'tasks:approveStep',
  'tasks:denyStep',
  'tasks:cancel',
  'grants:approveAndGrant',
  'livechat:answer',
  'livechat:pause',
  'livechat:resume',
  'grants:revoke',
  'wake:listenNow',
  'wake:cancelListen',
  'voice:transcribe',
  'voice:speak',
  'providers:list',
  'app:info',
]);

/** The research results window: show results, save or send them, open sources. Nothing else. */
const RESULTS: ReadonlySet<InvokeChannel> = new Set<InvokeChannel>(['results:get', 'results:save', 'results:send', 'results:openFolder', 'results:close', 'app:openUrl', 'presence:openMain', 'settings:get']);

/** Keo's pencil overlay: its own screenshot, sending the marked area, listening. Nothing else. */
const PENCIL: ReadonlySet<InvokeChannel> = new Set<InvokeChannel>(['pencil:context', 'pencil:submit', 'pencil:cancel', 'pencil:allowExport', 'pencil:listen', 'settings:get']);

export function channelAllowed(role: WindowRole, channel: InvokeChannel): boolean {
  if (role === 'main') return true;
  if (role === 'results') return RESULTS.has(channel);
  if (role === 'pencil') return PENCIL.has(channel);
  return (role === 'command' ? COMMAND : COMPANION).has(channel);
}
