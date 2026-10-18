import { z } from 'zod';
import type { ProductCard } from '../../shared/domain';
import type { ImageTools } from '../vision/visionService';
import type { WebService } from '../web/webService';
import type { CapabilityDeps } from './builtins';
import { defineCapability, type AnyCapability } from './types';

const Item = z
  .object({
    name: z.string().trim().min(1).max(160),
    url: z.string().trim().min(8).max(2000).describe('A page you fetched with web__fetch_page in this conversation'),
    fit: z.string().trim().max(300).optional().describe('Why it suits the user, in one sentence'),
    pros: z.array(z.string().trim().min(1).max(160)).max(5).default([]),
    cons: z.array(z.string().trim().min(1).max(160)).max(5).default([]),
    specs: z.array(z.string().trim().min(1).max(120)).max(8).default([]),
    price: z.string().trim().max(30).optional().describe('Only if the page states it'),
    currency: z.string().trim().max(10).optional(),
  })
  .strict();

const Card = z.object({
  name: z.string(),
  url: z.string(),
  pageTitle: z.string(),
  merchant: z.string().nullable(),
  price: z.string().nullable(),
  currency: z.string().nullable(),
  priceFrom: z.enum(['page data', 'page text', 'not found']),
  availability: z.string().nullable(),
  image: z.string().nullable(),
  fit: z.string().nullable(),
  pros: z.array(z.string()),
  cons: z.array(z.string()),
  specs: z.array(z.string()),
  fetchedAt: z.string(),
});

const digits = (s: string) => s.replace(/[^\d.,]/g, '').replace(/,(?=\d{3}\b)/g, '').replace(',', '.');

/**
 * Product comparison cards for the chat. Only products whose page Keo really
 * fetched in this session are shown; the price, merchant and image come from
 * that page (its structured data, or a price the page text actually
 * contains) — never from the model alone. Images are downloaded and shrunk by
 * Keo, so the chat never loads remote images.
 */
export function researchCapabilities(d: CapabilityDeps & { web: WebService; images: ImageTools }): AnyCapability[] {
  const show = defineCapability({
    id: 'research.show_products',
    version: '1.0.0',
    title: 'Show product comparison cards',
    description:
      'After researching products with web__search and web__fetch_page, show the best candidates as cards in the chat (name, image, price, merchant, specs, pros/cons, source link). Use only pages you fetched in this conversation; Keo takes price, merchant and image from those pages and drops anything it cannot trace. Then answer briefly in text, citing the cards.',
    input: z
      .object({
        summary: z.string().trim().min(1).max(600),
        criteria: z.array(z.string().trim().min(1).max(80)).max(6).default([]),
        products: z.array(Item).min(1).max(6),
      })
      .strict(),
    output: z.object({ summary: z.string(), criteria: z.array(z.string()), cards: z.array(Card), dropped: z.array(z.object({ name: z.string(), reason: z.string() })) }),
    risk: 'low',
    approval: 'never',
    permissions: ['web.fetch'],
    consequential: false,
    idempotent: true,
    timeoutMs: 45000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'Each card is tied to a page fetched in this session; prices and images come from that page.',
    autonomy: () => ({ tier: 'routine' }),
    preview: (i) => ({ summary: `Show ${i.products.length} product card(s)`, target: null, consequences: [], dataExport: null }),
    auditView: (i) => ({ products: i.products.length }),
    async execute(i, ctx) {
      const cards: ProductCard[] = [];
      const dropped: Array<{ name: string; reason: string }> = [];
      for (const p of i.products) {
        const page = d.web.visitedPage(p.url);
        if (!page) {
          dropped.push({ name: p.name, reason: 'Keo did not fetch this page in this conversation, so it is not shown.' });
          continue;
        }
        const pp = page.product;
        let price: string | null = pp.price ?? null;
        let currency: string | null = pp.currency ?? null;
        let priceFrom: ProductCard['priceFrom'] = price ? 'page data' : 'not found';
        if (!price && p.price && digits(p.price) && digits(page.text).includes(digits(p.price))) {
          price = p.price;
          currency = p.currency ?? null;
          priceFrom = 'page text';
        }
        let image: string | null = null;
        if (pp.image) {
          const img = await d.web.fetchImage(pp.image, ctx.signal);
          if (img) {
            try {
              image = `data:image/png;base64,${d.images.fit(img.bytes, 240).toString('base64')}`;
            } catch {
              image = null;
            }
          }
        }
        cards.push({
          name: p.name,
          url: page.finalUrl,
          pageTitle: page.title,
          merchant: pp.merchant ?? (() => {
            try {
              return new URL(page.finalUrl).hostname.replace(/^www\./, '');
            } catch {
              return null;
            }
          })(),
          price,
          currency,
          priceFrom,
          availability: pp.availability ?? null,
          image,
          fit: p.fit ?? null,
          pros: p.pros,
          cons: p.cons,
          specs: p.specs,
          fetchedAt: page.fetchedAt,
        });
      }
      return { summary: i.summary, criteria: i.criteria, cards, dropped };
    },
  });
  return [show];
}
