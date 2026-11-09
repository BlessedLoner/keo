import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanVideo, uploadToYouTube, youTubeReason, YOUTUBE_UPLOAD_URL } from '../src/main/social/youtube';
import { parsePostText, postBody, postTextPrompt } from '../src/shared/social';
import { tempDir } from './helpers';

describe('Posting: the post Keo writes', () => {
  it('reads the model’s post, cleaning hashtags and keeping each platform’s limits', () => {
    const t = parsePostText('Here: {"title":"I built my own AI","caption":"Meet Keo.","hashtags":["ai","#Keo", "#ai", "build in public", "#x"]}');
    expect(t).toEqual({ title: 'I built my own AI', caption: 'Meet Keo.', hashtags: ['#ai', '#Keo', '#buildinpublic'] });
    expect(postBody(t!, 'tiktok')).toBe('Meet Keo.\n\n#ai #Keo #buildinpublic');
    expect(parsePostText('no json')).toBeNull();
    const prompt = postTextPrompt({ platform: 'tiktok', transcript: 'hi everyone', projectName: 'My video', handle: '@keo.ai', aiMade: true });
    expect(prompt).toContain('@keo.ai');
    expect(prompt).toContain('Made with AI');
  });
});

describe('Posting: YouTube upload (a fake YouTube: nothing is posted)', () => {
  it('starts a resumable upload with the title, privacy and AI label, then sends the file', async () => {
    const dir = tempDir('keo-yt-');
    const file = path.join(dir, 'video.mp4');
    fs.writeFileSync(file, Buffer.from('fake mp4 bytes'));
    const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: unknown }> = [];
    const fetch = async (url: string, init: { method: string; headers: Record<string, string>; body?: string | Uint8Array }) => {
      calls.push({ url, method: init.method, headers: init.headers, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body?.length });
      if (url === YOUTUBE_UPLOAD_URL) return { ok: true, status: 200, headers: { get: (n: string) => (n === 'location' ? 'https://upload.youtube.test/session/1' : null) }, json: async () => ({}) };
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ id: 'abc123' }) };
    };
    const r = await uploadToYouTube({ file, title: 'My <video>', description: 'd', tags: ['#ai', 'keo'], privacy: 'private', synthetic: true, forKids: false }, { token: async () => 'tok', fetch });
    expect(r).toEqual({ id: 'abc123', url: 'https://youtu.be/abc123' });
    expect(calls[0]!.headers.authorization).toBe('Bearer tok');
    expect(calls[0]!.body).toMatchObject({ snippet: { title: 'My video', tags: ['ai', 'keo'] }, status: { privacyStatus: 'private', containsSyntheticMedia: true, selfDeclaredMadeForKids: false } });
    expect(calls[1]).toMatchObject({ url: 'https://upload.youtube.test/session/1', method: 'PUT', body: 14 });
  });

  it('says plainly what YouTube refused', () => {
    expect(youTubeReason(403, { error: { errors: [{ reason: 'quotaExceeded' }] } })).toMatch(/limit for today/);
    expect(youTubeReason(403, { error: { errors: [{ reason: 'youtubeSignupRequired' }] } })).toMatch(/no YouTube channel/);
    expect(youTubeReason(401, {})).toMatch(/connect YouTube again/);
    expect(cleanVideo({ file: 'x', title: '   ', description: '', tags: [], privacy: 'private', synthetic: false, forKids: false }).title).toBe('My video');
  });
});
