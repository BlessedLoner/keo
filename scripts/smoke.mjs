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

function launch(run, extra = {}) {
  const out = path.join(profile, `smoke-${run}.json`);
  const env = { ...process.env, KEO_SMOKE: '1', KEO_ENABLE_TEST_PROVIDER: '1', KEO_USER_DATA_DIR: profile, KEO_SMOKE_OUT: out, ...extra };
  // A parent Electron-based tool may set this; it would make Electron run as plain Node.
  delete env.ELECTRON_RUN_AS_NODE;
  // A manual live send (KEO_LIVE_RESULTS_SEND) happens once, in the first run only.
  if (run !== 1) delete env.KEO_LIVE_RESULTS_SEND;
  // KEO_SMOKE_APP=<path to Keo.exe> runs the same checks against a packaged build.
  const app = process.env.KEO_SMOKE_APP;
  const r = spawnSync(app ?? electron, app ? [] : [root], {
    env,
    // Screenshot runs capture many windows and take longer; Studio's checks make real videos (about two minutes).
    timeout: process.env.KEO_LIVE_RESULTS_SEND ? 400_000 : process.env.KEO_SMOKE_SHOTS ? 360_000 : 240_000,
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
check('bridge exposes only invoke/on/pathForFile', JSON.stringify(a.bridgeKeys) === '["invoke","on","pathForFile"]', a.bridgeKeys);
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
check('video window: rendered', p.videoRendered === true, p.videoRendered);
check('video window: does not take focus', p.videoFocused === false, p.videoFocused);
check('video window: may read the project', p.videoGet === 'ok', p.videoGet);
check('video window: cannot read memory', p.videoMemoryList === 'forbidden', p.videoMemoryList);
check('video window: cannot send chat', p.videoChatSend === 'forbidden', p.videoChatSend);
check('video window: cannot change settings', p.videoSettingsUpdate === 'forbidden', p.videoSettingsUpdate);
check('video window: cannot choose ffmpeg', p.videoPickFfmpeg === 'forbidden', p.videoPickFfmpeg);
check('video window: cannot start the ffmpeg download', p.videoSetupStart === 'forbidden', p.videoSetupStart);
check('video window: closes', p.videoClosed === true, p.videoClosed);
if (p.liveSend) console.log('LIVE send from the results window:', JSON.stringify(p.liveSend), 'window back:', p.liveResultsBack);
check('pencil: opens over the screen', p.pencilStarted === true && p.pencilRendered === true, p.pencilError ?? p.pencilStarted);
check('pencil: may read its screen picture', p.pencilContext === 'ok', p.pencilContext);
check('pencil: cannot send chat', p.pencilChatSend === 'forbidden', p.pencilChatSend);
check('pencil: draw, type and send reaches Keo', p.pencilSent === true, p.pencilSent);
check('pencil: closes', p.pencilClosed === true, p.pencilClosed);
check('marks: drawn over the screen', p.marksRendered === 2, p.marksError ?? p.marksRendered);
check('marks: click-through, never focused', p.marksClickThrough === true, p.marksClickThrough);
check('marks: cover only the marked area', p.marksPartial === true, p.marksPartial);
check('marks: cannot send chat', p.marksChatSend === 'forbidden', p.marksChatSend);
check('marks: gone again', p.marksClosed === true, p.marksClosed);
check('keo mode: shows Keo', p.keoModeRendered === true, p.keoModeError ?? p.keoModeRendered);
check('keo mode: may read presence', p.keoModePresence === 'ok', p.keoModePresence);
check('keo mode: cannot send chat', p.keoModeChatSend === 'forbidden', p.keoModeChatSend);
check('keo mode: closes', p.keoModeClosed === true, p.keoModeClosed);
check('WebP product pictures are converted to PNG', p.webpConverted === true, p.webpConverted);
check('copy from Keo’s window reaches the clipboard', p.copyText === true, p.copyText);
if (p.voiceSpeak) check('voice reply is spoken by the app voice', p.voiceSpeak.how === 'spoken', JSON.stringify(p.voiceSpeak));
check('report renders as PDF', p.reportPdf === true, p.reportError ?? p.reportPdf);
check('report renders as picture', p.reportPng === true, p.reportError ?? p.reportPng);
check('report renders again', p.reportAgain === true, p.reportError ?? p.reportAgain);
check('companion: closed when disabled', p.companionClosedWhenDisabled === true, p.companionClosedWhenDisabled);
check('presence: no orphan windows after shutdown', p.noPresenceWindowsAfterShutdown === true, p.noPresenceWindowsAfterShutdown);

const b = launch(2);
check('conversations persist across restart', b.conversationCount === (p.conversationsAfter ?? a.conversationCount) + 1, `${p.conversationsAfter ?? a.conversationCount} -> ${b.conversationCount}`);

// Keo Studio with real codecs: export, re-import, edit, export again, frames for Keo.
const st = a.studio ?? {};
check('studio: media loads in pages from another origin (development)', st.crossOrigin?.img === 640 && st.crossOrigin?.audio > 1.9 && st.crossOrigin?.bytes > 100000, st.error ?? JSON.stringify(st.crossOrigin));
check('studio: pictures and sound import', Array.isArray(st.imported) && st.imported.length === 2, st.error ?? JSON.stringify(st.imported));
check('studio: exports picture + animated text + sound to MP4', st.first?.frames === 60 && st.firstHasSound === true, st.error ?? JSON.stringify(st.first) + ' sound ' + st.firstHasSound);
check('studio: re-imports its own MP4 (video with sound)', typeof st.reimported === 'string' && st.reimported.startsWith('video:640x360:') && st.reimported.endsWith(':true'), st.error ?? st.reimported);
check('studio: edits and exports real H.264 again (exact decoding)', st.second?.frames >= 60 && st.second?.frames <= 61, st.error ?? JSON.stringify(st.second));
check('studio: the timeline sound is mixed for captions (speech found)', st.speech?.rate === 16000 && Math.abs(st.speech.seconds - 2) < 0.05 && st.speech.spans?.length === 1 && st.speech.spans[0].start < 0.1 && st.speech.spans[0].end > 1.9, st.error ?? JSON.stringify(st.speech));
check('studio: a video’s own sound is analysed for speech', Array.isArray(st.third?.speech) && st.third.speech.length >= 1 && st.third.speech[0].start < 0.2, st.error ?? JSON.stringify(st.third));
check('studio: voice clean-up, voice changer, loudness, colour, push-in, mirror, blend, volume keyframes and a sound effect export', st.third?.frames >= 55 && st.third?.frames <= 61 && st.third?.sound === true, st.error ?? JSON.stringify(st.third));
check('studio: motion design draws, moves and exports (presets, shapes, keyframes)', st.motion?.frames >= 70 && st.motion?.frames <= 73 && st.motion?.layers === 11 && Array.isArray(st.motion?.brightness) && st.motion.brightness.every((b) => b > 8) && new Set(st.motion.brightness).size > 1, st.error ?? JSON.stringify(st.motion));
check('studio: a video is split where its shot changes (decoded on this PC)', st.shots?.splits === 1 && Array.isArray(st.shots?.scenes) && Math.abs(st.shots.scenes[0] - 1.5) <= 0.07 && Math.abs(st.shots.starts[1] - 1.5) <= 0.07, st.error ?? JSON.stringify(st.shots));
check('studio: a clip plays backwards (reversed copy, picture and sound)', st.reverse?.sound === true && Math.abs(st.reverse?.duration - 3) < 0.1 && st.reverse.first.r > 200 && st.reverse.first.b < 60 && st.reverse.first.g < 60 && st.reverse.last.g > 80, st.error ?? JSON.stringify(st.reverse));
check('studio: an adjustment layer changes what is under it, only while it is on', st.adjust?.during <= 6 && st.adjust?.after >= 40, st.error ?? JSON.stringify(st.adjust));
check('studio: a faceless video is made from a script (voice, pictures, captions) and exported', st.faceless?.scenes === 3 && st.faceless?.voice === 3 && st.faceless?.captions >= 3 && st.faceless?.sound === true && st.faceless?.frames > 60, st.error ?? JSON.stringify(st.faceless));
check('studio: export choices (720p, 24 fps, a file name)', st.exportChoices?.width === 720 && st.exportChoices?.height === 720 && st.exportChoices?.named === 'Smoke faceless 720.mp4' && Math.abs(st.exportChoices.frames - st.exportChoices.seconds * 24) <= 1, st.error ?? JSON.stringify(st.exportChoices));
check('studio: an export can be stopped', st.stopped?.asked === true && st.stopped?.result !== 'finished', st.error ?? JSON.stringify(st.stopped));
check('studio: cut to the beat finds the beat in real decoded sound', st.beat?.placed === 3 && st.beat.lengths.every((l) => l > 0.85 && l < 1.15), st.error ?? JSON.stringify(st.beat));
check('studio: read aloud puts a voice under the text', st.readAloud?.seconds > 0.5 && st.readAloud?.start === 0.5, st.error ?? JSON.stringify(st.readAloud));
check('studio: a speed curve exports at its new length', st.speedCurve?.frames > 10 && Math.abs(st.speedCurve.seconds - st.speedCurve.expected) < 0.1, st.error ?? JSON.stringify(st.speedCurve));
check('studio: green screen is keyed away on the graphics card', st.chroma?.before?.g > 200 && st.chroma?.before?.r < 60 && st.chroma?.after?.r > 200 && st.chroma?.after?.g < 60, st.error ?? JSON.stringify(st.chroma));
check('studio: frames for Keo to look at are drawn', Array.isArray(st.frames) && st.frames.length === 2 && st.frames.every((f) => f.width === 180 && f.centre > 20), st.error ?? JSON.stringify(st.frames));

// Switching to another data folder happens in place: same window, same process, other data.
const s = launch(3, { KEO_SMOKE_SWITCH: '1' });
check('switching accounts: no restart, same window', s.sameWindow === true && !s.error, s.error ?? s.sameWindow);
check('switching accounts: the other folder’s chats stay behind', Array.isArray(s.titles) && !s.titles.includes('before the switch'), JSON.stringify(s.titles));
check('switching accounts: Keo answers on the new folder', s.mode === 'local' && s.ownKeys === true, `${s.mode} ${s.ownKeys}`);

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
