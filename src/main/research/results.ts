import type { ProductCard } from '../../shared/domain';

export interface ResearchResult {
  id: string;
  title: string;
  summary: string;
  criteria: string[];
  cards: ProductCard[];
  dropped: Array<{ name: string; reason: string }>;
  conversationId: string | null;
  createdAt: string;
}

/** Recent research results (in memory; the last ten), shown in the results window and used by save/send. */
export class ResearchResults {
  private list: ResearchResult[] = [];

  add(r: Omit<ResearchResult, 'id' | 'createdAt'>): ResearchResult {
    const full: ResearchResult = { ...r, id: `rr_${Math.random().toString(36).slice(2, 12)}`, createdAt: new Date().toISOString() };
    this.list = [full, ...this.list].slice(0, 10);
    return full;
  }

  get(id: string | undefined | null): ResearchResult | null {
    if (!id) return this.list[0] ?? null;
    return this.list.find((r) => r.id === id) ?? null;
  }

  latest(conversationId?: string | null): ResearchResult | null {
    return (conversationId ? this.list.find((r) => r.conversationId === conversationId) : null) ?? this.list[0] ?? null;
  }

  recent(): ResearchResult[] {
    return [...this.list];
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** “USD 279” for a bare number; a price that already carries its symbol (“$199”) is shown as it is. */
export const priceOf = (c: Pick<ProductCard, 'price' | 'currency'>) => (c.price ? `${c.currency && /^[\d.,\s]+$/.test(c.price) ? `${c.currency} ` : ''}${c.price}` : 'Price not stated');

/**
 * A self-contained HTML report (inline styles, pictures embedded as data: URLs,
 * no scripts) — saved as a page, and turned into a PDF or a picture.
 */
export function reportHtml(r: ResearchResult, opts: { forImage?: boolean } = {}): string {
  const cards = r.cards
    .map(
      (c) => `<article class="card">
  ${c.image ? `<img src="${c.image}" alt="${esc(c.name)}">` : '<div class="noimg">No picture on the page</div>'}
  <div class="body">
    <h2>${esc(c.name)}</h2>
    <div class="price">${esc(priceOf(c))}${c.merchant ? ` <span class="merchant">· ${esc(c.merchant)}</span>` : ''}</div>
    ${c.availability ? `<div class="muted">${esc(c.availability)}</div>` : ''}
    ${c.fit ? `<p>${esc(c.fit)}</p>` : ''}
    ${c.specs.length ? `<ul>${c.specs.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
    ${c.pros.map((p) => `<div class="pro">+ ${esc(p)}</div>`).join('')}
    ${c.cons.map((p) => `<div class="con">− ${esc(p)}</div>`).join('')}
    ${opts.forImage ? '' : `<a href="${esc(c.url)}">${esc(c.pageTitle || c.url)}</a>`}
    <div class="muted small">${c.priceFrom === 'not found' ? 'No price on the page' : `Price from the ${c.priceFrom}`} · read ${esc(new Date(c.fetchedAt).toLocaleDateString())}</div>
  </div>
</article>`,
    )
    .join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><title>${esc(r.title)}</title>
<style>
body{margin:0;padding:28px;background:#0d1017;color:#e8ecf4;font:14px/1.45 "Segoe UI",system-ui,sans-serif}
h1{margin:0 0 6px;font-size:22px}.summary{color:#aeb8cc;margin:0 0 10px}
.chips span{display:inline-block;border:1px solid #2b3345;border-radius:999px;padding:2px 10px;margin:0 6px 6px 0;font-size:12px;color:#aeb8cc}
.grid{display:grid;grid-template-columns:repeat(${Math.min(3, Math.max(1, r.cards.length))},1fr);gap:14px;margin-top:12px}
.card{background:#151924;border:1px solid #222a3a;border-radius:14px;overflow:hidden;display:flex;flex-direction:column}
.card img,.noimg{width:100%;height:190px;object-fit:contain;background:#fff;display:flex;align-items:center;justify-content:center;color:#666;font-size:12px}
.body{padding:12px 14px;display:flex;flex-direction:column;gap:6px}
h2{margin:0;font-size:15px}.price{font-size:18px;font-weight:700;color:#7fd3ff}.merchant{font-size:13px;font-weight:400;color:#aeb8cc}
ul{margin:0;padding-left:18px;color:#c9d1e0}.pro{color:#4fd18b}.con{color:#ff8a95}a{color:#7fd3ff;word-break:break-all}
.muted{color:#8a94a8}.small{font-size:11px}.foot{margin-top:16px;color:#8a94a8;font-size:11px}
</style></head><body>
<h1>${esc(r.title)}</h1>
<p class="summary">${esc(r.summary)}</p>
${r.criteria.length ? `<div class="chips">${r.criteria.map((c) => `<span>${esc(c)}</span>`).join('')}</div>` : ''}
<div class="grid">${cards}</div>
<div class="foot">Researched by Keo on ${esc(new Date(r.createdAt).toLocaleString())}. Prices and pictures come from the pages listed; check the seller before buying.</div>
</body></html>`;
}

/** A WhatsApp-sized text: title, then each product's price, seller and link. */
export function shareText(r: ResearchResult, max = 1000): string {
  const lines = [`*${r.title}*`, r.summary, ''];
  for (const c of r.cards) lines.push(`• ${c.name} — ${priceOf(c)}${c.merchant ? ` (${c.merchant})` : ''}\n${c.url}`);
  const text = lines.join('\n').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A folder name from the title and date (only safe characters). */
export function folderName(r: ResearchResult): string {
  const t = r.title.replace(/[^\p{L}\p{N} ._-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Research';
  return `${r.createdAt.slice(0, 10)} ${t}`;
}
