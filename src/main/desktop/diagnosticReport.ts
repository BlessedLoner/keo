import os from 'node:os';
import type { SelfTestResult } from '../../shared/domain';
import type { Settings } from '../../shared/settings';

export interface DiagnosticInput {
  version: string;
  packaged: boolean;
  electron: string;
  settings: Settings;
  /** Provider ids that have a key stored (never the keys). */
  providersWithKeys: string[];
  speech: { kind: string | null; fallbackReason: string | null; wakeStatus: string };
  displays: Array<{ width: number; height: number; scale: number; primary: boolean }>;
  selfTest: { at: string; report: SelfTestResult } | null;
  /** Layout facts from "Check WhatsApp" (no names or messages). */
  whatsapp?: { at: string; ok: boolean; lines: string[] } | null;
  /** Recent failed task steps: capability id and error code only. */
  recentFailures: Array<{ capabilityId: string; code: string }>;
}

/**
 * A plain-text report the user can paste when asking for help. It holds
 * settings switches, versions and error codes only — no API keys, chats,
 * window titles, app names, file paths or anything typed.
 */
export function diagnosticReport(d: DiagnosticInput): string {
  const s = d.settings;
  const p = s.permissions;
  const on = (b: boolean) => (b ? 'on' : 'off');
  const lines = [
    `Keo ${d.version}${d.packaged ? '' : ' (from source)'} · Electron ${d.electron}`,
    `Windows ${os.release()} ${os.arch()} · ${os.cpus().length} CPUs · ${Math.round(os.totalmem() / 2 ** 30)} GB RAM · locale ${Intl.DateTimeFormat().resolvedOptions().locale}`,
    `Displays: ${d.displays.map((x) => `${x.width}×${x.height} @${Math.round(x.scale * 100)}%${x.primary ? ' (main)' : ''}`).join(', ') || 'unknown'}`,
    `Provider: ${s.activeProvider ?? 'none'} · keys stored for: ${d.providersWithKeys.join(', ') || 'none'}`,
    `Access: observation ${on(p.observationEnabled)}, control ${on(p.desktopControlEnabled)}, launch ${on(p.launchEnabled)}, ${p.allowedApps.length} allowed apps, screenshots to ${(Object.keys(p.visionExport) as Array<keyof typeof p.visionExport>).filter((k) => p.visionExport[k]).join('/') || 'nobody'}`,
    `Approvals: ${s.autonomy.level}`,
    `Voice: wake ${on(s.wake.enabled)} (${d.speech.wakeStatus}), engine ${s.wake.engine} → ${d.speech.kind ?? 'not started'}${d.speech.fallbackReason ? ` (fallback: ${d.speech.fallbackReason})` : ''}, commands via ${s.wake.commandRecognizer}`,
  ];
  if (d.selfTest) {
    const r = d.selfTest.report;
    lines.push(`Self-test ${d.selfTest.at}: ${r.ok ? 'PASSED' : 'FAILED'}`);
    for (const st of r.steps) lines.push(`  ${st.ok ? '✓' : '✗'} ${st.title} (${st.ms} ms)${st.ok ? '' : ` — ${st.detail}`}`);
  } else lines.push('Self-test: not run');
  if (d.whatsapp) lines.push(`WhatsApp check ${d.whatsapp.at}: ${d.whatsapp.ok ? 'OK' : 'PROBLEM'}`, ...d.whatsapp.lines.map((l) => `  ${l}`));
  if (d.recentFailures.length) lines.push(`Recent errors: ${d.recentFailures.map((f) => `${f.capabilityId}:${f.code}`).join(', ')}`);
  return lines.join('\n');
}
