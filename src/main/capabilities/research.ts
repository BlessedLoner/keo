import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import type { ProductCard } from '../../shared/domain';
import { folderName, reportHtml, shareText, type ResearchResult, type ResearchResults } from '../research/results';
import { bringToFront, Target } from './builtins';
import { resolveWhatsApp, waSendFile } from './advanced';
import { CapabilityError } from './types';
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
  imageUrl: z.string().nullable().optional(),
});

const digits = (s: string) => s.replace(/[^\d.,]/g, '').replace(/,(?=\d{3}\b)/g, '').replace(',', '.');

/**
 * Product comparison cards for the chat. Only products whose page Keo really
 * fetched in this session are shown; the price, merchant and image come from
 * that page (its structured data, or a price the page text actually
 * contains) — never from the model alone. Images are downloaded and shrunk by
 * Keo, so the chat never loads remote images.
 */
export interface ResearchDeps extends CapabilityDeps {
  web: WebService;
  images: ImageTools;
  results: ResearchResults;
  /** A result is ready: show it (the results window). */
  showResult: (r: ResearchResult) => void;
  /** Turns the report page into a PDF or a picture (Keo's own hidden window; a fake in tests). */
  render: (html: string, kind: 'pdf' | 'png') => Promise<Buffer>;
  /** Where saved results go (Documents\Keo Research) and where pictures for sending are made. */
  saveRoot: () => string;
  workRoot: () => string;
}

export function researchCapabilities(d: ResearchDeps): AnyCapability[] {
  const show = defineCapability({
    id: 'research.show_products',
    version: '1.0.0',
    title: 'Show product comparison cards',
    description:
      'After researching products with web__search and web__fetch_page (open the actual product/shop pages, which carry the price and picture), show the best candidates: Keo opens its results window with pictures, prices, sellers, specs, pros/cons and source links, and keeps the result so the user can say "save it" (research__save_result) or "send it to <name>" (research__send_whatsapp). Use only pages you fetched in this conversation; Keo takes price, seller and picture from those pages and drops anything it cannot trace. Then answer briefly and ask whether to save or send it.',
    input: z
      .object({
        title: z.string().trim().min(1).max(120).optional().describe('Short title for the result, e.g. "MacBook Pro vs MacBook Air (M4, 32 GB)"'),
        summary: z.string().trim().min(1).max(600),
        criteria: z.array(z.string().trim().min(1).max(80)).max(6).default([]),
        products: z.array(Item).min(1).max(6),
      })
      .strict(),
    output: z.object({ resultId: z.string(), title: z.string(), summary: z.string(), criteria: z.array(z.string()), cards: z.array(Card), dropped: z.array(z.object({ name: z.string(), reason: z.string() })) }),
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
          imageUrl: pp.image ?? null,
        });
      }
      const title = i.title ?? cards.map((c) => c.name).slice(0, 3).join(' vs ').slice(0, 120) ?? 'Research';
      const saved = d.results.add({ title: title || 'Research', summary: i.summary, criteria: i.criteria, cards, dropped, conversationId: ctx.conversationId });
      if (cards.length) d.showResult(saved);
      return { resultId: saved.id, title: saved.title, summary: i.summary, criteria: i.criteria, cards, dropped };
    },
  });
  /** Rendering happens before anything is saved or sent, so a failure here changed nothing. */
  const render = async (html: string, kind: 'pdf' | 'png', what: string): Promise<Buffer> => {
    try {
      return await d.render(html, kind);
    } catch (e) {
      throw new CapabilityError('render_failed', `Keo could not make the ${kind === 'pdf' ? 'PDF' : 'picture'} (${(e as Error).message}). Nothing was ${what}.`, { dispatched: 'no' });
    }
  };

  const saveResult = defineCapability({
    id: 'research.save_result',
    version: '1.0.0',
    title: 'Save a research result',
    description:
      'Save a research result (the latest one unless resultId is given) to the user\'s Documents\\Keo Research folder: a report page with the product pictures and prices, plus a PDF or a picture of it, and the product pictures as separate files.',
    input: z.object({ resultId: z.string().regex(/^rr_[a-z0-9]{6,20}$/).optional(), format: z.enum(['pdf', 'png', 'page']).default('pdf') }).strict(),
    output: z.object({ folder: z.string(), files: z.array(z.string()) }),
    risk: 'low',
    approval: 'always',
    permissions: [],
    consequential: true,
    idempotent: false,
    timeoutMs: 90000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'The saved files are checked on disk.',
    autonomy: () => ({ tier: 'routine' }),
    preview: (i) => {
      const r = d.results.get(i.resultId);
      return { summary: `Save “${r?.title ?? 'the research result'}” as ${i.format === 'png' ? 'a picture' : i.format === 'pdf' ? 'a PDF' : 'a page'}`, target: d.saveRoot(), consequences: ['Creates a new folder with the report and the product pictures.'], dataExport: null };
    },
    auditView: (i) => ({ format: i.format }),
    async execute(i, ctx) {
      const r = d.results.get(i.resultId);
      if (!r) throw new CapabilityError('no_result', 'There is no research result to save yet.', { dispatched: 'no' });
      // Render first: if that fails, no half-written folder is left behind.
      const rendered = i.format === 'page' ? null : await render(reportHtml(r, { forImage: i.format === 'png' }), i.format, 'saved');
      const base = path.join(d.saveRoot(), folderName(r));
      let folder = base;
      for (let n = 2; fs.existsSync(folder); n++) folder = `${base} (${n})`;
      fs.mkdirSync(path.join(folder, 'pictures'), { recursive: true });
      const files: string[] = [];
      const page = path.join(folder, 'report.html');
      fs.writeFileSync(page, reportHtml(r), 'utf8');
      files.push(page);
      if (i.format !== 'page') {
        const out = path.join(folder, i.format === 'pdf' ? 'report.pdf' : 'report.png');
        fs.writeFileSync(out, rendered!);
        files.push(out);
      }
      // Product pictures: full size from the page's own image when possible, else Keo's preview.
      for (const [k, c] of r.cards.entries()) {
        const safe = c.name.replace(/[^\p{L}\p{N} ._-]+/gu, ' ').trim().slice(0, 50) || `product ${k + 1}`;
        let bytes: Buffer | null = null;
        let ext = 'png';
        if (c.imageUrl) {
          const img = await d.web.fetchImage(c.imageUrl, ctx.signal).catch(() => null);
          if (img) {
            bytes = img.bytes;
            ext = /jpe?g/.test(img.contentType) ? 'jpg' : img.contentType.includes('webp') ? 'webp' : img.contentType.includes('gif') ? 'gif' : 'png';
          }
        }
        if (!bytes && c.image) bytes = Buffer.from(c.image.split(',')[1] ?? '', 'base64');
        if (bytes?.length) {
          const f = path.join(folder, 'pictures', `${k + 1} ${safe}.${ext}`);
          fs.writeFileSync(f, bytes);
          files.push(f);
        }
      }
      return { folder, files };
    },
    async verify(_i, o) {
      const ok = o.files.every((f) => fs.existsSync(f));
      return ok ? { verified: true, detail: `Saved in ${o.folder} (${o.files.length} files).` } : { verified: false, detail: 'Some files are missing.' };
    },
  });

  const sendResult = defineCapability({
    id: 'research.send_whatsapp',
    version: '1.0.0',
    title: 'Send a research result on WhatsApp',
    description:
      'Send a research result (the latest one unless resultId is given) to a WhatsApp contact the user named: a picture of the comparison (product pictures, prices, sellers) with a short text of the prices and links. Keo opens the chat, checks the recipient again and verifies the message appears.',
    input: z
      .object({
        resultId: z.string().regex(/^rr_[a-z0-9]{6,20}$/).optional(),
        contact: z.string().trim().min(1).max(120),
        which: z.enum(['app', 'web']).optional(),
        target: Target.optional(),
        note: z.string().trim().max(300).optional().describe('Optional line to put before the summary, e.g. "This is what I found"'),
      })
      .strict(),
    output: z.object({ sent: z.boolean(), appearsInChat: z.boolean(), file: z.string(), recipient: z.string(), textSeparately: z.boolean().optional() }),
    risk: 'high',
    approval: 'always',
    permissions: ['desktop.control'],
    // The picture is rendered first; only the WhatsApp part holds the desktop (see execute).
    locksDesktopItself: true,
    consequential: true,
    idempotent: false,
    timeoutMs: 150000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'Recipient verified from the chat header before sending; the picture must appear as your latest message afterwards.',
    autonomy: (i) => ({ tier: 'important', mustBeNamed: i.contact }),
    preview: (i) => {
      const r = d.results.get(i.resultId);
      return {
        summary: `Send “${r?.title ?? 'the research result'}” to ${i.contact} on WhatsApp`,
        target: `Recipient: ${i.contact}`,
        consequences: ['A picture of the comparison (product pictures, prices, sellers).', `Text: “${r ? `${i.note ? `${i.note}
` : ''}${shareText(r, 300)}` : ''}”`, 'This sends a real message from your WhatsApp account.'],
        dataExport: 'The picture and text are sent through WhatsApp to the recipient.',
      };
    },
    auditView: (i) => ({ contactLength: i.contact.length, note: !!i.note }),
    async execute(i, ctx) {
      const r = d.results.get(i.resultId);
      if (!r) throw new CapabilityError('no_result', 'There is no research result to send yet.', { dispatched: 'no' });
      const dir = path.join(d.workRoot(), r.id);
      fs.mkdirSync(dir, { recursive: true });
      const picture = path.join(dir, `${folderName(r).slice(11) || 'research'}.png`);
      fs.writeFileSync(picture, await render(reportHtml(r, { forImage: true }), 'png', 'sent'));
      const caption = `${i.note ? `${i.note}\n\n` : ''}${shareText(r)}`;
      const t = await resolveWhatsApp(d, i.target, ctx.settings, i.which);
      return d.desktop.exclusive(`research.send_whatsapp:${ctx.correlationId}`, async () => {
        await bringToFront(d, t, ctx.settings);
        return waSendFile(d, t, i.contact, picture, caption, ctx.signal);
      }, ctx.signal);
    },
    async verify(_i, o) {
      return o.appearsInChat ? { verified: true, detail: o.textSeparately ? `The comparison picture was sent to ${o.recipient}, with the prices and links as the next message (WhatsApp did not take them as the picture’s caption).` : `The comparison appears as your latest message to ${o.recipient}.` } : { verified: false, detail: 'Keo pressed Send but could not find the picture in the chat. Check WhatsApp before trying again.' };
    },
  });

  return [show, saveResult, sendResult];
}
