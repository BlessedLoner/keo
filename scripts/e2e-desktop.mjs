// Physical desktop end-to-end check (development only).
// Starts Keo against a DISPOSABLE profile and drives a disposable WhatsApp-like
// test app (tests/fixtures/fake-whatsapp) through the REAL Win32 / UI Automation
// helper, capability registry, orchestrator and approvals. It moves windows and
// clicks inside the test app only; no real accounts or messages are involved.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electron = require('electron');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'keo-e2e-'));
const out = path.join(profile, 'e2e-desktop.json');
const env = { ...process.env, KEO_E2E_DESKTOP: '1', KEO_ENABLE_TEST_PROVIDER: '1', KEO_USER_DATA_DIR: profile, KEO_E2E_OUT: out };
delete env.ELECTRON_RUN_AS_NODE;
spawnSync(electron, [root], { env, timeout: 300_000, stdio: 'ignore' });
if (!fs.existsSync(out)) {
  console.error('No e2e output produced.');
  process.exit(1);
}
const r = JSON.parse(fs.readFileSync(out, 'utf8'));
const checks = [
  ['window observed through UI Automation', r.inspect?.elements > 0 && r.inspect?.foundSettingsTab],
  ['real pointer click lands on the element (most-scaled monitor)', r.pointerClick?.active === 'search' && !r.pointerClick?.error],
  ['section navigation (Settings tab)', r.navigateToSettings?.state === 'completed' && r.navigateToSettings?.appTab === 'settings'],
  ['unchanged element re-validated and reused', r.reuseUnchanged?.state === 'completed'],
  ['vanished element refused, nothing dispatched', r.staleRefused?.state === 'failed' && r.staleRefused?.appTab === 'chats'],
  ['ambiguous contact asks instead of guessing', r.openAmbiguous?.opened === false && r.openAmbiguous?.candidates?.length === 2],
  ['exact contact opened and verified', r.openExact?.state === 'completed' && r.openExact?.verification === 'verified' && r.appOpenChat === 'Daniel Okafor'],
  ['chat read with directions', r.read?.messages?.[0]?.from === 'them' && r.read?.messages?.[1]?.from === 'me'],
  ['nothing sent without approval / after denial', Array.isArray(r.sentAfterCancelAndDeny) && r.sentAfterCancelAndDeny.length === 0],
  ['approved send verified on screen', r.send?.state === 'completed' && r.send?.verification === 'verified'],
  ['duplicate send prevented', Array.isArray(r.sentFinal) && r.sentFinal.length === 1],
  ['live chat: starts after one approval', r.liveStart?.state === 'completed' && r.liveStart?.status === 'active'],
  ['live chat: replies to a new message on its own', r.liveReplied?.length === 1 && r.liveReplied[0].to === 'Daniel Smith'],
  ['live chat: pauses on a price question, sends nothing', r.livePaused?.status === 'waiting_user' && r.livePaused?.sentSince === 1],
  ['live chat: continues with the user’s answer', r.liveAnswered?.length === 1 && /\$50/.test(r.liveAnswered[0].text)],
  ['live chat: nothing sent after stop', r.liveStopped?.status === 'ended' && r.liveStopped?.sentAfterStop === 0],
];
let ok = r.ok === true;
console.log(`Monitors: ${r.display?.count} (scale ${r.display?.scaleFactors?.join(', ')}); test window on scale ${r.display?.used}. Helper: ${JSON.stringify(r.pointerClick?.helper)}`);
if (r.error) console.log(`ERROR ${r.error}`);
for (const [name, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
  ok &&= !!pass;
}
console.log(`\n${checks.filter((c) => c[1]).length}/${checks.length} desktop e2e checks passed. Disposable profile: ${profile}`);
process.exit(ok ? 0 : 1);
