import type { NavigationGrant, TaskStep } from '../../shared/domain';
import type { AuditRepo } from '../repos/audit';
import { KeoError, nowIso } from '../util/errors';
import { newId } from '../util/ids';

/** Capabilities a navigation grant may cover (each still checks `grantable` per input). */
export const GRANTABLE_CAPABILITIES = [
  'desktop.inspect_window',
  'desktop.invoke_element',
  'desktop.scroll',
  'desktop.focus_window',
  'desktop.press_keys',
  'browser.read_page',
  'whatsapp.open_chat',
  'whatsapp.read_chat',
] as const;

const MAX_MINUTES = 30;
const MAX_ACTIONS = 60;

/**
 * Time-boxed, per-window permission the USER grants from an approval card so
 * Keo can look around and navigate without asking for every click. Grants are
 * held in memory only (gone after restart), limited in time and number of
 * actions, bound to one window identity, revocable at any moment, and never
 * cover sensitive controls (send, delete, submit, pay, …) — those always need
 * a fresh approval.
 */
export class GrantService {
  private readonly grants = new Map<string, NavigationGrant>();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly audit: AuditRepo,
    private readonly now: () => number = Date.now,
  ) {}

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const l of this.listeners) l();
  }

  create(target: NavigationGrant['target'], label: string, minutes: number, maxActions = 40): NavigationGrant {
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > MAX_MINUTES) throw new KeoError('invalid_input', `A grant lasts 1–${MAX_MINUTES} minutes.`);
    const g: NavigationGrant = {
      id: newId('g_'),
      target: { ...target },
      label: label.slice(0, 120),
      capabilities: [...GRANTABLE_CAPABILITIES],
      createdAt: nowIso(),
      expiresAt: new Date(this.now() + minutes * 60_000).toISOString(),
      maxActions: Math.min(MAX_ACTIONS, Math.max(1, maxActions)),
      used: 0,
    };
    this.grants.set(g.id, g);
    this.audit.record({ kind: 'permission.grant', decision: 'created', detail: { grantId: g.id, processName: target.processName, minutes, maxActions: g.maxActions } });
    this.changed();
    return { ...g };
  }

  list(): NavigationGrant[] {
    this.expire();
    return [...this.grants.values()].map((g) => ({ ...g }));
  }

  revoke(id: string): boolean {
    const ok = this.grants.delete(id);
    if (ok) {
      this.audit.record({ kind: 'permission.grant', decision: 'revoked', detail: { grantId: id } });
      this.changed();
    }
    return ok;
  }

  revokeAll(): number {
    const n = this.grants.size;
    if (!n) return 0;
    this.grants.clear();
    this.audit.record({ kind: 'permission.grant', decision: 'revoked_all', detail: { count: n } });
    this.changed();
    return n;
  }

  /** Finds a grant covering this step and consumes one action from it. */
  match(step: TaskStep): string | null {
    this.expire();
    if (!step.preview.grantable) return null;
    const target = (step.input as { target?: { hwnd?: unknown; pid?: unknown } } | null)?.target;
    if (!target || typeof target.hwnd !== 'string' || typeof target.pid !== 'number') return null;
    for (const g of this.grants.values()) {
      if (g.target.hwnd !== target.hwnd || g.target.pid !== target.pid) continue;
      if (!g.capabilities.includes(step.capabilityId)) continue;
      if (g.used >= g.maxActions) continue;
      g.used++;
      this.changed();
      return g.id;
    }
    return null;
  }

  private expire(): void {
    const t = this.now();
    let removed = false;
    for (const [id, g] of this.grants) {
      if (Date.parse(g.expiresAt) <= t || g.used >= g.maxActions) {
        this.grants.delete(id);
        removed = true;
        this.audit.record({ kind: 'permission.grant', decision: 'expired', detail: { grantId: id } });
      }
    }
    if (removed) this.changed();
  }
}
