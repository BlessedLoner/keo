import { describe, expect, it } from 'vitest';
import { alertSubject, sendAlerts } from '../src/alerts';
import { Supabase, type Env } from '../src/gateway';

const base: Env = { SUPABASE_URL: 'https://db.test', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service-secret', OPENROUTER_API_KEY: 'or' };

function world(resendStatus = 200) {
  const alerts = [
    { id: 1, day: '2026-11-25', kind: 'near_openrouter', message: 'Keo’s AI spend today passed 80% of its $60 safety limit.', sent: false },
    { id: 2, day: '2026-11-25', kind: 'breaker_fal', message: 'Keo’s fal spend reached today’s safety limit of $60.', sent: false },
    { id: 3, day: '2026-11-24', kind: 'near_fal', message: 'old', sent: true },
  ];
  const emails: Array<{ auth: string | null; body: Record<string, unknown> }> = [];
  const fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    if (url.host === 'api.resend.com') {
      emails.push({ auth: new Headers(init.headers).get('authorization'), body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return new Response('{}', { status: resendStatus });
    }
    if (url.pathname === '/rest/v1/alerts') {
      if (init.method === 'PATCH') {
        const id = Number((url.searchParams.get('id') ?? '').replace('eq.', ''));
        Object.assign(alerts.find((a) => a.id === id)!, JSON.parse(String(init.body)));
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify(alerts.filter((a) => !a.sent)), { status: 200 });
    }
    return new Response('[]', { status: 404 });
  };
  return { alerts, emails, fetch };
}

describe('Alert emails to the owner', () => {
  it('sends each new alert once, from alerts@heykeo.com to the owner, then marks it sent', async () => {
    const w = world();
    const env = { ...base, RESEND_API_KEY: 're_test', ALERT_EMAIL: 'owner@example.test' };
    expect(await sendAlerts(env, new Supabase(env, w.fetch), w.fetch)).toBe(2);
    expect(w.emails).toHaveLength(2);
    expect(w.emails[0]).toMatchObject({ auth: 'Bearer re_test', body: { from: 'Keo Cloud <alerts@heykeo.com>', to: ['owner@example.test'], subject: 'Keo Cloud: AI spend is near today’s safety limit' } });
    expect(String(w.emails[1]!.body.subject)).toBe('Keo Cloud stopped Studio AI for today: safety limit reached');
    expect(w.alerts.every((a) => a.sent)).toBe(true);
    // The next run finds nothing new.
    expect(await sendAlerts(env, new Supabase(env, w.fetch), w.fetch)).toBe(0);
  });

  it('keeps an alert unsent when the email fails (it is tried again next time)', async () => {
    const w = world(500);
    const env = { ...base, RESEND_API_KEY: 're_test', ALERT_EMAIL: 'owner@example.test' };
    expect(await sendAlerts(env, new Supabase(env, w.fetch), w.fetch)).toBe(0);
    expect(w.alerts.filter((a) => !a.sent)).toHaveLength(2);
  });

  it('does nothing until the email key and address are set', async () => {
    const w = world();
    expect(await sendAlerts({ ...base, RESEND_API_KEY: 're_test' }, new Supabase(base, w.fetch), w.fetch)).toBe(0);
    expect(w.emails).toHaveLength(0);
    expect(alertSubject('breaker_openrouter')).toBe('Keo Cloud stopped AI calls for today: safety limit reached');
  });
});
