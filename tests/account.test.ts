import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { Logger } from '../src/main/logging/logger';
import { WebService } from '../src/main/web/webService';
import { makeHarness, tempDir, type Harness } from './helpers';

/** Supabase Auth and Keo Cloud in memory. No request leaves the process. */
class FakeCloud {
  users = new Map<string, { password: string; confirmed: boolean }>();
  confirmRequired = true;
  refreshOk = true;
  calls: string[] = [];
  bodies: Array<Record<string, unknown>> = [];
  /** Keo Cloud's answer to search, pictures and voice (200, or a plan refusal). */
  mediaStatus = 200;
  n = 0;
  fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(url);
    const j = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, string>) : {};
    this.calls.push(`${init.method ?? 'GET'} ${u.pathname}${u.search}`);
    this.bodies.push(body);
    if (['/v1/search', '/v1/images', '/v1/speech', '/v1/transcribe'].includes(u.pathname)) {
      if (this.mediaStatus !== 200) return j(this.mediaStatus, { error: { message: 'Making pictures is not in the Free plan. Upgrade your Keo plan to use it.', code: 'feature_not_in_plan' } });
      if (u.pathname === '/v1/search') return j(200, { results: [{ title: 'Keo', url: 'https://keo.test/', description: 'A desktop agent', age: null }] });
      if (u.pathname === '/v1/images') return j(200, { b64: PNG.toString('base64'), mediaType: 'image/png' });
      if (u.pathname === '/v1/speech') return new Response(new Uint8Array([82, 73, 70, 70, 1, 2]), { status: 200, headers: { 'content-type': 'audio/wav' } });
      return j(200, { text: ' Open Notepad. ' });
    }
    if (u.pathname === '/auth/v1/signup') {
      if (this.users.has(body.email!)) return j(422, { error_code: 'user_already_exists', msg: 'User already registered' });
      this.users.set(body.email!, { password: body.password!, confirmed: !this.confirmRequired });
      return this.confirmRequired ? j(200, { id: 'u1', email: body.email }) : j(200, this.tokens());
    }
    if (u.pathname === '/auth/v1/token' && u.searchParams.get('grant_type') === 'password') {
      const acc = this.users.get(body.email!);
      if (!acc || acc.password !== body.password) return j(400, { error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
      if (!acc.confirmed) return j(400, { error_code: 'email_not_confirmed', msg: 'Email not confirmed' });
      return j(200, this.tokens());
    }
    if (u.pathname === '/auth/v1/token' && u.searchParams.get('grant_type') === 'refresh_token') {
      return this.refreshOk ? j(200, this.tokens()) : j(400, { error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' });
    }
    if (u.pathname === '/auth/v1/logout') return new Response(null, { status: 204 });
    if (u.pathname === '/v1/billing/ticket') return j(200, { ticket: 'kt.payload.sig' });
    if (u.pathname === '/v1/me') return j(200, { user: { id: 'u1' }, plan: { id: 'free', name: 'Free', daily_requests: 60, daily_tokens: 300000, features: { web_search: 10 } }, usage: { day: '2026-10-26', requests: 5, input_tokens: 1200, output_tokens: 300 } });
    if (u.pathname === '/v1/models') return j(200, { data: [{ id: 'keo-fast', keo: { label: 'Keo Fast', vision: true, tools: true, contextTokens: 128000, maxOutputTokens: 4096 } }] });
    return j(404, {});
  };
  /** What the app last sent to a Keo Cloud path. */
  sent(path: string): Record<string, unknown> | undefined {
    for (let i = this.calls.length - 1; i >= 0; i--) if (this.calls[i] === `POST ${path}`) return this.bodies[i];
    return undefined;
  }
  tokens() {
    this.n++;
    return { access_token: `access-${this.n}`, refresh_token: `refresh-${this.n}`, expires_in: 3600, user: { id: '11111111-1111-4111-8111-111111111111' } };
  }
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const changes: Array<string | null> = [];
function setup(opts: { web?: WebService; confirmPollMs?: number } = {}) {
  const cloud = new FakeCloud();
  changes.length = 0;
  h = makeHarness({ deps: { cloudFetch: cloud.fetch, onAccountChange: (id) => void changes.push(id), ...(opts.confirmPollMs ? { confirmPollMs: opts.confirmPollMs } : {}) }, ...(opts.web ? { web: opts.web } : {}) });
  return cloud;
}

async function signedIn(opts: { web?: WebService } = {}) {
  const cloud = setup(opts);
  cloud.confirmRequired = false;
  await h.services.account.signUp('ana@example.test', 'longpassword1');
  return cloud;
}

const signal = () => new AbortController().signal;

describe('Keo account', () => {
  it('signs up (email confirmation first), then signs in, reads the plan and makes Keo’s AI the provider', async () => {
    const cloud = setup();
    const r = await h.services.account.signUp('Ana@Example.test', 'longpassword1');
    expect(r.needsConfirmation).toBe(true);
    expect(h.services.account.status()).toMatchObject({ signedIn: false, pendingEmail: 'ana@example.test' });
    await expect(h.services.account.signIn('ana@example.test', 'longpassword1')).rejects.toThrow(/Confirm your email first/);
    cloud.users.get('ana@example.test')!.confirmed = true;
    await h.services.account.signIn('ana@example.test', 'longpassword1');
    const st = h.services.account.status();
    expect(st).toMatchObject({ signedIn: true, email: 'ana@example.test', plan: { id: 'free', dailyRequests: 60 }, usage: { requests: 5 } });
    expect(h.services.account.token()).toBe('access-1');
    // The Keo provider is ready and offers the plan's models.
    const keo = h.services.providers.get('keo');
    expect(keo.status()).toEqual({ kind: 'ready' });
    expect(keo.models().map((m) => m.id)).toEqual(['keo-fast']);
    // The session is stored encrypted, never the password.
    const stored = h.services.secrets.get('keo_account')!;
    expect(stored).toContain('refresh-1');
    expect(stored).not.toContain('longpassword1');
    // The confirmation email links to Keo's account page.
    expect(cloud.calls).toContain(`POST /auth/v1/signup?redirect_to=${encodeURIComponent('https://cloud.heykeo.com/account')}`);
  });

  it('says plainly what went wrong', async () => {
    const cloud = setup();
    cloud.confirmRequired = false;
    await h.services.account.signUp('ana@example.test', 'longpassword1');
    await expect(h.services.account.signUp('ana@example.test', 'longpassword1')).rejects.toThrow(/already a Keo account/);
    await h.services.account.signOut();
    await expect(h.services.account.signIn('ana@example.test', 'wrong')).rejects.toThrow(/email or password is not right/);
  });

  it('renews the sign-in before it ends, and signs out when Supabase no longer accepts it', async () => {
    const cloud = setup();
    cloud.confirmRequired = false;
    await h.services.account.signUp('ana@example.test', 'longpassword1');
    // Pretend the hour is almost over.
    const raw = JSON.parse(h.services.secrets.get('keo_account')!) as { expiresAt: number };
    raw.expiresAt = Date.now() + 30_000;
    h.services.secrets.set('keo_account', JSON.stringify(raw));
    (h.services.account as unknown as { session: unknown }).session = raw;
    await h.services.account.fresh();
    expect(h.services.account.token()).toMatch(/^access-[2-9]/);
    expect(cloud.calls.some((c) => c.includes('grant_type=refresh_token'))).toBe(true);
    // The refresh token is refused: signed out, with a clear message.
    cloud.refreshOk = false;
    (h.services.account as unknown as { session: { expiresAt: number } }).session.expiresAt = Date.now() + 1000;
    await expect(h.services.account.fresh()).rejects.toThrow(/sign-in has ended/);
    expect(h.services.account.signedIn()).toBe(false);
    expect(h.services.providers.get('keo').status().kind).toBe('unconfigured');
  });

  it('searches the web through Keo Cloud when signed in, and falls back to DuckDuckGo when today’s searches are used up', async () => {
    const ddg: string[] = [];
    // DuckDuckGo stays in memory too: it answers with an empty results page.
    const web = new WebService(() => null, new Logger(tempDir(), false), (async (u: string | URL) => (ddg.push(String(u)), new Response('<html></html>', { status: 200 }))) as typeof fetch);
    const cloud = await signedIn({ web });
    const r = await h.services.web.find('keo agent', { count: 3, safesearch: 'moderate', engine: 'auto' }, signal());
    expect(r).toEqual({ source: 'Keo Search', results: [{ title: 'Keo', url: 'https://keo.test/', description: 'A desktop agent', age: null }] });
    expect(cloud.calls).toContain('POST /v1/search');
    expect(ddg).toHaveLength(0);
    cloud.mediaStatus = 429;
    const r2 = await h.services.web.find('keo agent', { count: 3, safesearch: 'moderate', engine: 'auto' }, signal());
    expect(r2.source).toBe('DuckDuckGo');
    expect(ddg).toHaveLength(1);
    // Chosen explicitly, Keo Search says why instead.
    await expect(h.services.web.find('x', { count: 3, safesearch: 'moderate', engine: 'keo' }, signal())).rejects.toThrow(/not in the Free plan/);
    await h.services.account.signOut();
    expect(h.services.web.sourceFor('auto')).toBe('DuckDuckGo');
  });

  it('makes pictures through Keo Cloud without an OpenAI key, and says plainly when the plan does not include them', async () => {
    const cloud = await signedIn();
    expect(h.services.pictures.aiAvailable()).toBe(true);
    const folder = tempDir();
    const made = await h.services.pictures.generate('a red bicycle', { name: 'bike', size: '1024x1024', quality: 'medium', background: 'auto', folder }, signal());
    expect(fs.readFileSync(made.path)).toEqual(PNG);
    const src = `${folder}\\photo.jpg`;
    fs.writeFileSync(src, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    await h.services.pictures.aiEdit(src, 'make the sky purple', { name: 'purple', size: '1536x1024', quality: 'high', background: 'auto', folder }, signal());
    const sent = cloud.sent('/v1/images') as unknown as { prompt: string; image: { data: string; type: string } };
    expect(sent.prompt).toBe('make the sky purple');
    expect(sent.image).toEqual({ data: Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString('base64'), type: 'image/jpeg' });
    cloud.mediaStatus = 403;
    await expect(h.services.pictures.generate('a cat', { name: 'cat', size: '1024x1024', quality: 'medium', background: 'auto', folder }, signal())).rejects.toThrow(/not in the Free plan.*Nothing was made/);
    // With the user's own OpenAI key, 'auto' uses that key; 'keo' still uses the Keo account.
    h.services.secrets.set('openai', 'sk-test-not-real');
    h.services.settings.update({ pictures: { aiSource: 'keo' } });
    const before = cloud.calls.filter((c) => c === 'POST /v1/images').length;
    cloud.mediaStatus = 200;
    await h.services.pictures.generate('a dog', { name: 'dog', size: '1024x1024', quality: 'medium', background: 'auto', folder }, signal());
    expect(cloud.calls.filter((c) => c === 'POST /v1/images').length).toBe(before + 1);
    h.services.secrets.delete('openai');
    h.services.settings.update({ pictures: { aiSource: 'openai' } });
    expect(h.services.pictures.aiAvailable()).toBe(false);
    h.services.settings.update({ pictures: { aiSource: 'auto' } });
    await h.services.account.signOut();
    expect(h.services.pictures.aiAvailable()).toBe(false);
  });

  it('speaks in Keo’s voice and listens through Keo Cloud, only as the user chose', async () => {
    const cloud = await signedIn();
    // Defaults are unchanged: the Windows voice, and no listening.
    expect(h.services.settings.get().voice).toMatchObject({ ttsEngine: 'system', sttProvider: 'none' });
    h.services.settings.update({ voice: { ttsEngine: 'keo', keoVoice: 'male', sttProvider: 'keo' } });
    const clip = await h.services.voice.speak('Hello there', signal());
    expect(clip.mimeType).toBe('audio/wav');
    expect(cloud.sent('/v1/speech')).toEqual({ text: 'Hello there', voice: 'male' });
    // Listening needs the user's consent first.
    expect(h.services.voice.sttStatus().reason).toMatch(/Allow sending recordings to Keo Cloud/);
    h.services.settings.update({ voice: { audioExportConsent: true } });
    const text = await h.services.voice.transcribe(new Uint8Array([82, 73, 70, 70, 9, 9]), 'audio/wav', signal());
    expect(text).toBe('Open Notepad.');
    expect(cloud.sent('/v1/transcribe')).toMatchObject({ format: 'wav', language: 'en' });
    cloud.mediaStatus = 429;
    await expect(h.services.voice.speak('More', signal())).rejects.toMatchObject({ code: 'voice_limit' });
  });

  it('opens Keo’s plans page in the browser with a billing ticket, never the sign-in itself', async () => {
    const cloud = await signedIn();
    const opened: string[] = [];
    const { createHandlers } = await import('../src/main/ipc/handlers');
    const handlers = createHandlers(h.services, { appInfo: () => ({ name: 'Keo', version: '0', electron: '', chrome: '', node: '', platform: '', packaged: false, testProviderEnabled: true }), openPath: async () => true, openExternal: async (u) => void opened.push(u), pickExecutable: async () => null, relaunch: () => undefined });
    expect(await handlers['account:upgrade']({})).toEqual({ opened: true });
    expect(opened).toEqual(['https://cloud.heykeo.com/upgrade#t=kt.payload.sig']);
    expect(opened[0]).not.toContain(h.services.account.token()!);
    expect(cloud.calls).toContain('POST /v1/billing/ticket');
  });

  it('signing out from the app goes back to the sign-in screen', async () => {
    await signedIn();
    h.services.settings.update({ ui: { ownKeys: true }, activeProvider: 'keo' });
    const { createHandlers } = await import('../src/main/ipc/handlers');
    const handlers = createHandlers(h.services, { appInfo: () => ({ name: 'Keo', version: '0', electron: '', chrome: '', node: '', platform: '', packaged: false, testProviderEnabled: true }), openPath: async () => true, pickExecutable: async () => null, relaunch: () => undefined });
    const st = await handlers['account:signOut']({});
    expect(st.signedIn).toBe(false);
    expect(h.services.settings.get().ui.ownKeys).toBe(false);
    expect(h.services.settings.get().activeProvider).toBeNull();
  });

  it('an account opens ready to chat with Keo’s AI, unless it already uses a working provider of its own', async () => {
    await signedIn();
    h.services.settings.update({ activeProvider: null });
    h.services.start(); // Keo opening on this account (after sign-up, sign-in or switching)
    expect(h.services.settings.get().activeProvider).toBe('keo');
    // Someone who chose their own OpenAI key keeps it.
    h.services.secrets.set('openai', 'sk-test-not-real');
    h.services.settings.update({ activeProvider: 'openai', providers: { openai: { model: 'gpt-test' } } });
    h.services.useKeoIfNothingElse();
    expect(h.services.settings.get().activeProvider).toBe('openai');
  });

  it('tells the app when the signed-in account changes (so it opens that account’s own data)', async () => {
    await signedIn();
    expect(changes).toEqual(['11111111-1111-4111-8111-111111111111']);
    await h.services.account.fresh(); // token renewals are not a change
    await h.services.account.signOut();
    expect(changes).toEqual(['11111111-1111-4111-8111-111111111111', null]);
  });

  it('signs in by itself once the new account’s email is confirmed, without storing the password', async () => {
    const cloud = setup({ confirmPollMs: 20 });
    await h.services.account.signUp('ana@example.test', 'longpassword1');
    expect(h.services.account.status()).toMatchObject({ signedIn: false, waitingForConfirmation: true });
    await new Promise((r) => setTimeout(r, 80));
    expect(h.services.account.signedIn()).toBe(false); // not confirmed yet
    cloud.users.get('ana@example.test')!.confirmed = true; // the user clicks the email link
    const until = Date.now() + 3000;
    while (!h.services.account.signedIn() && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    expect(h.services.account.status()).toMatchObject({ signedIn: true, waitingForConfirmation: false, email: 'ana@example.test' });
    expect(changes).toEqual(['11111111-1111-4111-8111-111111111111']);
    expect(h.services.secrets.get('keo_account')).not.toContain('longpassword1');
    // It stops checking once signed in.
    const n = cloud.calls.filter((c) => c.includes('grant_type=password')).length;
    await new Promise((r) => setTimeout(r, 80));
    expect(cloud.calls.filter((c) => c.includes('grant_type=password')).length).toBe(n);
  });

  it('signing out forgets the session', async () => {
    const cloud = setup();
    cloud.confirmRequired = false;
    await h.services.account.signUp('ana@example.test', 'longpassword1');
    await h.services.account.signOut();
    expect(h.services.secrets.get('keo_account')).toBeNull();
    expect(cloud.calls).toContain('POST /auth/v1/logout');
  });
});
