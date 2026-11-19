import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveProfile } from '../src/main/env/profile';
import { Logger } from '../src/main/logging/logger';
import { makeHarness } from './helpers';

describe('The app’s log across accounts', () => {
  it('stays open when one account’s services shut down (the next account keeps logging)', async () => {
    const h = makeHarness();
    const logger = h.services.log;
    await h.services.shutdown();
    // The next account's services write to the same log.
    logger.info('next.account_event', {});
    const file = path.join(resolveProfile(h.dir, { KEO_USER_DATA_DIR: h.dir }, false).logsDir, 'keo.log');
    // The log is written in the background: wait until the line is there (up to 3 s on a busy PC).
    const read = () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
    for (let i = 0; i < 60 && !read().includes('next.account_event'); i++) await new Promise((r) => setTimeout(r, 50));
    expect(read()).toContain('next.account_event');
    await (logger as Logger).close();
  });
});
