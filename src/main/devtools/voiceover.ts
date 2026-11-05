import fs from 'node:fs';
import path from 'node:path';
import type { Services } from '../services';

/**
 * Development only (KEO_VOICEOVER=<folder>): lines read in the user's own voice, with Keo's own-voice
 * feature (Chatterbox, through the signed-in user's Keo Cloud account or their own fal.ai key). The
 * folder holds lines.json ([{ id, text }]) and my-voice-sample.wav; each line is saved as <id>.wav.
 * Runs on the user's own profile at their request: nothing else in it is touched.
 */
export async function runVoiceover(s: Services, dir: string): Promise<Record<string, unknown>> {
  const lines = JSON.parse(fs.readFileSync(path.join(dir, 'lines.json'), 'utf8')) as Array<{ id: string; text: string }>;
  const sample = fs.readFileSync(path.join(dir, 'my-voice-sample.wav'));
  const route = await s.aiVideo.route();
  if (!route) throw new Error('Not signed in to Keo (and no own fal.ai key): sign in to Keo first.');
  const before = route.kind === 'keo' ? await s.account.studioCredits().catch(() => null) : null;
  const made: string[] = [];
  for (const l of lines) {
    const r = await s.aiVideo.speak({ sample, sampleType: 'audio/wav', text: l.text }, new AbortController().signal);
    fs.copyFileSync(r.file, path.join(dir, `${l.id}.wav`));
    made.push(l.id);
  }
  const after = route.kind === 'keo' ? await s.account.studioCredits().catch(() => null) : null;
  return { via: route.kind, lines: made.length, creditsBefore: before?.total ?? null, creditsAfter: after?.total ?? null };
}
