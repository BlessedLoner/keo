import { CapabilityError } from '../capabilities/types';
import { newId } from '../util/ids';
import type { UiaNodeRaw, UiaSnapshotRaw } from './backend';
import type { TargetRef } from './desktopService';

/** How long an observation may be used to target an action. */
export const SNAPSHOT_MAX_AGE_MS = 120_000;

export interface StoredSnapshot {
  id: string;
  target: TargetRef;
  takenAt: number;
  nodes: UiaNodeRaw[];
  window: UiaSnapshotRaw['window'];
}

/** Compact element view sent to the model. `id` is "e<index>" within a snapshot. */
export interface ElementView {
  id: string;
  role: string;
  name: string;
  value?: string;
  states?: string[];
  actions?: string[];
  box?: [number, number, number, number];
  in?: string;
}

/**
 * Keeps recent UI Automation observations so actions can be bound to an
 * element seen in a *specific, fresh* observation of a *specific* window.
 * In memory only: observations never survive a restart.
 */
export class SnapshotStore {
  private readonly snaps = new Map<string, StoredSnapshot>();

  constructor(private readonly now: () => number = Date.now) {}

  put(target: TargetRef, raw: UiaSnapshotRaw): StoredSnapshot {
    this.prune();
    const s: StoredSnapshot = { id: newId('s_'), target, takenAt: this.now(), nodes: raw.nodes, window: raw.window };
    this.snaps.set(s.id, s);
    return s;
  }

  /** Resolves an element reference, refusing stale snapshots or a different window. */
  resolve(snapshotId: string, elementId: string, target: TargetRef): { snapshot: StoredSnapshot; node: UiaNodeRaw } {
    const s = this.snaps.get(snapshotId);
    if (!s) throw new CapabilityError('stale_observation', 'That observation is unknown or expired. Inspect the window again (desktop__inspect_window).');
    if (this.now() - s.takenAt > SNAPSHOT_MAX_AGE_MS) {
      throw new CapabilityError('stale_observation', 'That observation is older than 2 minutes. Inspect the window again before acting.');
    }
    if (s.target.hwnd !== target.hwnd || s.target.pid !== target.pid) {
      throw new CapabilityError('target_changed', 'That element belongs to a different window than the target.');
    }
    const idx = Number(/^e(\d+)$/.exec(elementId)?.[1] ?? NaN);
    const node = Number.isInteger(idx) ? s.nodes[idx] : undefined;
    if (!node) throw new CapabilityError('unknown_element', `No element "${elementId}" in observation ${snapshotId}.`);
    return { snapshot: s, node };
  }

  private prune(): void {
    const cutoff = this.now() - SNAPSHOT_MAX_AGE_MS * 3;
    for (const [k, v] of this.snaps) if (v.takenAt < cutoff) this.snaps.delete(k);
    while (this.snaps.size > 50) {
      const oldest = this.snaps.keys().next().value as string;
      this.snaps.delete(oldest);
    }
  }

  clear(): void {
    this.snaps.clear();
  }
}

const INTERESTING_ROLES = new Set([
  'button', 'checkbox', 'combobox', 'edit', 'hyperlink', 'listitem', 'menuitem', 'menu', 'radiobutton', 'tabitem', 'treeitem',
  'dataitem', 'slider', 'spinner', 'splitbutton', 'document', 'list', 'tab', 'menubar', 'toolbar', 'text', 'header', 'headeritem', 'window',
]);

/** True for dialog-like containers (native or web modal dialogs). */
export function isDialogNode(n: UiaNodeRaw): boolean {
  const lct = (n.lct ?? '').toLowerCase();
  return n.depth > 0 && (lct.includes('dialog') || lct.includes('alert') || (n.role === 'window' && n.depth > 0));
}

/** Reduces a raw tree to the elements a model can reason about. */
export function compactNodes(nodes: UiaNodeRaw[], limit = 260): { elements: ElementView[]; dialogs: string[]; omitted: number } {
  const dialogs: string[] = [];
  const out: ElementView[] = [];
  let omitted = 0;
  // Index of the nearest named container, for orientation ("in").
  const containerName = (n: UiaNodeRaw): string | undefined => {
    let p = n.parent;
    for (let hops = 0; p >= 0 && hops < 6; hops++) {
      const q = nodes[p];
      if (!q) break;
      if (q.name && ['list', 'tab', 'toolbar', 'menu', 'menubar', 'group', 'pane', 'window', 'document', 'dataitem'].includes(q.role)) return q.name.slice(0, 60);
      p = q.parent;
    }
    return undefined;
  };
  nodes.forEach((n, i) => {
    if (isDialogNode(n) && n.name) dialogs.push(n.name.slice(0, 120));
    const actionable = (n.patterns ?? []).some((p) => p !== 'text' && p !== 'scroll');
    const keep = INTERESTING_ROLES.has(n.role) && (n.name || n.value !== undefined || actionable) && !(n.offscreen && !actionable);
    if (!keep) return;
    if (out.length >= limit) {
      omitted++;
      return;
    }
    const states: string[] = [];
    if (n.disabled) states.push('disabled');
    if (n.focused) states.push('focused');
    if (n.selected) states.push('selected');
    if (n.toggle && n.toggle !== 'indeterminate') states.push(n.toggle === 'on' ? 'checked' : 'unchecked');
    if (n.expanded && n.expanded !== 'leafnode') states.push(n.expanded);
    if (n.offscreen) states.push('offscreen');
    if (n.readonly) states.push('readonly');
    if (n.password) states.push('password');
    const v: ElementView = { id: `e${i}`, role: n.role, name: n.name };
    if (n.value !== undefined && n.value !== n.name && !n.password) v.value = n.value.slice(0, 200);
    if (states.length) v.states = states;
    const actions = (n.patterns ?? []).filter((p) => p !== 'text');
    if (actions.length) v.actions = actions;
    if (n.x !== undefined && n.w) v.box = [n.x, n.y ?? 0, n.w, n.h ?? 0];
    const c = containerName(n);
    if (c) v.in = c;
    out.push(v);
  });
  return { elements: out, dialogs, omitted };
}

/**
 * Controls whose activation commonly has external or destructive effects.
 * These always need a fresh, per-action approval — never a navigation grant.
 */
const SENSITIVE = /\b(send|delete|remove|erase|discard|submit|pay|buy|purchase|order|checkout|check out|confirm|post|publish|share|transfer|withdraw|sign in|signin|log ?in|log ?out|sign out|install|uninstall|format|reset|accept|allow|agree|grant|unsubscribe|block|report|leave|exit|quit|close account|deactivate|archive|forward|reply all|call|video call|apply|save|upload|download)\b/i;

export function isSensitiveControl(n: Pick<UiaNodeRaw, 'name' | 'aid'>): boolean {
  return SENSITIVE.test(n.name ?? '') || SENSITIVE.test(n.aid ?? '');
}

/** Whether a fresh read of an element still matches what was observed. */
export function sameElement(before: UiaNodeRaw, now: UiaNodeRaw | null): boolean {
  if (!now) return false;
  return now.role === before.role && now.name === before.name;
}
