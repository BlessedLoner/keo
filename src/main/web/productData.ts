/** Product facts a page declares about itself (schema.org Product JSON-LD, Open Graph / product meta tags). */
export interface PageProduct {
  name?: string;
  brand?: string;
  image?: string;
  price?: string;
  currency?: string;
  merchant?: string;
  availability?: string;
}

const clip = (s: unknown, n: number): string | undefined => (typeof s === 'string' && s.trim() ? s.trim().replace(/\s+/g, ' ').slice(0, n) : undefined);

function absolute(u: string | undefined, base: string): string | undefined {
  if (!u) return undefined;
  try {
    const x = new URL(u, base);
    return x.protocol === 'https:' || x.protocol === 'http:' ? x.toString() : undefined;
  } catch {
    return undefined;
  }
}

function meta(html: string, key: string): string | undefined {
  const re = new RegExp(`<meta\\b[^>]*(?:property|name|itemprop)=["']${key.replace(/[.:]/g, '\\$&')}["'][^>]*>`, 'i');
  const tag = re.exec(html)?.[0];
  return tag ? clip(/content=["']([^"']*)["']/i.exec(tag)?.[1], 500) : undefined;
}

function firstImage(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return firstImage(v[0]);
  if (v && typeof v === 'object') return firstImage((v as { url?: unknown; contentUrl?: unknown }).url ?? (v as { contentUrl?: unknown }).contentUrl);
  return undefined;
}

function isProduct(o: Record<string, unknown>): boolean {
  const t = o['@type'];
  return t === 'Product' || (Array.isArray(t) && t.includes('Product'));
}

function findProduct(v: unknown, depth = 0): Record<string, unknown> | null {
  if (!v || typeof v !== 'object' || depth > 6) return null;
  if (Array.isArray(v)) {
    for (const x of v) {
      const p = findProduct(x, depth + 1);
      if (p) return p;
    }
    return null;
  }
  const o = v as Record<string, unknown>;
  if (isProduct(o)) return o;
  for (const k of ['@graph', 'mainEntity', 'itemListElement', 'item']) {
    const p = findProduct(o[k], depth + 1);
    if (p) return p;
  }
  return null;
}

/** Extracts the page's own product data; anything missing stays missing (never guessed). */
export function extractProduct(html: string, baseUrl: string): PageProduct {
  const out: PageProduct = {};
  for (const m of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let j: unknown;
    try {
      j = JSON.parse(m[1]!.trim());
    } catch {
      continue;
    }
    const p = findProduct(j);
    if (!p) continue;
    out.name = clip(p.name, 200);
    const brand = p.brand;
    out.brand = clip(typeof brand === 'object' && brand ? (brand as { name?: unknown }).name : brand, 80);
    out.image = absolute(firstImage(p.image), baseUrl);
    const offers = Array.isArray(p.offers) ? p.offers[0] : p.offers;
    if (offers && typeof offers === 'object') {
      const o = offers as Record<string, unknown>;
      const price = o.price ?? o.lowPrice ?? (o.priceSpecification as Record<string, unknown> | undefined)?.price;
      out.price = typeof price === 'number' ? String(price) : clip(price, 30);
      out.currency = clip(o.priceCurrency ?? (o.priceSpecification as Record<string, unknown> | undefined)?.priceCurrency, 10);
      const seller = o.seller;
      out.merchant = clip(typeof seller === 'object' && seller ? (seller as { name?: unknown }).name : seller, 80);
      out.availability = clip(typeof o.availability === 'string' ? o.availability.replace(/^https?:\/\/schema\.org\//, '') : undefined, 40);
    }
    break;
  }
  out.name ??= meta(html, 'og:title');
  out.image ??= absolute(meta(html, 'og:image') ?? meta(html, 'og:image:url') ?? meta(html, 'twitter:image'), baseUrl);
  out.price ??= meta(html, 'product:price:amount') ?? meta(html, 'og:price:amount');
  out.currency ??= meta(html, 'product:price:currency') ?? meta(html, 'og:price:currency');
  out.merchant ??= meta(html, 'og:site_name');
  for (const k of Object.keys(out) as Array<keyof PageProduct>) if (out[k] === undefined) delete out[k];
  return out;
}

const NOT_A_PRODUCT_PICTURE = /logo|icon|sprite|avatar|badge|pixel|spacer|blank|placeholder|favicon|flag|rating|star|arrow|banner-ad|tracking|1x1|\.svg(\?|$)|\.gif(\?|$)/i;

/**
 * All pictures a page offers for its product, best first: its declared product picture (JSON-LD,
 * Open Graph, Twitter, itemprop, image_src), then <img> pictures whose description mentions the
 * product, then other large pictures. Logos, icons and tracking pixels are skipped.
 */
export function imageCandidates(html: string, baseUrl: string, productName?: string): string[] {
  const out: string[] = [];
  const add = (u: string | undefined) => {
    const a = absolute(u?.trim(), baseUrl);
    if (a && !NOT_A_PRODUCT_PICTURE.test(a) && !out.includes(a)) out.push(a);
  };
  const p = extractProduct(html, baseUrl);
  add(p.image);
  for (const k of ['og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image', 'twitter:image:src', 'image']) add(meta(html, k));
  add(/<link\b[^>]*rel=["']image_src["'][^>]*href=["']([^"']+)["']/i.exec(html)?.[1]);
  const words = (productName ?? p.name ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);
  const imgs: Array<{ url: string; score: number }> = [];
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const attr = (n: string) => new RegExp(`\\b${n}=["']([^"']+)["']`, 'i').exec(tag)?.[1];
    const srcset = attr('srcset') ?? attr('data-srcset');
    // The largest picture of a srcset ("a.jpg 400w, b.jpg 1200w").
    const fromSet = srcset
      ?.split(',')
      .map((x) => x.trim().split(/\s+/))
      .sort((a, b) => parseInt(b[1] ?? '0', 10) - parseInt(a[1] ?? '0', 10))[0]?.[0];
    const url = attr('data-src') ?? attr('data-lazy-src') ?? attr('data-original') ?? fromSet ?? attr('src');
    if (!url || url.startsWith('data:')) continue;
    const alt = (attr('alt') ?? attr('title') ?? '').toLowerCase();
    const width = parseInt(attr('width') ?? '0', 10);
    const hits = words.filter((w) => alt.includes(w)).length;
    if (!hits && width && width < 200) continue;
    imgs.push({ url, score: hits * 10 + (width >= 400 ? 3 : 0) + (fromSet ? 1 : 0) });
  }
  for (const i of imgs.sort((a, b) => b.score - a.score).slice(0, 12)) add(i.url);
  return out.slice(0, 10);
}
