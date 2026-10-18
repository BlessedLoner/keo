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
