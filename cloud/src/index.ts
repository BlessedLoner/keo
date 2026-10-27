import { handle, type Env } from './gateway';

export default {
  fetch(req: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    return handle(req, env, { fetch: (input, init) => fetch(input, init), waitUntil: (p) => ctx.waitUntil(p) });
  },
};
