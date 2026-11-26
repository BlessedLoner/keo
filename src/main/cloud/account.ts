import { userIdOfToken } from '../env/accounts';
import type { AllowanceWindow, AccountStatus } from '../../shared/cloud';
import { KEO_CLOUD } from '../../shared/cloud';
import type { Logger } from '../logging/logger';
import type { SecretStore } from '../secrets/secretStore';
import { loopback, pkcePair, type LoopbackWords } from '../calendar/googleAuth';
import crypto from 'node:crypto';

/**
 * The user's Keo account: sign-up, sign-in, staying signed in, signing out — straight against
 * Supabase Auth's REST API (no SDK) — and their plan, today's usage and models from Keo Cloud.
 * The session (access + refresh token) is kept in the encrypted secret store; the password is
 * never stored.
 */
export type CloudFetch = (url: string, init?: RequestInit) => Promise<Response>;

interface Session {
  access: string;
  refresh: string;
  /** ms since epoch. */
  expiresAt: number;
  email: string;
  /** The Keo account's id (each account has its own data folder on this PC). */
  userId?: string;
}

/** After sign-up: Keo signs in by itself once the email is confirmed (password kept in memory only). */
const CONFIRM_POLL_MS = 15_000;
const CONFIRM_WAIT_MS = 30 * 60_000;

export interface CloudModel {
  id: string;
  label: string;
  vision: boolean;
  tools: boolean;
  contextTokens: number;
  maxOutputTokens: number;
}

export class AccountError extends Error {
  constructor(
    message: string,
    /** Keo Cloud's HTTP status (403: not in the plan, 429: today's allowance used up). */
    readonly status = 0,
    readonly code = '',
  ) {
    super(message);
  }
}

/** A web search result from Keo Cloud. */
export interface CloudSearchResult {
  title: string;
  url: string;
  description: string;
  age: string | null;
}

export class KeoAccount {
  private session: Session | null;
  private pendingEmail: string | null = null;
  private refreshing: Promise<void> | null = null;
  private me: { plan: AccountStatus['plan']; usage: AccountStatus['usage']; billing: AccountStatus['billing']; at: number } | null = null;
  private modelList: CloudModel[] = [];
  private lastError: string | null = null;
  private timer: NodeJS.Timeout | null = null;

  private waiting: { email: string; password: string; until: number; timer: NodeJS.Timeout } | null = null;
  /** "Continue with Google" in progress (the browser is open). */
  private google: AbortController | null = null;

  constructor(
    private readonly d: {
      secrets: SecretStore;
      log: Logger;
      fetch?: CloudFetch;
      now?: () => number;
      config?: typeof KEO_CLOUD;
      changed?: () => void;
      /** Another account (or none) is now signed in: Keo switches to that account's own data. */
      accountChanged?: (userId: string | null) => void;
      /** How often to check whether a new account's email is confirmed (tests: faster). */
      confirmPollMs?: number;
      /** Opens a page in the user's own browser ("Continue with Google"). */
      openBrowser?: (url: string) => Promise<void>;
      /** How long "Continue with Google" waits for the browser (default 5 minutes). */
      googleTimeoutMs?: number;
    },
  ) {
    this.session = this.load();
  }

  /** The signed-in account's id. */
  userId(): string | null {
    const s = this.session;
    return s ? (s.userId ?? userIdOfToken(s.access)) : null;
  }

  private get cfg() {
    return this.d.config ?? KEO_CLOUD;
  }
  private now() {
    return this.d.now?.() ?? Date.now();
  }
  private f(url: string, init?: RequestInit) {
    return (this.d.fetch ?? ((u, i) => fetch(u, i)))(url, init);
  }

  private load(): Session | null {
    try {
      const raw = this.d.secrets.get('keo_account');
      const s = raw ? (JSON.parse(raw) as Session) : null;
      return s?.access && s.refresh ? s : null;
    } catch {
      return null;
    }
  }

  private save(s: Session | null): void {
    const before = this.userId();
    this.session = s;
    if (s) this.d.secrets.set('keo_account', JSON.stringify(s));
    else this.d.secrets.delete('keo_account');
    if (s) this.stopWaiting();
    this.d.changed?.();
    const after = this.userId();
    if (before !== after) this.d.accountChanged?.(after);
  }

  /** Keo Cloud's gateway address (…/v1). */
  gatewayUrl(): string {
    return this.cfg.gatewayUrl;
  }

  /** The Studio credits left (Keo Studio's AI is paid with them), and the credit packs. */
  async studioCredits(): Promise<{ monthlyAllowance: number; monthlyLeft: number; bought: number; total: number; ready: boolean; plan: string; trialGiven?: number }> {
    return this.gateway('/studio/credits');
  }

  /** What the Studio credits went on (the last 100 AI requests). */
  async studioHistory(): Promise<{ items: Array<{ what: string; credits: number; refunded: boolean; at: string }> }> {
    return this.gateway('/studio/history');
  }

  /** The user's invite code and what it earned. */
  async referral(): Promise<{ code: string | null; credits: number; joined: number; earned: number; referred: boolean }> {
    return this.gateway('/studio/referral');
  }

  /** A friend's invite code (new accounts): both get Studio credits. */
  async redeemReferral(code: string): Promise<{ credits: number }> {
    return this.gateway('/studio/referral/redeem', { code });
  }

  signedIn(): boolean {
    return !!this.session;
  }

  /** The current access token (refreshed in the background; `fresh()` before a request makes sure). */
  token(): string | null {
    return this.session?.access ?? null;
  }

  /** Keeps the session fresh: checks every few minutes while Keo runs. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.fresh().catch(() => undefined), 5 * 60_000);
    this.timer.unref?.();
    if (this.session) void this.refreshMe().catch(() => undefined);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopWaiting();
  }

  private async auth(path: string, body: Record<string, unknown>, opts: { emailLink?: boolean } = {}): Promise<Record<string, unknown>> {
    let r: Response;
    // Emails (confirm, new password) link to Keo's account page, whatever Supabase's Site URL says.
    const link = opts.emailLink ? `${path.includes('?') ? '&' : '?'}redirect_to=${encodeURIComponent(this.cfg.accountPageUrl)}` : '';
    try {
      r = await this.f(`${this.cfg.supabaseUrl}/auth/v1/${path}${link}`, { method: 'POST', headers: { apikey: this.cfg.anonKey, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    } catch {
      throw new AccountError('Keo could not reach its servers. Check your internet connection.');
    }
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) throw new AccountError(friendly(j, r.status));
    return j;
  }

  private fromTokens(j: Record<string, unknown>, email: string): Session {
    const access = String(j.access_token ?? '');
    const refresh = String(j.refresh_token ?? '');
    if (!access || !refresh) throw new AccountError('Keo’s servers did not return a sign-in. Please try again.');
    const expiresIn = Number(j.expires_in) || 3600;
    const userId = (j.user as { id?: unknown } | undefined)?.id;
    return { access, refresh, expiresAt: this.now() + expiresIn * 1000, email, ...(typeof userId === 'string' ? { userId } : userIdOfToken(access) ? { userId: userIdOfToken(access)! } : {}) };
  }

  /** Creates an account. Usually the user must confirm their email first (then sign in). */
  async signUp(email: string, password: string): Promise<{ needsConfirmation: boolean }> {
    const e = email.trim().toLowerCase();
    const j = await this.auth('signup', { email: e, password }, { emailLink: true });
    if (j.access_token) {
      this.save(this.fromTokens(j, e));
      this.pendingEmail = null;
      await this.refreshMe().catch(() => undefined);
      return { needsConfirmation: false };
    }
    this.pendingEmail = e;
    this.d.log.info('account.signed_up', {});
    this.waitForConfirmation(e, password);
    this.d.changed?.();
    return { needsConfirmation: true };
  }

  /**
   * Until the new account's email is confirmed (in the browser, maybe on a phone), Keo quietly
   * tries to sign in every few seconds, so the user never has to sign in again by hand. The
   * password stays in memory only, and only for 30 minutes.
   */
  private waitForConfirmation(email: string, password: string): void {
    this.stopWaiting();
    const timer = setInterval(() => void this.tryConfirmed(), this.d.confirmPollMs ?? CONFIRM_POLL_MS);
    timer.unref?.();
    this.waiting = { email, password, until: this.now() + CONFIRM_WAIT_MS, timer };
  }

  private stopWaiting(): void {
    if (this.waiting) clearInterval(this.waiting.timer);
    this.waiting = null;
  }

  private checking = false;
  private async tryConfirmed(): Promise<void> {
    const w = this.waiting;
    if (!w || this.checking || this.session) return;
    if (this.now() > w.until) return this.stopWaiting();
    this.checking = true;
    try {
      await this.signIn(w.email, w.password);
      this.d.log.info('account.confirmed_signed_in', {});
    } catch (e) {
      // Not confirmed yet: keep waiting. Anything else (wrong password, account gone): stop.
      if (!/Confirm your email first|reach its servers|Too many tries/.test((e as Error).message)) this.stopWaiting();
    } finally {
      this.checking = false;
    }
  }

  async signIn(email: string, password: string): Promise<void> {
    const e = email.trim().toLowerCase();
    if (this.waiting && this.waiting.email !== e) this.stopWaiting();
    const j = await this.auth('token?grant_type=password', { email: e, password });
    this.save(this.fromTokens(j, e));
    this.pendingEmail = null;
    this.d.log.info('account.signed_in', {});
    await this.refreshMe().catch(() => undefined);
  }

  /**
   * "Continue with Google" — for new and returning users alike. Supabase's Google sign-in in the
   * user's own browser (RFC 8252): PKCE (S256) and a one-shot listener on 127.0.0.1 that accepts
   * one callback carrying Keo's state. The one-time code is exchanged for a session here; no
   * password exists, and nothing is logged.
   */
  async signInWithGoogle(): Promise<void> {
    const open = this.d.openBrowser;
    if (!open) throw new AccountError('Signing in with Google works only in the Keo app.');
    let on: boolean;
    try {
      const r = await this.f(`${this.cfg.supabaseUrl}/auth/v1/settings`, { headers: { apikey: this.cfg.anonKey } });
      on = !!((await r.json().catch(() => ({}))) as { external?: { google?: boolean } }).external?.google;
    } catch {
      throw new AccountError('Keo could not reach its servers. Check your internet connection.');
    }
    if (!on) throw new AccountError('Signing in with Google is not switched on yet. Use your email for now.');

    this.google?.abort();
    const ac = new AbortController();
    this.google = ac;
    this.d.changed?.();
    const timer = setTimeout(() => ac.abort(), this.d.googleTimeoutMs ?? 5 * 60_000);
    const { verifier, challenge } = pkcePair();
    const state = crypto.randomBytes(24).toString('base64url');
    let listener: Awaited<ReturnType<typeof loopback>> | null = null;
    try {
      listener = await loopback(state, ac.signal, GOOGLE_WORDS);
      const back = `${listener.redirectUri}/?state=${state}`;
      const url = new URL(`${this.cfg.supabaseUrl}/auth/v1/authorize`);
      url.search = new URLSearchParams({ provider: 'google', redirect_to: back, code_challenge: challenge, code_challenge_method: 's256', scopes: 'email profile' }).toString();
      await open(url.toString());
      let code: string;
      try {
        code = await listener.code;
      } catch (e) {
        if (ac.signal.aborted) throw new AccountError(this.google === ac ? 'Google sign-in took too long. Try again.' : 'Google sign-in was cancelled.');
        throw new AccountError((e as Error).message);
      }
      const j = await this.auth('token?grant_type=pkce', { auth_code: code, code_verifier: verifier });
      const email = String((j.user as { email?: unknown } | undefined)?.email ?? '').toLowerCase();
      if (this.waiting) this.stopWaiting();
      this.save(this.fromTokens(j, email));
      this.pendingEmail = null;
      this.d.log.info('account.signed_in', { with: 'google' });
      await this.refreshMe().catch(() => undefined);
    } finally {
      clearTimeout(timer);
      listener?.close();
      if (this.google === ac) this.google = null;
      this.d.changed?.();
    }
  }

  /** Stops waiting for the browser ("Cancel" while signing in with Google). */
  cancelGoogle(): void {
    const ac = this.google;
    this.google = null;
    ac?.abort();
  }

  /** Emails a password-reset link. */
  async resetPassword(email: string): Promise<void> {
    await this.auth('recover', { email: email.trim().toLowerCase() }, { emailLink: true });
  }

  async signOut(): Promise<void> {
    const s = this.session;
    this.save(null);
    this.me = null;
    this.modelList = [];
    if (s) await this.f(`${this.cfg.supabaseUrl}/auth/v1/logout`, { method: 'POST', headers: { apikey: this.cfg.anonKey, authorization: `Bearer ${s.access}` } }).catch(() => undefined);
    this.d.log.info('account.signed_out', {});
  }

  /** Makes sure the access token is valid for at least two more minutes. */
  async fresh(): Promise<void> {
    const s = this.session;
    if (!s || s.expiresAt - this.now() > 120_000) return;
    this.refreshing ??= (async () => {
      try {
        const j = await this.auth('token?grant_type=refresh_token', { refresh_token: s.refresh });
        this.save(this.fromTokens(j, s.email));
      } catch (e) {
        // A refresh token Supabase no longer accepts: the user has to sign in again.
        if (e instanceof AccountError && !/reach its servers/.test(e.message)) {
          this.d.log.warn('account.session_ended', {});
          this.save(null);
        }
        throw e;
      } finally {
        this.refreshing = null;
      }
    })();
    await this.refreshing;
  }

  private async gateway<T>(path: string, body?: unknown): Promise<T> {
    await this.fresh();
    const t = this.token();
    if (!t) throw new AccountError('Sign in to your Keo account.');
    let r: Response;
    try {
      r = await this.f(`${this.cfg.gatewayUrl}${path}`, body === undefined ? { headers: { authorization: `Bearer ${t}` } } : { method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    } catch {
      throw new AccountError('Keo could not reach Keo Cloud. Check your internet connection.');
    }
    const j = (await r.json().catch(() => ({}))) as { error?: { message?: string } };
    if (!r.ok) throw new AccountError(j.error?.message ?? `Keo Cloud answered ${r.status}.`);
    return j as T;
  }

  /** A request to one of Keo Cloud's services (search, pictures, voice) with the user's sign-in. */
  private async post(path: string, body: unknown, signal: AbortSignal): Promise<Response> {
    await this.fresh();
    const t = this.token();
    if (!t) throw new AccountError('Sign in to your Keo account first (Settings → Providers).');
    let r: Response;
    try {
      r = await this.f(`${this.cfg.gatewayUrl}${path}`, { method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
    } catch (e) {
      if (signal.aborted) throw e;
      throw new AccountError('Keo could not reach Keo Cloud. Check your internet connection.');
    }
    if (!r.ok) {
      const j = (await r.json().catch(() => ({}))) as { error?: { message?: string; code?: string } };
      throw new AccountError(j.error?.message ?? `Keo Cloud answered ${r.status}.`, r.status, j.error?.code ?? '');
    }
    this.refreshSoon();
    return r;
  }

  /**
   * The Upgrade page for this account: Keo's plans and payment page in the browser, signed in
   * with a 30-minute billing ticket (it allows billing only, never Keo's AI).
   */
  async upgradeUrl(signal: AbortSignal, go?: 'topup'): Promise<string> {
    const r = await this.post('/billing/ticket', {}, signal);
    const j = (await r.json().catch(() => ({}))) as { ticket?: string };
    if (!j.ticket) throw new AccountError('Keo Cloud did not open the Upgrade page. Please try again.');
    return `${this.cfg.upgradePageUrl}#t=${encodeURIComponent(j.ticket)}${go ? `&go=${go}` : ''}`;
  }

  /** A call to one of Keo Cloud's JSON endpoints (path after /v1), its answer as JSON. */
  async call(path: string, body: unknown, signal: AbortSignal): Promise<unknown> {
    if (!/^\/[a-z0-9/_-]{1,60}$/.test(path)) throw new AccountError('Not a Keo Cloud endpoint.');
    const r = await this.post(path, body, signal);
    return r.json().catch(() => ({}));
  }

  /** A problem report (the text the user saw and agreed to send). Returns its reference. */
  async report(o: { message: string; report: string; version: string }, signal: AbortSignal): Promise<string> {
    const r = await this.post('/report', o, signal);
    const j = (await r.json().catch(() => ({}))) as { id?: string };
    return typeof j.id === 'string' ? j.id : '';
  }

  /** Web search through Keo Cloud (counts toward the plan's daily searches). */
  async search(query: string, count: number, signal: AbortSignal): Promise<CloudSearchResult[]> {
    const r = await this.post('/search', { query, count }, signal);
    const j = (await r.json().catch(() => ({}))) as { results?: CloudSearchResult[] };
    return Array.isArray(j.results) ? j.results : [];
  }

  /** A new picture, or a changed copy of `image` (counts toward the plan's daily pictures). */
  async image(o: { prompt: string; size: string; quality: string; background: string; image?: { data: Buffer; type: string } }, signal: AbortSignal): Promise<{ bytes: Buffer; mediaType: string }> {
    const { image, ...rest } = o;
    const r = await this.post('/images', { ...rest, ...(image ? { image: { data: image.data.toString('base64'), type: image.type } } : {}) }, signal);
    const j = (await r.json().catch(() => ({}))) as { b64?: string; mediaType?: string };
    if (!j.b64) throw new AccountError('Keo Cloud returned no picture.');
    return { bytes: Buffer.from(j.b64, 'base64'), mediaType: j.mediaType ?? 'image/png' };
  }

  /** Text read aloud in Keo's voice (a WAV file). */
  async speak(text: string, voice: 'female' | 'male', signal: AbortSignal): Promise<{ audio: Uint8Array; mimeType: string }> {
    const r = await this.post('/speech', { text, voice }, signal);
    return { audio: new Uint8Array(await r.arrayBuffer()), mimeType: r.headers.get('content-type') ?? 'audio/wav' };
  }

  /** A WAV recording turned into text. */
  async transcribe(wav: Uint8Array, language: string, signal: AbortSignal, hint = ''): Promise<string> {
    const r = await this.post('/transcribe', { audio: Buffer.from(wav).toString('base64'), format: 'wav', language, ...(hint ? { hint } : {}) }, signal);
    const j = (await r.json().catch(() => ({}))) as { text?: string };
    return j.text ?? '';
  }

  /** Reads the plan, today's usage and the plan's models from Keo Cloud. */
  async refreshMe(): Promise<void> {
    try {
      const me = await this.gateway<{
        plan: { id: string; name: string; daily_requests: number; daily_tokens: number; features: Record<string, unknown> };
        usage: { day: string; requests: number; input_tokens: number; output_tokens: number; web_searches?: number; images?: number; voice_seconds?: number; allowanceUsed?: number; monthUsed?: number; windows?: AllowanceWindow[]; buildsLeft?: Record<string, { now: number; month: number }>; topup?: { buildsLeft: Record<string, number>; tasksLeft: number } | null };
        billing?: { until: string | null; status: string } | null;
      }>('/me');
      this.me = {
        plan: { id: me.plan.id, name: me.plan.name, dailyRequests: me.plan.daily_requests, dailyTokens: me.plan.daily_tokens, features: me.plan.features ?? {} },
        usage: {
          day: me.usage.day,
          requests: me.usage.requests,
          inputTokens: me.usage.input_tokens,
          outputTokens: me.usage.output_tokens,
          webSearches: me.usage.web_searches ?? 0,
          images: me.usage.images ?? 0,
          voiceSeconds: me.usage.voice_seconds ?? 0,
          ...(typeof me.usage.allowanceUsed === 'number' ? { allowanceUsed: me.usage.allowanceUsed } : {}),
          ...(typeof me.usage.monthUsed === 'number' ? { monthUsed: me.usage.monthUsed } : {}),
          ...(Array.isArray(me.usage.windows) ? { windows: me.usage.windows.filter((w) => w && (w.window === 'day' || w.window === 'week' || w.window === 'month')) } : {}),
          ...(me.usage.buildsLeft && typeof me.usage.buildsLeft === 'object' ? { buildsLeft: me.usage.buildsLeft } : {}),
          ...(me.usage.topup && typeof me.usage.topup === 'object' ? { topup: me.usage.topup } : {}),
        },
        billing: me.billing ?? null,
        at: this.now(),
      };
      const models = await this.gateway<{ data: Array<{ id: string; keo?: { label?: string; vision?: boolean; tools?: boolean; contextTokens?: number; maxOutputTokens?: number } }> }>('/models');
      this.modelList = models.data.map((m) => ({
        id: m.id,
        label: m.keo?.label ?? m.id,
        vision: m.keo?.vision ?? true,
        tools: m.keo?.tools ?? true,
        contextTokens: m.keo?.contextTokens ?? 128000,
        maxOutputTokens: m.keo?.maxOutputTokens ?? 8192,
      }));
      this.lastError = null;
    } catch (e) {
      this.lastError = (e as Error).message;
      throw e;
    } finally {
      this.d.changed?.();
    }
  }

  private lastRefresh = 0;
  /** Reads plan and usage again, at most every 30 s (after model calls). */
  refreshSoon(): void {
    if (this.now() - this.lastRefresh < 30_000) return;
    this.lastRefresh = this.now();
    void this.refreshMe().catch(() => undefined);
  }

  models(): CloudModel[] {
    return this.modelList;
  }

  status(): AccountStatus {
    return {
      signedIn: !!this.session,
      email: this.session?.email ?? null,
      pendingEmail: this.pendingEmail,
      waitingForConfirmation: !!this.waiting && !this.session,
      signingInWithGoogle: !!this.google,
      plan: this.me?.plan ?? null,
      usage: this.me?.usage ?? null,
      billing: this.me?.billing ?? null,
      error: this.session ? this.lastError : null,
    };
  }
}

/** The browser tab after "Continue with Google", and what Keo says if it did not work. */
const GOOGLE_WORDS: LoopbackWords = {
  doneTitle: 'You’re signed in to Keo',
  doneText: 'You can close this tab and go back to Keo.',
  failedText: 'Google did not sign you in. You can close this tab and try again from Keo.',
  denied: 'Google sign-in was cancelled.',
  failed: 'Google did not complete the sign-in.',
};

/** Supabase's error, in plain words. */
function friendly(j: Record<string, unknown>, status: number): string {
  const code = String(j.error_code ?? j.code ?? j.error ?? '');
  const msg = String(j.msg ?? j.error_description ?? j.message ?? '');
  if (/invalid_credentials|invalid login/i.test(code + msg)) return 'The email or password is not right.';
  if (/email_not_confirmed/i.test(code + msg)) return 'Confirm your email first: open the link Keo sent you, then sign in.';
  if (/user_already_exists|already registered/i.test(code + msg)) return 'There is already a Keo account with this email. Sign in instead.';
  if (/weak_password|password should be/i.test(code + msg)) return 'Choose a longer password (at least 8 characters, with letters and numbers).';
  if (/over_email_send_rate_limit|rate limit/i.test(code + msg) || status === 429) return 'Too many tries just now. Wait a minute and try again.';
  if (/invalid.*refresh|refresh_token_not_found|session_not_found/i.test(code + msg)) return 'Your Keo sign-in has ended. Sign in again.';
  if (/email.*invalid|validation_failed/i.test(code + msg)) return 'That email address does not look right.';
  return msg ? `Keo’s servers said: ${msg.slice(0, 160)}` : `Keo’s servers answered ${status}.`;
}
