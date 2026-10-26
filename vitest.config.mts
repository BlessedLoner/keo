import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@shared': resolve(import.meta.dirname, 'src/shared') } },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    // Generous: the release build machine is slower than a desktop (PowerPoint, PDF and mail tests come close to 20 s there).
    testTimeout: 60000,
  },
});
