import type { MemoryItem, MemoryKind, MemoryProvenance, MemoryRevision, MemoryStatus } from '../../shared/domain';
import type { Database } from '../db/database';
import { containsSecret } from '../logging/redact';
import { KeoError, nowIso } from '../util/errors';
import { newId } from '../util/ids';

interface Row {
  id: string;
  kind: MemoryKind;
  subject: string | null;
  content: string;
  status: MemoryStatus;
  provenance: MemoryProvenance;
  project_id: string | null;
  source_conversation_id: string | null;
  source_message_id: string | null;
  source_excerpt: string | null;
  superseded_by: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  confirmed_at: string | null;
}

export interface ScoredMemory {
  item: MemoryItem;
  score: number;
}

const STOP = new Set(
  'a an and are as at be but by do does for from has have i if in into is it its me my no not of on or our so that the their them there these they this to was we were what when where which who why will with you your'.split(
    ' ',
  ),
);

export function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'_-]*/gu) ?? [])
    .map((t) => t.replace(/'s$/, ''))
    .filter((t) => t.length > 1 && !STOP.has(t));
}

export function normalizeSubject(s: string | null | undefined): string | null {
  if (!s) return null;
  const n = s.trim().toLowerCase().replace(/\s+/g, ' ');
  return n.length ? n.slice(0, 120) : null;
}

export class MemoryRepo {
  constructor(private readonly db: Database) {}

  private toItem(r: Row): MemoryItem {
    const conflicts =
      r.status === 'confirmed' && r.subject
        ? this.db
            .all<{ id: string }>("SELECT id FROM memory_items WHERE status = 'confirmed' AND subject = ? AND id != ?", [r.subject, r.id])
            .map((x) => x.id)
        : [];
    return {
      id: r.id,
      kind: r.kind,
      subject: r.subject,
      content: r.content,
      status: r.status,
      provenance: r.provenance,
      projectId: r.project_id,
      sourceConversationId: r.source_conversation_id,
      sourceMessageId: r.source_message_id,
      sourceExcerpt: r.source_excerpt,
      supersededBy: r.superseded_by,
      version: r.version,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      confirmedAt: r.confirmed_at,
      conflictsWith: conflicts,
    };
  }

  get(id: string): MemoryItem | null {
    const r = this.db.get<Row>('SELECT * FROM memory_items WHERE id = ?', [id]);
    return r ? this.toItem(r) : null;
  }

  require(id: string): MemoryItem {
    const m = this.get(id);
    if (!m) throw new KeoError('not_found', 'Memory not found.');
    return m;
  }

  list(status: MemoryStatus | 'all' = 'all', query?: string): MemoryItem[] {
    const where: string[] = [];
    const params: string[] = [];
    if (status !== 'all') {
      where.push('status = ?');
      params.push(status);
    }
    if (query && query.trim()) {
      where.push("(content LIKE ? ESCAPE '\\' OR subject LIKE ? ESCAPE '\\')");
      const like = `%${query.trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      params.push(like, like);
    }
    return this.db
      .all<Row>(`SELECT * FROM memory_items ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC LIMIT 2000`, params)
      .map((r) => this.toItem(r));
  }

  private guardContent(content: string): void {
    if (containsSecret(content)) {
      throw new KeoError(
        'sensitive_content',
        'This looks like it contains a credential or secret. Keo does not store secrets in memory.',
      );
    }
  }

  create(input: {
    kind: MemoryKind;
    subject?: string | null;
    content: string;
    status: MemoryStatus;
    provenance: MemoryProvenance;
    projectId?: string | null;
    sourceConversationId?: string | null;
    sourceMessageId?: string | null;
    sourceExcerpt?: string | null;
  }): MemoryItem {
    this.guardContent(input.content);
    if (input.provenance === 'model_inferred' && input.status === 'confirmed') {
      // A model interpretation must never become a confirmed fact on its own.
      throw new KeoError('invalid_state', 'Model-inferred memories must be confirmed by the user.');
    }
    const id = newId();
    const now = nowIso();
    this.db.run(
      `INSERT INTO memory_items (id, kind, subject, content, status, provenance, project_id, source_conversation_id,
        source_message_id, source_excerpt, version, created_at, updated_at, confirmed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      [
        id,
        input.kind,
        normalizeSubject(input.subject),
        input.content.trim(),
        input.status,
        input.provenance,
        input.projectId ?? null,
        input.sourceConversationId ?? null,
        input.sourceMessageId ?? null,
        input.sourceExcerpt ? input.sourceExcerpt.slice(0, 500) : null,
        now,
        now,
        input.status === 'confirmed' ? now : null,
      ],
    );
    return this.require(id);
  }

  update(id: string, content: string, subject: string | null | undefined, reason = 'user_edit'): MemoryItem {
    this.guardContent(content);
    const cur = this.require(id);
    this.db.tx(() => {
      this.db.run('INSERT INTO memory_revisions (id, memory_id, version, content, changed_at, reason) VALUES (?, ?, ?, ?, ?, ?)', [
        newId(),
        id,
        cur.version,
        cur.content,
        nowIso(),
        reason,
      ]);
      // Provenance and status are unchanged: editing a proposal does not confirm it.
      this.db.run('UPDATE memory_items SET content = ?, subject = ?, version = version + 1, updated_at = ? WHERE id = ?', [
        content.trim(),
        subject === undefined ? cur.subject : normalizeSubject(subject),
        nowIso(),
        id,
      ]);
    });
    return this.require(id);
  }

  confirm(id: string): MemoryItem {
    const cur = this.require(id);
    if (cur.status !== 'proposed') throw new KeoError('invalid_state', `Only proposed memories can be confirmed (is ${cur.status}).`);
    const now = nowIso();
    this.db.run("UPDATE memory_items SET status = 'confirmed', provenance = 'user_confirmed', confirmed_at = ?, updated_at = ? WHERE id = ?", [
      now,
      now,
      id,
    ]);
    return this.require(id);
  }

  reject(id: string): MemoryItem {
    const cur = this.require(id);
    if (cur.status !== 'proposed') throw new KeoError('invalid_state', 'Only proposed memories can be rejected.');
    this.db.run("UPDATE memory_items SET status = 'rejected', updated_at = ? WHERE id = ?", [nowIso(), id]);
    return this.require(id);
  }

  /** User resolves a conflict: `keepId` stays, `supersededId` is retained for history but no longer used. */
  supersede(keepId: string, supersededId: string): MemoryItem {
    if (keepId === supersededId) throw new KeoError('invalid_input', 'A memory cannot supersede itself.');
    const keep = this.require(keepId);
    this.require(supersededId);
    if (keep.status !== 'confirmed') throw new KeoError('invalid_state', 'Only a confirmed memory can supersede another.');
    this.db.run("UPDATE memory_items SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?", [
      keepId,
      nowIso(),
      supersededId,
    ]);
    return this.require(supersededId);
  }

  delete(id: string): boolean {
    return this.db.run('DELETE FROM memory_items WHERE id = ?', [id]).changes > 0;
  }

  revisions(id: string): MemoryRevision[] {
    return this.db
      .all<{ id: string; memory_id: string; version: number; content: string; changed_at: string; reason: string }>(
        'SELECT * FROM memory_revisions WHERE memory_id = ? ORDER BY version DESC',
        [id],
      )
      .map((r) => ({ id: r.id, memoryId: r.memory_id, version: r.version, content: r.content, changedAt: r.changed_at, reason: r.reason }));
  }

  /**
   * Bounded lexical retrieval over confirmed memories (BM25-style term
   * weighting + small boosts for subject match, project match and recency).
   * Only confirmed memories are eligible — proposals are never presented to
   * the model as known facts.
   */
  search(query: string, opts: { limit: number; projectId?: string | null; includeProposed?: boolean }): ScoredMemory[] {
    if (opts.limit <= 0) return [];
    const statuses = opts.includeProposed ? "('confirmed','proposed')" : "('confirmed')";
    const rows = this.db.all<Row>(`SELECT * FROM memory_items WHERE status IN ${statuses} ORDER BY updated_at DESC LIMIT 5000`);
    if (!rows.length) return [];
    const qTerms = [...new Set(tokenize(query))];
    const docs = rows.map((r) => ({ r, terms: tokenize(`${r.subject ?? ''} ${r.content}`) }));
    const N = docs.length;
    const avgLen = docs.reduce((a, d) => a + d.terms.length, 0) / N || 1;
    const df = new Map<string, number>();
    for (const d of docs) for (const t of new Set(d.terms)) df.set(t, (df.get(t) ?? 0) + 1);
    const k1 = 1.2;
    const b = 0.75;
    const now = Date.now();
    const scored: ScoredMemory[] = [];
    for (const d of docs) {
      let s = 0;
      for (const q of qTerms) {
        const tf = d.terms.filter((t) => t === q || (q.length > 4 && t.startsWith(q.slice(0, -1)))).length;
        if (!tf) continue;
        const idf = Math.log(1 + (N - (df.get(q) ?? 0) + 0.5) / ((df.get(q) ?? 0) + 0.5));
        s += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * d.terms.length) / avgLen)));
      }
      const subj = d.r.subject ?? '';
      if (subj && qTerms.some((q) => subj.includes(q))) s += 0.5;
      const isProfile = d.r.kind === 'preference' || d.r.kind === 'instruction';
      if (s === 0 && !isProfile) continue;
      if (s === 0 && isProfile) s = 0.05; // standing preferences are always weakly relevant
      if (opts.projectId && d.r.project_id === opts.projectId) s *= 1.3;
      const ageDays = (now - Date.parse(d.r.updated_at)) / 86_400_000;
      s *= 1 + 0.1 / (1 + ageDays / 30);
      scored.push({ item: this.toItem(d.r), score: Number(s.toFixed(4)) });
    }
    scored.sort((a, b2) => b2.score - a.score);
    return scored.slice(0, opts.limit);
  }

  deleteAll(): void {
    this.db.run('DELETE FROM memory_items');
  }
}
