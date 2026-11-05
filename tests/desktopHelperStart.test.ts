import { describe, expect, it } from 'vitest';
import { waitForStart } from '../src/main/desktop/backend';

describe('desktop helper that starts slowly (first start after Windows boots)', () => {
  it('a call gives up while it is still starting, and a later call uses it once it is ready', async () => {
    let ready!: () => void;
    const start = new Promise<void>((r) => (ready = r));
    await expect(waitForStart(start, 20)).rejects.toMatchObject({ code: 'helper_start_timeout', retryable: true, dispatched: 'no' });
    ready();
    await expect(waitForStart(start, 20)).resolves.toBeUndefined();
  });

  it('a helper that could not start is reported as it is', async () => {
    const failed = Promise.reject(new Error('The desktop helper could not start.'));
    await expect(waitForStart(failed, 1000)).rejects.toThrow(/could not start/);
  });
});
