import dns from 'node:dns/promises';
import net from 'node:net';
import { CapabilityError } from '../capabilities/types';
import type { Logger } from '../logging/logger';

export interface SearchResult {
  title: string;
  url: string;
  description: string;
  age: string | null;
}

export interface FetchedPage {
  url: string;
  finalUrl: string;
  title: string;
  text: string;
  truncated: boolean;
  contentType: string;
  fetchedAt: string;
}

type FetchImpl = typeof fetch;
type Lookup = (host: string) => Promise<Array<{ address: string; family: number }>>;

const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_CHARS = 20000;
const MAX_REDIRECTS = 4;
const USER_AGENT = 'Keo/0.1 (personal desktop assistant)';

/**
 * Outbound web access for research. Search goes only to Brave's API with the
 * user's own key; page fetching refuses private-network destinations (SSRF
 * protection) and returns plain text only — never executes page content.
 */
export class WebService {
  constructor(
    private readonly getKey: () => string | null,
    private readonly log: Logger,
    private readonly fetchImpl: FetchImpl = fetch,
    private readonly lookup: Lookup = (h) => dns.lookup(h, { all: true, verbatim: true }),
  ) {}

  hasKey(): boolean {
    return !!this.getKey();
  }

  async search(query: string, opts: { count: number; freshness?: string; safesearch: 'off' | 'moderate' | 'strict' }, signal: AbortSignal): Promise<SearchResult[]> {
    const key = this.getKey();
    if (!key) throw new CapabilityError('unconfigured', 'Web search needs a Brave Search API key (Settings → Web search).');
    const url = new URL(BRAVE_ENDPOINT);
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(Math.min(20, Math.max(1, opts.count))));
    url.searchParams.set('safesearch', opts.safesearch);
    if (opts.freshness) url.searchParams.set('freshness', opts.freshness);
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers: { Accept: 'application/json', 'X-Subscription-Token': key }, signal });
    } catch (e) {
      if (signal.aborted) throw new CapabilityError('cancelled', 'Search cancelled.');
      throw new CapabilityError('network', `Could not reach Brave Search: ${(e as Error).message}`, { retryable: true });
    }
    if (res.status === 401 || res.status === 403) throw new CapabilityError('auth', 'Brave Search rejected the API key.');
    if (res.status === 429) throw new CapabilityError('rate_limit', 'Brave Search rate limit or monthly quota reached.', { retryable: true });
    if (!res.ok) throw new CapabilityError('search_failed', `Brave Search returned HTTP ${res.status}.`, { retryable: res.status >= 500 });
    const body = (await res.json().catch(() => null)) as { web?: { results?: unknown[] } } | null;
    const raw = Array.isArray(body?.web?.results) ? body.web.results : [];
    const results: SearchResult[] = [];
    for (const r of raw) {
      if (!r || typeof r !== 'object') continue;
      const o = r as Record<string, unknown>;
      if (typeof o.url !== 'string' || typeof o.title !== 'string') continue;
      results.push({
        title: stripTags(o.title).slice(0, 300),
        url: o.url.slice(0, 2000),
        description: typeof o.description === 'string' ? stripTags(o.description).slice(0, 600) : '',
        age: typeof o.age === 'string' ? o.age.slice(0, 60) : typeof o.page_age === 'string' ? o.page_age.slice(0, 60) : null,
      });
    }
    this.log.info('web.search', { results: results.length, queryLength: query.length });
    return results;
  }

  async fetchPage(rawUrl: string, signal: AbortSignal): Promise<FetchedPage> {
    let current = await this.assertPublicUrl(rawUrl);
    let res: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      try {
        res = await this.fetchImpl(current, {
          redirect: 'manual',
          signal,
          headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8' },
        });
      } catch (e) {
        if (signal.aborted) throw new CapabilityError('cancelled', 'Fetch cancelled.');
        throw new CapabilityError('network', `Could not load the page: ${(e as Error).message}`, { retryable: true });
      }
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) throw new CapabilityError('fetch_failed', 'Redirect without a location.');
        current = await this.assertPublicUrl(new URL(loc, current).toString());
        continue;
      }
      break;
    }
    if (!res || (res.status >= 300 && res.status < 400)) throw new CapabilityError('fetch_failed', 'Too many redirects.');
    if (!res.ok) throw new CapabilityError('fetch_failed', `The page returned HTTP ${res.status}.`, { retryable: res.status >= 500 });
    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    const isHtml = contentType.includes('html');
    if (!isHtml && !contentType.startsWith('text/') && !contentType.includes('json')) {
      throw new CapabilityError('unsupported_content', `Keo can only read text pages (got ${contentType || 'unknown type'}).`);
    }
    const { text: raw, truncatedBytes } = await readCapped(res, MAX_PAGE_BYTES);
    const title = isHtml ? decodeEntities((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1] ?? '').trim()).slice(0, 300) : '';
    let text = isHtml ? htmlToText(raw) : raw.replace(/\s+\n/g, '\n').trim();
    let truncated = truncatedBytes;
    if (text.length > MAX_TEXT_CHARS) {
      text = text.slice(0, MAX_TEXT_CHARS);
      truncated = true;
    }
    this.log.info('web.fetch', { host: current.host, chars: text.length, truncated });
    return { url: rawUrl, finalUrl: current.toString(), title, text, truncated, contentType: contentType.split(';')[0] ?? '', fetchedAt: new Date().toISOString() };
  }

  /** Allows only http(s) to hosts that resolve exclusively to public addresses. */
  async assertPublicUrl(raw: string): Promise<URL> {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new CapabilityError('invalid_url', 'That is not a valid URL.');
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new CapabilityError('invalid_url', 'Only http and https pages can be read.');
    if (u.username || u.password) throw new CapabilityError('invalid_url', 'URLs with embedded credentials are not allowed.');
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
      throw new CapabilityError('blocked_destination', 'Keo does not read pages on this computer or the local network.');
    }
    const addrs = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await this.lookup(host).catch(() => []);
    if (!addrs.length) throw new CapabilityError('dns_failed', `Could not resolve ${host}.`, { retryable: true });
    if (addrs.some((a) => isPrivateAddress(a.address))) {
      throw new CapabilityError('blocked_destination', 'Keo does not read pages on this computer or the local network.');
    }
    return u;
  }
}

/** True for loopback, private, link-local, CGNAT, multicast, unspecified and similar non-public ranges. */
export function isPrivateAddress(addr: string): boolean {
  const ip = addr.toLowerCase();
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (net.isIPv6(ip)) {
    if (ip === '::' || ip === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
    if (mapped) return isPrivateAddress(mapped[1] as string);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(ip) || ip.startsWith('64:ff9b:') || ip.startsWith('2001:db8');
  }
  return true; // unknown format: refuse
}

async function readCapped(res: Response, max: number): Promise<{ text: string; truncatedBytes: boolean }> {
  if (!res.body) return { text: await res.text(), truncatedBytes: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > max) {
      chunks.push(value.subarray(0, max - total));
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  return { text: new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks)), truncatedBytes: truncated };
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, ''));
}

/** Readable text from HTML: drops scripts/styles/navigation chrome, keeps block structure. */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|head|nav|footer|form)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|blockquote|pre|header|main|table)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<h[1-6]\b[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  return s
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
