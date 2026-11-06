import { describe, expect, it } from 'vitest';
import { CrashGuard } from '../src/main/crashGuard';
import { buildReport, REPORT_MAX_CHARS, scrubPersonal } from '../src/shared/problemReport';

describe('problem reports', () => {
  it('takes personal details out', () => {
    const home = 'C:\\Users\\anita';
    const s = scrubPersonal(
      'file C:\\Users\\anita\\Videos\\x.mp4 and C:/Users/anita/Documents, json "C:\\\\Users\\\\anita\\\\a.png"; mail anita@example.com; call +234 801 234 5678; key sk-abcdefghijklmnop1234; https://site.test/page?token=abc&x=1; version 1.18.1; 2026-11-05T10:00:00Z',
      home,
    );
    expect(s).not.toMatch(/anita/i);
    expect(s).toContain('C:\\Users\\<you>\\Videos');
    expect(s).toContain('C:/Users/<you>/Documents');
    expect(s).toContain('<email>');
    expect(s).toContain('<number>');
    expect(s).toContain('<key>');
    expect(s).toContain('https://site.test/page?<query>');
    // Versions and times stay readable.
    expect(s).toContain('version 1.18.1');
    expect(s).toContain('2026-11-05T10:00:00Z');
  });

  it('is the user’s words, the version and the log (when they agree), and stays under the size limit', () => {
    const r = buildReport({
      message: 'Captions stopped half way.',
      env: { version: '1.18.1', platform: 'win32', electron: '44.7.2', home: 'C:\\Users\\anita' },
      logs: [{ ts: '2026-11-05T10:00:00Z', level: 'warn', event: 'studio.transcribe_failed', data: { file: 'C:\\Users\\anita\\pod.mp4' } }],
      now: new Date('2026-11-05T11:00:00Z'),
    });
    expect(r).toContain('Captions stopped half way.');
    expect(r).toContain('Keo 1.18.1 on win32, Electron 44.7.2');
    expect(r).toContain('WARN studio.transcribe_failed');
    expect(r).not.toMatch(/anita/i);
    expect(buildReport({ message: 'x', env: { version: '1', platform: 'win32' } })).toContain('Recent activity: not included.');
    const many = Array.from({ length: 4000 }, (_, i) => ({ ts: `t${i}`, level: 'info', event: `event.number_${i}`, data: { pad: 'x'.repeat(60) } }));
    const big = buildReport({ message: 'x', env: { version: '1', platform: 'win32' }, logs: many });
    expect(big.length).toBeLessThanOrEqual(REPORT_MAX_CHARS);
    expect(big).toContain('event.number_3999');
    expect(big).toContain('(older events left out)');
  });
});

describe('a window whose page stops', () => {
  it('is reloaded, but not over and over', () => {
    const g = new CrashGuard(3, 10 * 60_000);
    expect(g.gone('clean-exit', 0)).toBe('ignore');
    expect(g.gone('crashed', 1000)).toBe('reload');
    expect(g.gone('oom', 2000)).toBe('reload');
    expect(g.gone('crashed', 3000)).toBe('reload');
    expect(g.gone('crashed', 4000)).toBe('give-up');
    // Ten minutes later it may reload again.
    expect(g.gone('crashed', 3000 + 10 * 60_000 + 1)).toBe('reload');
  });
});
