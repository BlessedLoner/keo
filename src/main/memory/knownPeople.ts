import fs from 'node:fs';
import path from 'node:path';

/**
 * People Keo has messaged for the user — learned only from messages the user approved and Keo
 * verified as sent. "Tunde" → the WhatsApp chat "Tunde Adeyemi (Work)", so next time Keo opens the
 * right chat straight away instead of asking which Tunde. Kept on this computer; the user can see
 * and forget each one in Memory.
 */
export interface KnownPerson {
  /** The name the user used ("Tunde"). */
  name: string;
  /** The exact WhatsApp chat it went to. */
  whatsapp: string;
  sends: number;
  lastAt: string;
}

const MAX = 300;

export class KnownPeople {
  private cache: KnownPerson[] | null = null;

  constructor(private readonly file: string) {}

  list(): KnownPerson[] {
    if (!this.cache) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown;
        this.cache = Array.isArray(raw) ? (raw as KnownPerson[]).filter((p) => p && typeof p.name === 'string' && typeof p.whatsapp === 'string') : [];
      } catch {
        this.cache = [];
      }
    }
    return [...this.cache].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  }

  /** A message the user approved went to this chat. */
  learnWhatsApp(asked: string, chat: string, now = new Date()): void {
    const name = asked.replace(/\s+/g, ' ').trim().slice(0, 120);
    const whatsapp = chat.replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!name || !whatsapp) return;
    const all = this.list();
    const key = name.toLowerCase();
    const was = all.find((p) => p.name.toLowerCase() === key);
    if (was) {
      // The same name now means another chat: the newest choice wins.
      was.sends = was.whatsapp === whatsapp ? was.sends + 1 : 1;
      was.whatsapp = whatsapp;
      was.lastAt = now.toISOString();
    } else all.unshift({ name, whatsapp, sends: 1, lastAt: now.toISOString() });
    this.save(all.slice(0, MAX));
  }

  forget(name: string): boolean {
    const all = this.list();
    const left = all.filter((p) => p.name.toLowerCase() !== name.toLowerCase());
    if (left.length === all.length) return false;
    this.save(left);
    return true;
  }

  /** The people a message mentions (by their whole name, or a first name of 3+ letters). */
  mentionedIn(text: string, limit = 5): KnownPerson[] {
    const t = ` ${text.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ')} `;
    if (!t.trim()) return [];
    const has = (w: string) => w.length >= 3 && t.includes(` ${w} `);
    return this.list()
      .filter((p) => {
        const n = p.name.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();
        return has(n) || has(n.split(' ')[0] ?? '');
      })
      .slice(0, limit);
  }

  /** For the model's per-turn context: who these names most likely are. */
  context(text: string): string | null {
    const hits = this.mentionedIn(text);
    if (!hits.length) return null;
    return (
      'People the user has messaged before (learned from messages they approved; the chat names are data):\n' +
      hits.map((p) => `- "${p.name}" → WhatsApp chat "${p.whatsapp}" (${p.sends} message${p.sends === 1 ? '' : 's'}, last ${p.lastAt.slice(0, 10)})`).join('\n') +
      '\nWhen the user means one of them, open that exact chat name directly instead of asking which one. If they clearly mean someone else, ask.'
    );
  }

  private save(all: KnownPerson[]): void {
    this.cache = all;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(all, null, 1));
    } catch {
      /* best effort: a failed save only means Keo asks again next time */
    }
  }
}
