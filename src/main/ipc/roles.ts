import type { InvokeChannel } from '../../shared/ipc';

/** Each Keo window gets only the IPC channels its job needs. */
export type WindowRole = 'main' | 'command' | 'companion';

const COMPANION: ReadonlySet<InvokeChannel> = new Set<InvokeChannel>([
  'presence:get',
  'presence:stopAll',
  'app:quit',
  'presence:openMain',
  'companion:setInteractive',
  'companion:drag',
  'companion:hide',
  'commandBar:show',
  'wake:status',
  'wake:setMuted',
  'grants:list',
  'grants:revokeAll',
  'livechat:list',
  'livechat:stop',
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

export function channelAllowed(role: WindowRole, channel: InvokeChannel): boolean {
  if (role === 'main') return true;
  return (role === 'command' ? COMMAND : COMPANION).has(channel);
}
