import type { AuditRecord } from '../../shared/domain';
import { parseJson, type Database } from '../db/database';
import { redact } from '../logging/redact';
import { nowIso } from '../util/errors';
import { newId } from '../util/ids';

interface Row {
  id: string;
  ts: string;
  kind: string;
  capability_id: string | null;
  task_id: string | null;
  decision: string;
  detail: string;
  correlation_id: string | null;
}

/**
 * Durable audit trail of capability admission, permission decisions and
 * execution outcomes. Detail payloads are redacted before storage.
 */
export class AuditRepo {
  constructor(private readonly db: Database) {}

  record(entry: {
    kind: string;
    decision: string;
    capabilityId?: string | null;
    taskId?: string | null;
    detail?: Record<string, unknown>;
    correlationId?: string | null;
  }): void {
    this.db.run(
      'INSERT INTO audit_log (id, ts, kind, capability_id, task_id, decision, detail, correlation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        newId(),
        nowIso(),
        entry.kind,
        entry.capabilityId ?? null,
        entry.taskId ?? null,
        entry.decision,
        JSON.stringify(redact(entry.detail ?? {})),
        entry.correlationId ?? null,
      ],
    );
  }

  recent(limit: number): AuditRecord[] {
    return this.db.all<Row>('SELECT * FROM audit_log ORDER BY ts DESC, rowid DESC LIMIT ?', [limit]).map((r) => ({
      id: r.id,
      ts: r.ts,
      kind: r.kind,
      capabilityId: r.capability_id,
      taskId: r.task_id,
      decision: r.decision,
      detail: parseJson<Record<string, unknown>>(r.detail, {}),
      correlationId: r.correlation_id,
    }));
  }

  /** US dollars Keo spent on the user's fal.ai account since a time (from what it recorded for each paid request). */
  falSpentSince(since: string): number {
    const rows = this.db.all<{ detail: string }>("SELECT detail FROM audit_log WHERE ts >= ? AND kind IN ('studio.ai_shot', 'studio.character_swap', 'studio.character_picture', 'studio.character_voice', 'studio.talking_character', 'studio.ai_music', 'studio.ai_sound') AND decision = 'sent'", [since]);
    let total = 0;
    for (const r of rows) {
      const d = parseJson<{ destination?: unknown; costUsd?: unknown }>(r.detail, {});
      if (d.destination === 'fal.ai' && typeof d.costUsd === 'number' && Number.isFinite(d.costUsd)) total += d.costUsd;
    }
    return Math.round(total * 100) / 100;
  }

  recordUsage(u: { providerId: string; model: string; inputTokens: number; outputTokens: number; correlationId?: string; durationMs?: number }): void {
    this.db.run(
      'INSERT INTO usage_log (id, ts, provider_id, model, input_tokens, output_tokens, correlation_id, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [newId(), nowIso(), u.providerId, u.model, u.inputTokens, u.outputTokens, u.correlationId ?? null, u.durationMs === undefined ? null : Math.round(u.durationMs)],
    );
  }

  /** How each model has been doing lately: calls, typical and slow answer times, tokens (newest `days` days). */
  modelSpeeds(days = 7): Array<{ providerId: string; model: string; calls: number; medianMs: number; slowMs: number; inputTokens: number; outputTokens: number }> {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const rows = this.db.all<{ provider_id: string; model: string; duration_ms: number | null; input_tokens: number; output_tokens: number }>(
      'SELECT provider_id, model, duration_ms, input_tokens, output_tokens FROM usage_log WHERE ts >= ?',
      [since],
    );
    const by = new Map<string, { providerId: string; model: string; ms: number[]; calls: number; inputTokens: number; outputTokens: number }>();
    for (const r of rows) {
      const k = `${r.provider_id}|${r.model}`;
      const g = by.get(k) ?? { providerId: r.provider_id, model: r.model, ms: [], calls: 0, inputTokens: 0, outputTokens: 0 };
      g.calls++;
      g.inputTokens += r.input_tokens;
      g.outputTokens += r.output_tokens;
      if (typeof r.duration_ms === 'number') g.ms.push(r.duration_ms);
      by.set(k, g);
    }
    const at = (ms: number[], q: number) => (ms.length ? [...ms].sort((a, b) => a - b)[Math.min(ms.length - 1, Math.floor(ms.length * q))]! : 0);
    return [...by.values()].map((g) => ({ providerId: g.providerId, model: g.model, calls: g.calls, medianMs: at(g.ms, 0.5), slowMs: at(g.ms, 0.9), inputTokens: g.inputTokens, outputTokens: g.outputTokens })).sort((a, b) => b.calls - a.calls);
  }
}
