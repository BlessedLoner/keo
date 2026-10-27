import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@shared': resolve(import.meta.dirname, 'src/shared') } },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    // At most two test files at once: with more, slower PCs and build machines starve the
    // heavier tests (PDF, mail, briefing) and they time out although nothing is wrong.
    maxWorkers: 2,
    // Generous: the release build machine is slower than a desktop (PowerPoint, PDF and mail tests come close to 20 s there).
    testTimeout: 60000,
  },
});
