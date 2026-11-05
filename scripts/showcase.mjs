// Keo's product tour, made by Keo (development only): builds the app, then runs it once in a
// throw-away profile with demo content; Keo captures each part in HD and Keo Studio makes the video.
//   node scripts/showcase.mjs <output folder> [footage.mp4] [character pictures; separated by ;]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electron = require('electron');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const [out, footage = '', character = ''] = process.argv.slice(2);
if (!out) {
  console.error('Usage: node scripts/showcase.mjs <output folder> [footage.mp4] [character pictures; separated by ;]');
  process.exit(1);
}
fs.mkdirSync(out, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'keo-showcase-'));
const env = { ...process.env, KEO_ENABLE_TEST_PROVIDER: '1', KEO_USER_DATA_DIR: profile, KEO_SHOWCASE: path.resolve(out), KEO_SHOWCASE_FOOTAGE: footage, KEO_SHOWCASE_CHARACTER: character };
delete env.ELECTRON_RUN_AS_NODE;
const r = spawnSync(electron, [root], { env, timeout: 15 * 60_000, encoding: 'utf8' });
const resultFile = path.join(out, 'result.json');
if (!fs.existsSync(resultFile)) {
  console.error(r.stdout, r.stderr);
  console.error('No result (exit ' + r.status + ')');
  process.exit(1);
}
console.log(fs.readFileSync(resultFile, 'utf8'));
