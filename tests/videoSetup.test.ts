import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { channelAllowed } from '../src/main/ipc/roles';
import { locateFfmpeg } from '../src/main/video/ffmpeg';
import { FFMPEG_BUILD, FfmpegSetup, type FfmpegBuild, type SetupState } from '../src/main/video/setup';
import { extractEntry, listZip } from '../src/main/video/unzip';
import { tempDir } from './helpers';

/** A real .zip in memory (deflated entries), like the ffmpeg build's layout. */
function makeZip(files: Record<string, Buffer | string>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, raw] of Object.entries(files)) {
    const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    const packed = zlib.deflateRawSync(data);
    const n = Buffer.from(name);
    const crc = zlib.crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(packed.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(packed.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, packed);
    central.push(ch, n);
    offset += 30 + n.length + packed.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// Random bytes do not compress, so the download is about 420 kB.
const FFMPEG = randomBytes(300_000);
const FFPROBE = randomBytes(120_000);
const ZIP = makeZip({
  'ffmpeg-9.9-essentials_build/LICENSE': 'GNU GENERAL PUBLIC LICENSE Version 3',
  'ffmpeg-9.9-essentials_build/README.txt': 'readme',
  'ffmpeg-9.9-essentials_build/bin/ffmpeg.exe': FFMPEG,
  'ffmpeg-9.9-essentials_build/bin/ffprobe.exe': FFPROBE,
  'ffmpeg-9.9-essentials_build/bin/ffplay.exe': 'not wanted',
});
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function build(over: Partial<FfmpegBuild> = {}): FfmpegBuild {
  return { ...FFMPEG_BUILD, version: '9.9', url: 'https://example.test/ffmpeg-9.9.zip', sizeBytes: ZIP.length, sha256: sha(ZIP), ...over };
}

interface FakeServer {
  fetch: (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;
  requests: Array<{ url: string; range: string | null }>;
}

/**
 * Stands in for the download server: serves `body` in small pieces, honours Range, and can stop
 * sending after `stallAfter` bytes (the connection stays open, as on a broken network). No
 * request ever leaves the test.
 */
function server(body: Buffer, o: { stallAfter?: number; chunk?: number; delayMs?: number; status?: number; ranges?: boolean } = {}): FakeServer {
  const requests: FakeServer['requests'] = [];
  return {
    requests,
    fetch: async (url, init) => {
      const range = init.headers.Range ?? null;
      requests.push({ url, range });
      if (o.status) return new Response('nope', { status: o.status });
      const from = range && o.ranges !== false ? Number(range.match(/bytes=(\d+)-/)![1]) : 0;
      const part = body.subarray(from);
      const stallAt = o.stallAfter !== undefined && from < o.stallAfter ? o.stallAfter - from : Infinity;
      const size = o.chunk ?? 16_384;
      let sent = 0;
      const stream = new ReadableStream<Uint8Array>({
        async pull(ctrl) {
          if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
          if (sent >= stallAt) {
            // Never answers again (until aborted).
            await new Promise<void>((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
            return;
          }
          if (init.signal.aborted) {
            ctrl.error(new DOMException('aborted', 'AbortError'));
            return;
          }
          const end = Math.min(part.length, sent + size, stallAt);
          if (sent >= part.length) {
            ctrl.close();
            return;
          }
          ctrl.enqueue(new Uint8Array(part.subarray(sent, end)));
          sent = end;
        },
      });
      const headers: Record<string, string> = { 'content-length': String(part.length) };
      if (from) headers['content-range'] = `bytes ${from}-${body.length - 1}/${body.length}`;
      return new Response(stream, { status: from ? 206 : 200, headers });
    },
  };
}

function make(srv: FakeServer, over: Partial<FfmpegBuild> = {}, extra: { stallMs?: number; freeBytes?: number | null } = {}) {
  const root = tempDir('keo-ffsetup-');
  const audit: Array<{ decision: string; detail: Record<string, unknown> }> = [];
  const states: SetupState[] = [];
  const setup = new FfmpegSetup({
    root,
    fetch: srv.fetch,
    build: build(over),
    audit: (decision, detail) => audit.push({ decision, detail }),
    changed: (s) => states.push(s),
    stallMs: extra.stallMs ?? 2000,
    freeBytes: () => extra.freeBytes ?? null,
  });
  return { root, setup, audit, states };
}

const leftovers = (root: string) => fs.readdirSync(path.join(root, 'downloads')).concat(fs.existsSync(path.join(root, 'ffmpeg.new')) ? ['ffmpeg.new'] : []);

describe('Set up video tools', () => {
  it('downloads, checks the checksum, and unpacks only ffmpeg, ffprobe and the licence into Keo’s folder', async () => {
    const srv = server(ZIP);
    const { root, setup, audit, states } = make(srv);
    expect(setup.state()).toMatchObject({ phase: 'idle', installed: null });
    expect(srv.requests).toHaveLength(0); // nothing happens until the click
    setup.start();
    const end = await setup.wait();
    expect(end).toMatchObject({ phase: 'done', receivedBytes: ZIP.length, installed: { version: '9.9', dir: path.join(root, 'ffmpeg') } });
    expect(srv.requests).toEqual([{ url: 'https://example.test/ffmpeg-9.9.zip', range: null }]);
    expect(fs.readdirSync(path.join(root, 'ffmpeg')).sort()).toEqual(['LICENSE.txt', 'NOTICE.txt', 'ffmpeg.exe', 'ffprobe.exe', 'keo-ffmpeg.json']);
    expect(fs.readFileSync(path.join(root, 'ffmpeg', 'ffmpeg.exe'))).toEqual(FFMPEG);
    expect(fs.readFileSync(path.join(root, 'ffmpeg', 'LICENSE.txt'), 'utf8')).toMatch(/GENERAL PUBLIC LICENSE/);
    expect(fs.readFileSync(path.join(root, 'ffmpeg', 'NOTICE.txt'), 'utf8')).toMatch(/https:\/\/ffmpeg\.org\/download\.html/);
    expect(leftovers(root)).toEqual([]); // the zip is gone
    expect(states.some((s) => s.phase === 'downloading' && s.receivedBytes > 0 && s.totalBytes === ZIP.length)).toBe(true);
    expect(states.map((s) => s.phase)).toEqual(expect.arrayContaining(['downloading', 'checking', 'unpacking', 'done']));
    expect(audit.map((a) => a.decision)).toEqual(['started', 'installed']);
    expect(audit[1]!.detail).toMatchObject({ version: '9.9', sha256: sha(ZIP) });
    // Keo uses it from now on.
    expect(locateFfmpeg(null, '', undefined, setup.installed()!.dir)).toMatchObject({ source: 'keo', ffmpeg: path.join(root, 'ffmpeg', 'ffmpeg.exe') });
    // And can remove it again.
    expect(setup.remove()).toMatchObject({ installed: null });
    expect(fs.existsSync(path.join(root, 'ffmpeg'))).toBe(false);
    expect(audit.at(-1)!.decision).toBe('removed');
  });

  it('refuses a download whose checksum does not match, and deletes it', async () => {
    const { root, setup, audit } = make(server(ZIP), { sha256: 'a'.repeat(64) });
    setup.start();
    const end = await setup.wait();
    expect(end).toMatchObject({ phase: 'failed', installed: null, canResume: false });
    expect(end.message).toMatch(/did not match the published checksum/);
    expect(fs.existsSync(path.join(root, 'ffmpeg'))).toBe(false);
    expect(leftovers(root)).toEqual([]);
    expect(audit.map((a) => a.decision)).toEqual(['started', 'refused']);
  });

  it('refuses a file of the wrong size before downloading it', async () => {
    const srv = server(Buffer.concat([ZIP, Buffer.from('extra')]));
    const { root, setup, audit } = make(srv);
    setup.start();
    const end = await setup.wait();
    expect(end.phase).toBe('failed');
    expect(end.message).toMatch(/instead of/);
    expect(leftovers(root)).toEqual([]);
    expect(audit.at(-1)!.decision).toBe('refused');
  });

  it('cancels on request and cleans up the partial download', async () => {
    const { root, setup, audit, states } = make(server(ZIP, { chunk: 4096, delayMs: 5 }));
    setup.start();
    expect(setup.start().phase).toBe('downloading'); // a second click does not start a second download
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (states.some((s) => s.receivedBytes > 20_000)) {
          clearInterval(t);
          resolve();
        }
      }, 5);
    });
    setup.cancel();
    const end = await setup.wait();
    expect(end).toMatchObject({ phase: 'cancelled', installed: null, canResume: false, receivedBytes: 0 });
    expect(leftovers(root)).toEqual([]);
    expect(fs.existsSync(path.join(root, 'ffmpeg'))).toBe(false);
    expect(audit.map((a) => a.decision)).toEqual(['started', 'cancelled']);
  });

  it('gives up on a stalled connection, keeps what it has, and continues from there on the next try', async () => {
    const srv = server(ZIP, { stallAfter: 100_000 });
    const { root, setup, audit } = make(srv, {}, { stallMs: 150 });
    setup.start();
    const first = await setup.wait();
    expect(first).toMatchObject({ phase: 'failed', canResume: true, receivedBytes: 100_000 });
    expect(first.message).toMatch(/no data for/);
    expect(fs.statSync(path.join(root, 'downloads', 'ffmpeg-9.9.zip.part')).size).toBe(100_000);
    // A new Keo session sees the kept part too.
    const again = new FfmpegSetup({ root, fetch: server(ZIP).fetch, build: build(), audit: () => undefined, changed: () => undefined });
    expect(again.state()).toMatchObject({ canResume: true, receivedBytes: 100_000 });
    // Try again: asks only for the rest.
    srv.requests.length = 0;
    const fresh = server(ZIP);
    const retry = new FfmpegSetup({ root, fetch: fresh.fetch, build: build(), audit: (d) => audit.push({ decision: d, detail: {} }), changed: () => undefined });
    retry.start();
    expect(await retry.wait()).toMatchObject({ phase: 'done' });
    expect(fresh.requests).toEqual([{ url: 'https://example.test/ffmpeg-9.9.zip', range: 'bytes=100000-' }]);
    expect(fs.readFileSync(path.join(root, 'ffmpeg', 'ffprobe.exe'))).toEqual(FFPROBE);
    expect(audit.map((a) => a.decision)).toEqual(['started', 'failed', 'started', 'installed']);
  });

  it('starts over when the server ignores the range', async () => {
    const { root, setup } = make(server(ZIP, { stallAfter: 50_000 }), {}, { stallMs: 100 });
    setup.start();
    await setup.wait();
    const srv = server(ZIP, { ranges: false });
    const retry = new FfmpegSetup({ root, fetch: srv.fetch, build: build(), audit: () => undefined, changed: () => undefined });
    retry.start();
    expect(await retry.wait()).toMatchObject({ phase: 'done' });
    expect(fs.readFileSync(path.join(root, 'ffmpeg', 'ffmpeg.exe'))).toEqual(FFMPEG);
  });

  it('says so when the server fails or the disk is full', async () => {
    const a = make(server(ZIP, { status: 503 }));
    a.setup.start();
    expect((await a.setup.wait()).message).toMatch(/answered 503/);
    const b = make(server(ZIP), {}, { freeBytes: 1000 });
    b.setup.start();
    const end = await b.setup.wait();
    expect(end.message).toMatch(/not enough free space/);
    expect(end.phase).toBe('failed');
  });

  it('refuses an archive without ffmpeg.exe and ffprobe.exe', async () => {
    const zip = makeZip({ 'x/bin/ffmpeg.exe': 'only one' });
    const { root, setup } = make(server(zip), { sizeBytes: zip.length, sha256: sha(zip) });
    setup.start();
    const end = await setup.wait();
    expect(end.message).toMatch(/does not contain ffmpeg\.exe and ffprobe\.exe/);
    expect(fs.existsSync(path.join(root, 'ffmpeg'))).toBe(false);
  });

  it('pins one official build with its SHA-256', () => {
    expect(FFMPEG_BUILD.url).toMatch(/^https:\/\/github\.com\/GyanD\/codexffmpeg\/releases\/download\/9\.0\.2\/ffmpeg-9\.0\.2-essentials_build\.zip$/);
    expect(FFMPEG_BUILD.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(FFMPEG_BUILD.sizeBytes).toBeGreaterThan(50_000_000);
  });

  it('can only be started from the main window', () => {
    expect(channelAllowed('main', 'video:setupStart')).toBe(true);
    for (const role of ['video', 'command', 'companion', 'results', 'pencil', 'keomode', 'marks'] as const) expect(channelAllowed(role, 'video:setupStart')).toBe(false);
  });
});

describe('unzip', () => {
  it('reads entries and refuses damaged data', async () => {
    const dir = tempDir('keo-unzip-');
    const file = path.join(dir, 'a.zip');
    fs.writeFileSync(file, makeZip({ 'a/b.txt': 'hello', 'a/empty': '' }));
    const list = await listZip(file);
    expect(list.map((e) => e.name)).toEqual(['a/b.txt', 'a/empty']);
    await extractEntry(file, list[0]!, path.join(dir, 'out.txt'));
    expect(fs.readFileSync(path.join(dir, 'out.txt'), 'utf8')).toBe('hello');
    await extractEntry(file, list[1]!, path.join(dir, 'empty'));
    expect(fs.readFileSync(path.join(dir, 'empty'), 'utf8')).toBe('');
    await expect(extractEntry(file, { ...list[0]!, crc: 1 }, path.join(dir, 'bad.txt'))).rejects.toThrow(/damaged/);
    expect(fs.existsSync(path.join(dir, 'bad.txt'))).toBe(false);
    fs.writeFileSync(path.join(dir, 'no.zip'), 'not a zip at all, just text');
    await expect(listZip(path.join(dir, 'no.zip'))).rejects.toThrow(/not a zip/);
  });
});

describe('ffmpeg precedence', () => {
  it('uses the chosen file, then Keo’s own copy, then PATH', () => {
    if (process.platform !== 'win32') return;
    const files = new Set(['D:\\tools\\ffmpeg.exe', 'D:\\tools\\ffprobe.exe', 'K:\\keo\\ffmpeg.exe', 'K:\\keo\\ffprobe.exe', 'E:\\bin\\ffmpeg.exe', 'E:\\bin\\ffprobe.exe']);
    const exists = (p: string) => files.has(p);
    expect(locateFfmpeg('D:\\tools\\ffmpeg.exe', 'E:\\bin', exists, 'K:\\keo')).toMatchObject({ source: 'settings', ffmpeg: 'D:\\tools\\ffmpeg.exe' });
    expect(locateFfmpeg(null, 'E:\\bin', exists, 'K:\\keo')).toMatchObject({ source: 'keo', ffmpeg: 'K:\\keo\\ffmpeg.exe', ffprobe: 'K:\\keo\\ffprobe.exe' });
    expect(locateFfmpeg(null, 'E:\\bin', exists, 'K:\\missing')).toMatchObject({ source: 'path', ffmpeg: 'E:\\bin\\ffmpeg.exe' });
    expect(locateFfmpeg(null, 'E:\\bin', exists, null)).toMatchObject({ source: 'path' });
    files.delete('K:\\keo\\ffprobe.exe');
    expect(locateFfmpeg(null, 'E:\\bin', exists, 'K:\\keo')).toMatchObject({ source: 'path' }); // half a copy is not used
  });
});
