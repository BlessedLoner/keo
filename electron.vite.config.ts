import fs from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

/**
 * Local builds (npm run dev / build on this PC) can include Keo's Google client too: put
 * KEO_GOOGLE_CLIENT_ID=… and KEO_GOOGLE_CLIENT_SECRET=… in .env.local (never committed). Release
 * builds get them from the GitHub secrets.
 */
const localEnv = resolve(__dirname, '.env.local');
for (const line of (fs.existsSync(localEnv) ? fs.readFileSync(localEnv, 'utf8') : '').split(/\r?\n/)) {
  const m = /^\s*(KEO_GOOGLE_CLIENT_(?:ID|SECRET))\s*=\s*(.*?)\s*$/.exec(line);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
}

const shared = { '@shared': resolve(__dirname, 'src/shared') };

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    // Keo's own Google OAuth client (see src/main/calendar/builtinClient.ts): from the build's
    // environment, never from the repo.
    define: {
      __KEO_GOOGLE_CLIENT_ID__: JSON.stringify(process.env.KEO_GOOGLE_CLIENT_ID ?? ''),
      __KEO_GOOGLE_CLIENT_SECRET__: JSON.stringify(process.env.KEO_GOOGLE_CLIENT_SECRET ?? ''),
    },
    resolve: { alias: shared },
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } },
    },
  },
  preload: {
    // The preload runs sandboxed: it may only require('electron'), so every
    // other import (zod, shared contracts) must be bundled into the file.
    resolve: { alias: shared },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias: shared },
    plugins: [react()],
    build: {
      minify: true,
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } },
    },
  },
});
