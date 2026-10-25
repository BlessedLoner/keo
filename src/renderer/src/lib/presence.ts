import { useEffect, useState } from 'react';
import type { Presence } from '@shared/domain';
import type { EmblemState } from '../components/KeoEmblem';
import { invoke, subscribe } from './api';
import { levelBus } from './levelBus';
import { voice } from './voice';

/** The latest voice level relayed from the main window (Keo's bar and Keo mode read it every frame). */
let relayed = 0;
let relayedAt = 0;
export function relayedLevel(): number {
  // A level older than half a second is stale (speech ended, window closed).
  return performance.now() - relayedAt > 500 ? 0 : relayed;
}
/** Starts listening for the relayed level in this window (once). */
let relayOn = false;
export function listenRelayedLevel(): void {
  if (relayOn) return;
  relayOn = true;
  subscribe('presence:level', (v) => {
    relayed = v.level;
    relayedAt = performance.now();
  });
}

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
  // The real level, about 15 times a second while this window records or plays speech, for
  // Keo's bar and Keo mode (other windows have no access to this window's audio).
  useEffect(() => {
    let sent = 0;
    const t = window.setInterval(() => {
      const s = voice.get();
      const v = s.speaking || s.recording ? levelBus.get() : 0;
      if (v === 0 && sent === 0) return;
      sent = v;
      void invoke('voice:level', { level: Math.round(v * 1000) / 1000, source: v ? levelBus.source() : null }).catch(() => undefined);
    }, 66);
    return () => window.clearInterval(t);
  }, []);
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
