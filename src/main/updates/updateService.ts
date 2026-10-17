import { compareVersions, LINKS, RELEASE } from '../../shared/release';
import type { UpdateInfo } from '../../shared/domain';
import type { Logger } from '../logging/logger';

type Fetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const DAY = 24 * 60 * 60 * 1000;

/**
 * Checks GitHub Releases for a newer Keo (at most once a day unless asked).
 * Sends nothing but a plain HTTPS request for the public release listing;
 * downloading and installing stay the user's choice.
 */
export class UpdateService {
  private last: { at: number; info: UpdateInfo } | null = null;

  constructor(
    private readonly current: string,
    private readonly log: Logger,
    private readonly fetchFn: Fetch = (url, init) => fetch(url, init),
    private readonly now: () => number = Date.now,
  ) {}

  async check(force = false): Promise<UpdateInfo> {
    if (!force && this.last && this.now() - this.last.at < DAY) return this.last.info;
    const info = await this.fetchLatest();
    this.last = { at: this.now(), info };
    return info;
  }

  private async fetchLatest(): Promise<UpdateInfo> {
    const base: UpdateInfo = { current: this.current, latest: null, newer: false, url: LINKS.releases, notes: null, error: null };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8000);
    try {
      const r = await this.fetchFn(`https://api.github.com/repos/${RELEASE.owner}/${RELEASE.repo}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Keo-Desktop' },
        signal: ac.signal,
      });
      if (r.status === 404) return { ...base, error: 'No published release yet.' };
      if (!r.ok) return { ...base, error: `GitHub answered ${r.status}.` };
      const j = (await r.json()) as { tag_name?: unknown; html_url?: unknown; body?: unknown };
      const latest = typeof j.tag_name === 'string' ? j.tag_name.replace(/^v/i, '') : null;
      if (!latest) return { ...base, error: 'The release has no version tag.' };
      const url = typeof j.html_url === 'string' && j.html_url.startsWith(`https://github.com/${RELEASE.owner}/${RELEASE.repo}/`) ? j.html_url : LINKS.releases;
      const notes = typeof j.body === 'string' ? j.body.slice(0, 1200) : null;
      return { ...base, latest, newer: compareVersions(latest, this.current) > 0, url, notes };
    } catch (e) {
      this.log.info('update.check_failed', { error: (e as Error).name });
      return { ...base, error: 'Could not reach GitHub to check for updates.' };
    } finally {
      clearTimeout(timer);
    }
  }
}
