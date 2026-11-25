import { sendAlerts } from './alerts';
import { handle, Supabase, type Env } from './gateway';

export default {
  fetch(req: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    return handle(req, env, { fetch: (input, init) => fetch(input, init), waitUntil: (p) => ctx.waitUntil(p) });
  },
  // Every 10 minutes (wrangler.toml [triggers]): email the owner any new alerts.
  scheduled(_event: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): void {
    const f = (input: string, init?: RequestInit) => fetch(input, init);
    ctx.waitUntil(sendAlerts(env, new Supabase(env, f), f));
  },
};
