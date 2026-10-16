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

  recordUsage(u: { providerId: string; model: string; inputTokens: number; outputTokens: number; correlationId?: string }): void {
    this.db.run(
      'INSERT INTO usage_log (id, ts, provider_id, model, input_tokens, output_tokens, correlation_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [newId(), nowIso(), u.providerId, u.model, u.inputTokens, u.outputTokens, u.correlationId ?? null],
    );
  }
}
