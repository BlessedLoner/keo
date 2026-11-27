import fs from 'node:fs';
import path from 'node:path';

/** How long Keo Studio and Builds stay open without a Keo account: one day from first use. */
export const TRIAL_MS = 24 * 3600_000;

export interface CreativeAccess {
  /** Signed in to a Keo account: Studio and Builds are always open. */
  signedIn: boolean;
  /** When the free day began (first use without an account), or null when it has not begun. */
  startedAt: string | null;
  /** When it ends (or ended). */
  endsAt: string | null;
  /** Studio and Builds are locked until the user signs in. */
  locked: boolean;
}

export const LOCKED_REASON = 'Keo Studio and Builds need a free Keo account after the first day. Ask the user to sign in (Settings → Account) to keep using them; their work is kept.';

/**
 * Keo Studio and Builds without a Keo account (own API keys): open for one day from first use, then
 * locked until the user signs in. Nothing is deleted: signing in opens them again.
 */
export class CreativeTrial {
  constructor(
    private readonly file: string,
    private readonly signedIn: () => boolean,
    private readonly now: () => number = Date.now,
  ) {}

  private startedAt(): number | null {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { startedAt?: string };
      const t = j.startedAt ? Date.parse(j.startedAt) : NaN;
      return Number.isFinite(t) ? t : null;
    } catch {
      return null;
    }
  }

  state(): CreativeAccess {
    const signedIn = this.signedIn();
    const t = this.startedAt();
    const ends = t === null ? null : t + TRIAL_MS;
    return { signedIn, startedAt: t === null ? null : new Date(t).toISOString(), endsAt: ends === null ? null : new Date(ends).toISOString(), locked: !signedIn && ends !== null && this.now() >= ends };
  }

  /** Using Studio or Builds without an account starts the free day (once). */
  use(): CreativeAccess {
    if (!this.signedIn() && this.startedAt() === null) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ startedAt: new Date(this.now()).toISOString() }));
    }
    return this.state();
  }

  /** The reason a Studio or Builds step may not run now, or null. */
  check(): string | null {
    return this.use().locked ? LOCKED_REASON : null;
  }
}

/** Studio and Builds steps (Keo's tools for them). */
export const isCreativeCapability = (id: string): boolean => id.startsWith('studio.') || id.startsWith('build.');

/** The window's Studio and Builds requests that change or make something (reading lists stays open). */
export const isCreativeChannel = (ch: string): boolean => (ch.startsWith('studio:') || ch.startsWith('builds:')) && !/^(studio:list|builds:list|builds:get|builds:folder)$/.test(ch);
