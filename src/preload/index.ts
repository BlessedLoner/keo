import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { INVOKE_CHANNELS, INVOKE_PREFIX, pushChannels } from '../shared/channels';
import type { KeoBridge } from './api';

/**
 * Narrow, typed bridge. The renderer can only:
 *  - invoke one of the allow-listed channels (main re-validates everything), and
 *  - subscribe to allow-listed push channels.
 * No ipcRenderer, Node, filesystem or process objects are exposed.
 */
const invokeAllowed = new Set<string>(INVOKE_CHANNELS);
const pushAllowed = new Set<string>(pushChannels);

const bridge: KeoBridge = {
  // Returns the structured {ok, value | error} result: custom Error properties
  // (like `code`) do not survive the context bridge, plain data does.
  async invoke(channel, input) {
    if (typeof channel !== 'string' || !invokeAllowed.has(channel)) {
      return { ok: false, error: { code: 'unknown_channel', message: 'Channel not allowed.' } };
    }
    return (await ipcRenderer.invoke(INVOKE_PREFIX + channel, input ?? {})) as never;
  },
  on(channel, listener) {
    if (!pushAllowed.has(channel)) throw new Error(`Event not allowed: ${String(channel)}`);
    const wrapped = (_e: IpcRendererEvent, payload: unknown) => listener(payload as never);
    ipcRenderer.on(channel, wrapped);
    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  },
};

contextBridge.exposeInMainWorld('keo', Object.freeze(bridge));
