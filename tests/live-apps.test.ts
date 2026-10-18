import { expect, it } from 'vitest';
import { AppDiscovery } from '../src/main/desktop/appDiscovery';
import { installedBrowsers } from '../src/main/desktop/browserProfiles';

/**
 * Manual, read-only check on Windows: Keo's app discovery and browser profile
 * lookup against this PC (nothing is launched).
 * KEO_LIVE_APPS=1 npx vitest run tests/live-apps.test.ts
 */
it.runIf(process.env.KEO_LIVE_APPS === '1')('discovers real Windows apps and browser profiles', async () => {
  const d = new AppDiscovery();
  const apps = await d.list();
  const calc = (await d.find('calculator'))[0];
  const browsers = installedBrowsers();
  console.log(JSON.stringify({ apps: apps.length, store: apps.filter((a) => a.kind === 'store').length, calculator: calc?.app.kind, browsers: browsers.map((b) => `${b.id}:${b.profiles.length}`) }));
  expect(apps.length).toBeGreaterThan(10);
  expect(calc?.app.kind).toBe('store');
}, 60000);

it.runIf(process.env.KEO_LIVE_APPS === '1')('reads publishers of Store apps', async () => {
  const d = new AppDiscovery();
  const calc = (await d.find('calculator'))[0]?.app;
  const wa = (await d.list()).find((a) => a.appId.includes('WhatsAppDesktop'));
  console.log(JSON.stringify({ calculator: calc?.publisher, whatsapp: wa?.publisher ?? null }));
  expect(calc?.publisher).toMatch(/Microsoft/);
}, 90000);
