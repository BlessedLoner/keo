import { useEffect, useState } from 'react';
import type { Presence } from '@shared/domain';
import type { EmblemState } from '../components/KeoEmblem';
import { invoke, subscribe } from './api';
import { voice } from './voice';

/** Live presence from the main process (the only source of agent state). */
export function usePresence(): Presence | null {
  const [p, setP] = useState<Presence | null>(null);
  useEffect(() => {
    let live = true;
    void invoke('presence:get').then((v) => live && setP(v), () => undefined);
    const off = subscribe('presence:changed', (v) => setP(v));
    return () => {
      live = false;
      off();
    };
  }, []);
  return p;
}

export function emblemFor(p: Presence | null): EmblemState {
  return p ? p.state : 'idle';
}

/** Reports real audio activity of this window (playback, recording) to the main process. */
export function useVoiceReporting(): void {
  useEffect(() => {
    let last = '';
    const report = () => {
      const s = voice.get();
      const v = { speaking: s.speaking, recording: s.recording, transcribing: s.transcribing };
      const key = JSON.stringify(v);
      if (key === last) return;
      last = key;
      void invoke('presence:report', v).catch(() => undefined);
    };
    report();
    const off = voice.subscribe(report);
    const offCmd = subscribe('presence:command', (c) => {
      if (c.type === 'stop_speaking') voice.stopSpeaking();
    });
    return () => {
      off();
      offCmd();
    };
  }, []);
}
