import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { KeoAccount } from '../src/main/cloud/account';
import { Logger } from '../src/main/logging/logger';
import type { SecretStore } from '../src/main/secrets/secretStore';
import { KEO_CLOUD } from '../src/shared/cloud';

/**
 * "Continue with Google" for the Keo account, against a fake Supabase and a fake Google: the
 * "browser" follows the redirect to Keo's own one-shot listener on 127.0.0.1. Nothing leaves
 * this computer.
 */
const SUPA = KEO_CLOUD.supabaseUrl;
const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function fakeSecrets(): SecretStore {
  const m = new Map<string, string>();
  return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => void m.set(k, v), delete: (k: string) => void m.delete(k), has: (k: string) => m.has(k) } as unknown as SecretStore;
}

function setup(o: { googleOn?: boolean; browser?: (authorize: URL, back: URL) => Promise<void>; timeoutMs?: number } = {}) {
  const calls: string[] = [];
  const exchanged: Array<Record<string, string>> = [];
  const opened: string[] = [];
  const fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(url);
    const j = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
    calls.push(`${init.method ?? 'GET'} ${u.pathname}${u.search}`);
    if (u.pathname === '/auth/v1/settings') return j(200, { external: { email: true, google: o.googleOn ?? true } });
    if (u.pathname === '/auth/v1/token' && u.searchParams.get('grant_type') === 'pkce') {
      const body = JSON.parse(String(init.body)) as Record<string, string>;
      exchanged.push(body);
      if (body.auth_code !== 'one-time-code') return j(400, { error_code: 'flow_state_not_found', msg: 'invalid flow state' });
      return j(200, { access_token: 'g-access', refresh_token: 'g-refresh', expires_in: 3600, user: { id: '22222222-2222-4222-8222-222222222222', email: 'Ada@Gmail.test' } });
    }
    if (u.pathname === '/v1/me') return j(200, { user: { id: 'u2' }, plan: { id: 'free', name: 'Free', daily_requests: 60, daily_tokens: 300000, features: {} }, usage: { day: '2026-11-26', requests: 0, input_tokens: 0, output_tokens: 0 } });
    if (u.pathname === '/v1/models') return j(200, { data: [] });
    return j(404, {});
  };
  // Google (faked) signs the user in, then Supabase sends the browser back with a one-time code.
  const browser =
    o.browser ??
    (async (_authorize: URL, back: URL) => {
      back.searchParams.set('code', 'one-time-code');
      await globalThis.fetch(back);
    });
  const account = new KeoAccount({
    secrets: fakeSecrets(),
    log: new Logger(null),
    fetch,
    googleTimeoutMs: o.timeoutMs ?? 10_000,
    openBrowser: async (url) => {
      opened.push(url);
      const authorize = new URL(url);
      const back = new URL(authorize.searchParams.get('redirect_to')!);
      // Like a real browser: the page loads after Keo has moved on to waiting.
      setTimeout(() => void browser(authorize, back).catch(() => undefined), 10);
    },
  });
  return { account, calls, exchanged, opened };
}

describe('Continue with Google (Keo account)', () => {
  it('opens Keo’s Google sign-in with PKCE and a 127.0.0.1 return, swaps the one-time code and signs in', async () => {
    const t = setup();
    await t.account.signInWithGoogle();

    expect(t.opened).toHaveLength(1);
    const a = new URL(t.opened[0]!);
    expect(`${a.origin}${a.pathname}`).toBe(`${SUPA}/auth/v1/authorize`);
    expect(a.searchParams.get('provider')).toBe('google');
    expect(a.searchParams.get('code_challenge_method')).toBe('s256');
    const back = new URL(a.searchParams.get('redirect_to')!);
    expect(back.hostname).toBe('127.0.0.1');
    expect(back.searchParams.get('state')).toMatch(/^[\w-]{20,}$/);

    // The verifier sent with the code matches the challenge in the browser link.
    expect(t.exchanged).toHaveLength(1);
    expect(t.exchanged[0]!.auth_code).toBe('one-time-code');
    expect(b64url(crypto.createHash('sha256').update(t.exchanged[0]!.code_verifier!).digest())).toBe(a.searchParams.get('code_challenge'));

    expect(t.account.status()).toMatchObject({ signedIn: true, email: 'ada@gmail.test', signingInWithGoogle: false });
    expect(t.account.token()).toBe('g-access');
    expect(t.account.userId()).toBe('22222222-2222-4222-8222-222222222222');
  });

  it('says so, and opens nothing, when Google sign-in is not switched on in Supabase', async () => {
    const t = setup({ googleOn: false });
    await expect(t.account.signInWithGoogle()).rejects.toThrow(/not switched on yet/);
    expect(t.opened).toHaveLength(0);
    expect(t.account.status().signedIn).toBe(false);
  });

  it('ignores a return that does not carry Keo’s state, and still finishes with the right one', async () => {
    let refused = 0;
    const t = setup({
      browser: async (_a, back) => {
        const wrong = new URL(back);
        wrong.searchParams.set('state', 'someone-else');
        wrong.searchParams.set('code', 'stolen-code');
        refused = (await globalThis.fetch(wrong)).status;
        back.searchParams.set('code', 'one-time-code');
        await globalThis.fetch(back);
      },
    });
    await t.account.signInWithGoogle();
    expect(refused).toBe(400);
    expect(t.exchanged.map((e) => e.auth_code)).toEqual(['one-time-code']);
    expect(t.account.status().signedIn).toBe(true);
  });

  it('reports a refusal from Google in plain words and stays signed out', async () => {
    const t = setup({
      browser: async (_a, back) => {
        back.searchParams.set('error', 'access_denied');
        back.searchParams.set('error_description', 'The user cancelled');
        await globalThis.fetch(back);
      },
    });
    await expect(t.account.signInWithGoogle()).rejects.toThrow('Google sign-in was cancelled.');
    expect(t.exchanged).toHaveLength(0);
    expect(t.account.status()).toMatchObject({ signedIn: false, signingInWithGoogle: false });
  });

  it('shows that it is waiting for the browser, and Cancel stops it', async () => {
    const t = setup({ browser: async () => undefined });
    const run = t.account.signInWithGoogle();
    const caught = run.catch((e: Error) => e);
    await new Promise((r) => setTimeout(r, 50));
    expect(t.account.status().signingInWithGoogle).toBe(true);
    t.account.cancelGoogle();
    expect(((await caught) as Error).message).toBe('Google sign-in was cancelled.');
    expect(t.account.status()).toMatchObject({ signedIn: false, signingInWithGoogle: false });
  });

  it('gives up after the wait time with a clear message', async () => {
    const t = setup({ browser: async () => undefined, timeoutMs: 150 });
    await expect(t.account.signInWithGoogle()).rejects.toThrow('Google sign-in took too long. Try again.');
    expect(t.account.status().signingInWithGoogle).toBe(false);
  });
});
