import crypto from 'node:crypto';
import http from 'node:http';
import type { Logger } from '../logging/logger';

/** Only the calendar's events: no Gmail, contacts or profile. */
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

export const GOOGLE_ENDPOINTS = {
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
};

export interface GoogleTokens {
  refreshToken: string;
  accessToken: string;
  /** ms since epoch. */
  expiresAt: number;
  /** When the user signed in (ms since epoch). */
  obtainedAt: number;
  scope: string;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface GoogleAuthDeps {
  clientId: () => string;
  clientSecret: () => string | null;
  load: () => GoogleTokens | null;
  save: (t: GoogleTokens) => void;
  clear: () => void;
  /** Opens the sign-in page in the user's default browser. */
  openBrowser: (url: string) => Promise<void>;
  fetch?: FetchLike;
  endpoints?: typeof GOOGLE_ENDPOINTS;
  log: Logger;
  now?: () => number;
  /** How long to wait for the user to finish in the browser. */
  signInTimeoutMs?: number;
}

/** Google ended the sign-in (revoked, password changed, or the 7-day limit for apps in "Testing"). */
export class GoogleSignInExpired extends Error {
  readonly code = 'calendar_signin_expired';
  constructor() {
    super(
      'Your Google sign-in has expired, so Keo cannot reach Google Calendar. Sign in again in Settings → Email & calendar. (Google ends sign-ins after 7 days while your Google Cloud app is in "Testing" status; publishing it to "In production" stops that.)',
    );
  }
}

export class GoogleNotSignedIn extends Error {
  readonly code = 'calendar_not_signed_in';
  constructor() {
    super('Google Calendar is not connected. The user can sign in with Google in Settings → Email & calendar.');
  }
}

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(crypto.randomBytes(48));
  return { verifier, challenge: b64url(crypto.createHash('sha256').update(verifier).digest()) };
}

/**
 * "Sign in with Google" for an installed app (RFC 8252): PKCE (S256), the
 * system browser, and a one-shot redirect listener on 127.0.0.1 with a
 * random port that accepts exactly one callback carrying the right state.
 * Tokens go to the secret store; none are logged or returned to the renderer.
 */
export class GoogleAuth {
  private readonly fetch: FetchLike;
  private readonly ep: typeof GOOGLE_ENDPOINTS;
  private pending: AbortController | null = null;
  private refreshing: Promise<string> | null = null;

  constructor(private readonly d: GoogleAuthDeps) {
    this.fetch = d.fetch ?? ((url, init) => fetch(url, init));
    this.ep = d.endpoints ?? GOOGLE_ENDPOINTS;
  }

  signedIn(): boolean {
    return !!this.d.load();
  }

  signingIn(): boolean {
    return !!this.pending;
  }

  obtainedAt(): number | null {
    return this.d.load()?.obtainedAt ?? null;
  }

  cancelSignIn(): void {
    this.pending?.abort();
  }

  async signIn(): Promise<void> {
    const clientId = this.d.clientId();
    if (!clientId) throw new Error('Add your Google OAuth client ID first (see the setup steps).');
    this.pending?.abort();
    const ac = new AbortController();
    this.pending = ac;
    const timer = setTimeout(() => ac.abort(), this.d.signInTimeoutMs ?? 5 * 60_000);
    const { verifier, challenge } = pkcePair();
    const state = b64url(crypto.randomBytes(24));
    const listener = await loopback(state, ac.signal);
    try {
      const url = new URL(this.ep.auth);
      url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: listener.redirectUri,
        response_type: 'code',
        scope: CALENDAR_SCOPE,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        access_type: 'offline',
        prompt: 'consent',
      }).toString();
      await this.d.openBrowser(url.toString());
      const code = await listener.code;
      const body = new URLSearchParams({ code, client_id: clientId, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: listener.redirectUri });
      const secret = this.d.clientSecret();
      if (secret) body.set('client_secret', secret);
      const r = await this.fetch(this.ep.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString(), signal: AbortSignal.timeout(30_000) });
      const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      if (!r.ok) throw new Error(tokenError(j));
      const t = tokensFrom(j, null, this.now());
      if (!t.refreshToken) throw new Error('Google did not return a lasting sign-in. Remove Keo from your Google account’s third-party access and sign in again.');
      if (!t.scope.split(' ').includes(CALENDAR_SCOPE)) throw new Error('Keo was not given access to your calendar events (the box on Google’s consent page was not ticked). Sign in again and allow calendar access.');
      this.d.save(t);
      this.d.log.info('calendar.signed_in', {});
    } catch (e) {
      if (ac.signal.aborted) throw new Error('Sign-in was cancelled or took too long.', { cause: e });
      throw e;
    } finally {
      clearTimeout(timer);
      listener.close();
      if (this.pending === ac) this.pending = null;
    }
  }

  /** A valid access token, refreshed when it is about to expire. */
  async accessToken(force = false): Promise<string> {
    const t = this.d.load();
    if (!t) throw new GoogleNotSignedIn();
    if (!force && t.expiresAt - this.now() > 60_000) return t.accessToken;
    this.refreshing ??= this.refresh(t).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async refresh(t: GoogleTokens): Promise<string> {
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refreshToken, client_id: this.d.clientId() });
    const secret = this.d.clientSecret();
    if (secret) body.set('client_secret', secret);
    const r = await this.fetch(this.ep.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString(), signal: AbortSignal.timeout(30_000) });
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) {
      if (j.error === 'invalid_grant' || j.error === 'unauthorized_client') {
        this.d.clear();
        this.d.log.warn('calendar.signin_expired', {});
        throw new GoogleSignInExpired();
      }
      throw new Error(`Google did not refresh the sign-in (${r.status}). Try again in a moment.`);
    }
    const next = tokensFrom(j, t, this.now());
    this.d.save(next);
    return next.accessToken;
  }

  /** Revokes the grant at Google (best effort) and forgets the tokens. */
  async signOut(): Promise<void> {
    const t = this.d.load();
    this.d.clear();
    this.d.log.info('calendar.signed_out', {});
    if (!t) return;
    try {
      await this.fetch(this.ep.revoke, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: t.refreshToken }).toString(), signal: AbortSignal.timeout(15_000) });
    } catch {
      /* the local tokens are gone either way */
    }
  }

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }
}

function tokensFrom(j: Record<string, unknown>, prev: GoogleTokens | null, now: number): GoogleTokens {
  const access = typeof j.access_token === 'string' ? j.access_token : '';
  if (!access) throw new Error('Google answered without an access token.');
  const expires = typeof j.expires_in === 'number' ? j.expires_in : 3600;
  return {
    accessToken: access,
    refreshToken: typeof j.refresh_token === 'string' ? j.refresh_token : (prev?.refreshToken ?? ''),
    expiresAt: now + expires * 1000,
    obtainedAt: prev?.obtainedAt ?? now,
    scope: typeof j.scope === 'string' ? j.scope : (prev?.scope ?? ''),
  };
}

export function tokenError(j: Record<string, unknown>): string {
  const e = typeof j.error === 'string' ? j.error : '';
  if (e === 'invalid_client') return 'Google did not accept the client ID (or client secret). Check them in the setup steps.';
  if (e === 'invalid_grant') return 'Google refused the sign-in code. Please try again.';
  const d = typeof j.error_description === 'string' ? j.error_description : '';
  // Google wants the client secret even with PKCE for "Desktop app" clients.
  if (/client_secret/i.test(d) || (e === 'invalid_request' && /secret/i.test(d))) return 'Google needs the client secret too: paste it next to the client ID (Google shows it with the client), then sign in again.';
  return `Google refused the sign-in${d ? `: ${d.slice(0, 160)}` : e ? ` (${e})` : ''}.`;
}

const PAGE = (title: string, text: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui,sans-serif;background:#111;color:#eee;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h1 style="font-weight:600">${title}</h1><p>${text}</p></div></body>`;

/**
 * Listens on 127.0.0.1 (never other interfaces) at a port the OS picks, for
 * one GET carrying the expected state. Anything else gets 404/400 and is
 * ignored; the listener closes after the first good callback.
 */
export async function loopback(state: string, signal: AbortSignal): Promise<{ redirectUri: string; code: Promise<string>; close(): void }> {
  let resolve!: (c: string) => void;
  let reject!: (e: Error) => void;
  const code = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  code.catch(() => undefined);
  let done = false;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method !== 'GET' || url.pathname !== '/' || done) {
      res.writeHead(404).end();
      return;
    }
    if (url.searchParams.get('state') !== state) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE('Keo', 'This sign-in link is not the one Keo started.'));
      return;
    }
    done = true;
    const err = url.searchParams.get('error');
    const c = url.searchParams.get('code');
    if (err || !c) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE('Not signed in', 'Google did not sign you in. You can close this tab and try again from Keo.'));
      reject(new Error(err === 'access_denied' ? 'You did not allow Keo to use your calendar.' : 'Google did not complete the sign-in.'));
    } else {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE('Keo is connected', 'You can close this tab and go back to Keo.'));
      resolve(c);
    }
  });
  await new Promise<void>((res, rej) => {
    server.once('error', rej);
    server.listen(0, '127.0.0.1', () => res());
  });
  const port = (server.address() as { port: number }).port;
  const onAbort = () => reject(new Error('cancelled'));
  signal.addEventListener('abort', onAbort, { once: true });
  return {
    redirectUri: `http://127.0.0.1:${port}`,
    code,
    close: () => {
      signal.removeEventListener('abort', onAbort);
      server.close();
      server.closeAllConnections?.();
    },
  };
}
