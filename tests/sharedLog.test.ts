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
    await new Promise((r) => setTimeout(r, 50));
    const file = path.join(resolveProfile(h.dir, { KEO_USER_DATA_DIR: h.dir }, false).logsDir, 'keo.log');
    expect(fs.readFileSync(file, 'utf8')).toContain('next.account_event');
    await (logger as Logger).close();
  });
});
