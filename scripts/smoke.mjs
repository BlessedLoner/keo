// Lifecycle smoke check for the built app.
// Launches the real Electron app twice against a DISPOSABLE profile directory
// with the deterministic test provider, and verifies:
//  - the renderer has no Node/Electron globals and only the narrow bridge
//  - unknown IPC channels and invalid inputs are rejected
//  - the renderer cannot make network requests
//  - a conversation round-trip works and persists across a restart
// No real provider, desktop input or Keo user profile is touched.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electron = require('electron');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'keo-smoke-'));

function launch(run) {
  const out = path.join(profile, `smoke-${run}.json`);
  const env = { ...process.env, KEO_SMOKE: '1', KEO_ENABLE_TEST_PROVIDER: '1', KEO_USER_DATA_DIR: profile, KEO_SMOKE_OUT: out };
  // A parent Electron-based tool may set this; it would make Electron run as plain Node.
  delete env.ELECTRON_RUN_AS_NODE;
  // A manual live send (KEO_LIVE_RESULTS_SEND) happens once, in the first run only.
  if (run !== 1) delete env.KEO_LIVE_RESULTS_SEND;
  // KEO_SMOKE_APP=<path to Keo.exe> runs the same checks against a packaged build.
  const app = process.env.KEO_SMOKE_APP;
  const r = spawnSync(app ?? electron, app ? [] : [root], {
    env,
    timeout: process.env.KEO_LIVE_RESULTS_SEND ? 400_000 : 90_000,
    encoding: 'utf8',
  });
  if (!fs.existsSync(out)) {
    console.error(r.stdout, r.stderr);
    throw new Error(`run ${run}: no smoke output (exit ${r.status})`);
  }
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail });
};

const a = launch(1);
check('renderer has no require()', a.hasRequire === false, a.hasRequire);
check('renderer has no process', a.hasProcess === false, a.hasProcess);
check('renderer has no module', a.hasModule === false, a.hasModule);
check('bridge exposes only invoke/on', JSON.stringify(a.bridgeKeys) === '["invoke","on"]', a.bridgeKeys);
check('bridge is frozen', a.bridgeFrozen === true, a.bridgeFrozen);
check('unknown channel rejected', a.unknownChannel === 'rejected', a.unknownChannel);
check('invalid input rejected', a.invalidInput === 'invalid_input', a.invalidInput);
check('renderer network blocked', a.rendererNetwork === 'blocked', a.rendererNetwork);
check('UI rendered', a.rootRendered === true, a.rootRendered);
check('isolated profile in use', String(a.profile).includes('custom dir'), a.profile);
check('schema migrated', a.schemaVersion >= 1, a.schemaVersion);
check('OS secret encryption available', a.secretStorage === 'os-encrypted', a.secretStorage);
check('chat round-trip completes', a.assistantStatus === 'complete', `${a.assistantStatus}: ${a.assistantText}`);
check('capabilities registered', a.capabilities >= 15, a.capabilities);
check('trained wake word engine loads (Porcupine)', a.porcupineLoads === true, a.porcupineLoads);
if (process.env.KEO_SMOKE_DESKTOP === '1') {
  for (const st of a.selfTest?.steps ?? []) check(`desktop helper: ${st.title}`, st.ok, st.detail);
  check('desktop helper: self-test ran', Array.isArray(a.selfTest?.steps) && a.selfTest.steps.length === 7, a.selfTest?.error ?? a.selfTest?.advice);
}

const p = a.presence ?? {};
check('presence: no error', !p.error, p.error);
check('companion: exactly one window', p.companionSingle === true, p.companionSingle);
check('companion: never takes focus', p.companionFocusable === false, p.companionFocusable);
check('companion: always on top', p.companionAlwaysOnTop === true, p.companionAlwaysOnTop);
check('companion: placed on a display', p.companionOnScreen === true, p.companionOnScreen);
check('companion: rendered', p.companionRendered === true, p.companionRendered);
check('companion: may read presence', p.companionPresenceGet === 'ok', p.companionPresenceGet);
check('companion: cannot read memory', p.companionMemoryList === 'forbidden', p.companionMemoryList);
check('companion: cannot send chat', p.companionChatSend === 'forbidden', p.companionChatSend);
check('command bar: rendered', p.commandRendered === true, p.commandRendered);
check('command bar: may query chat', p.commandChatActive === 'ok', p.commandChatActive);
check('command bar: cannot change settings', p.commandSettingsUpdate === 'forbidden', p.commandSettingsUpdate);
check('command bar: cannot list desktop windows', p.commandDesktopList === 'forbidden', p.commandDesktopList);
check('shortcut: registers', p.shortcutRegistered === true, p.shortcutRegistered);
check('shortcut: released when disabled', p.shortcutReleasedWhenDisabled === true, p.shortcutReleasedWhenDisabled);
check('results window: shows the cards', p.resultsRendered === 2, p.resultsRendered);
check('results window: shows the title', typeof p.resultsTitle === 'string' && p.resultsTitle.startsWith('MacBook Pro M4'), p.resultsTitle);
check('results window: may read results', p.resultsGet === 'ok', p.resultsGet);
check('results window: cannot read memory', p.resultsMemoryList === 'forbidden', p.resultsMemoryList);
check('results window: cannot change settings', p.resultsSettingsUpdate === 'forbidden', p.resultsSettingsUpdate);
check('results window: cannot approve tasks', p.resultsTasksApprove === 'forbidden', p.resultsTasksApprove);
check('results window: steps aside during desktop work', p.resultsStepsAside === true, p.resultsStepsAside);
check('results window: stays closed once closed', p.resultsStaysClosed === true, p.resultsStaysClosed);
if (p.liveSend) console.log('LIVE send from the results window:', JSON.stringify(p.liveSend), 'window back:', p.liveResultsBack);
check('report renders as PDF', p.reportPdf === true, p.reportError ?? p.reportPdf);
check('report renders as picture', p.reportPng === true, p.reportError ?? p.reportPng);
check('report renders again', p.reportAgain === true, p.reportError ?? p.reportAgain);
check('companion: closed when disabled', p.companionClosedWhenDisabled === true, p.companionClosedWhenDisabled);
check('presence: no orphan windows after shutdown', p.noPresenceWindowsAfterShutdown === true, p.noPresenceWindowsAfterShutdown);

const b = launch(2);
check('conversations persist across restart', b.conversationCount === (p.conversationsAfter ?? a.conversationCount) + 1, `${p.conversationsAfter ?? a.conversationCount} -> ${b.conversationCount}`);

const logDir = path.join(profile, 'logs');
const logs = fs.readdirSync(logDir).map((f) => fs.readFileSync(path.join(logDir, f), 'utf8')).join('\n');
check('log has startup + shutdown events', logs.includes('"app.ready"') && logs.includes('"app.shutdown"'), '');
check('log contains no message text', !logs.includes('hello from smoke test'), '');

let failed = 0;
for (const c of checks) {
  if (!c.ok) failed++;
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : `  (got: ${JSON.stringify(c.detail)})`}`);
}
console.log(`\n${checks.length - failed}/${checks.length} smoke checks passed. Disposable profile: ${profile}`);
fs.rmSync(profile, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
