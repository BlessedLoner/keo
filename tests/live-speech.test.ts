import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { ModernSpeechEngine } from '../src/main/voice/modernSpeech';
import { PowerShellSpeechEngine, type SpeechEvent } from '../src/main/voice/wakeService';

/**
 * Manual check on Windows that both speech helpers compile and answer (no
 * microphone use: only the list of recognizers is asked for):
 * KEO_LIVE_SPEECH=1 npx vitest run tests/live-speech.test.ts
 */
for (const [name, make] of [
  ['modern', (dir: string) => new ModernSpeechEngine(dir)],
  ['classic', (dir: string) => new PowerShellSpeechEngine(dir)],
] as const) {
  it.runIf(process.env.KEO_LIVE_SPEECH === '1')(`${name} speech helper compiles and answers`, async () => {
    const dir = path.join(os.tmpdir(), `keo-live-speech-${name}`);
    const engine = make(dir);
    const events: SpeechEvent[] = [];
    await engine.start((e) => events.push(e), () => undefined);
    engine.send({ cmd: 'recognizers' });
    const until = Date.now() + 20000;
    while (!events.some((e) => e.event === 'recognizers' || e.event === 'error') && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    engine.stop();
    expect(events.find((e) => e.event === 'error')).toBeUndefined();
    expect(events.some((e) => e.event === 'recognizers')).toBe(true);
  }, 120000);
}
