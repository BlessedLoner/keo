import type { Observation, ObservationAnalysis, ProviderId } from '../../shared/domain';
import type { Database } from '../db/database';
import { nowIso } from '../util/errors';
import { newId } from '../util/ids';

interface Row {
  id: string;
  hwnd: string;
  pid: number;
  process_name: string;
  title: string;
  captured_at: string;
  width: number;
  height: number;
  sha256: string;
  method: 'electron.desktopCapturer';
  image_file: string | null;
  initiated_by: 'user' | 'task';
  task_id: string | null;
}

const toObs = (r: Row): Observation => ({
  id: r.id,
  target: { hwnd: r.hwnd, pid: r.pid, processName: r.process_name, title: r.title },
  capturedAt: r.captured_at,
  width: r.width,
  height: r.height,
  sha256: r.sha256,
  method: r.method,
  hasImage: !!r.image_file,
  initiatedBy: r.initiated_by,
  taskId: r.task_id,
});

export class ObservationRepo {
  constructor(private readonly db: Database) {}

  insert(o: Omit<Observation, 'id' | 'hasImage'> & { imageFile: string | null }, id = newId()): Observation {
    this.db.run(
      `INSERT INTO observations (id, hwnd, pid, process_name, title, captured_at, width, height, sha256, method, image_file, initiated_by, task_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        o.target.hwnd,
        o.target.pid,
        o.target.processName,
        o.target.title,
        o.capturedAt,
        o.width,
        o.height,
        o.sha256,
        o.method,
        o.imageFile,
        o.initiatedBy,
        o.taskId,
      ],
    );
    return this.get(id) as Observation;
  }

  get(id: string): Observation | null {
    const r = this.db.get<Row>('SELECT * FROM observations WHERE id = ?', [id]);
    return r ? toObs(r) : null;
  }

  imageFile(id: string): string | null {
    return this.db.get<{ image_file: string | null }>('SELECT image_file FROM observations WHERE id = ?', [id])?.image_file ?? null;
  }

  list(limit: number): Observation[] {
    return this.db.all<Row>('SELECT * FROM observations ORDER BY captured_at DESC LIMIT ?', [limit]).map(toObs);
  }

  clearImage(id: string): void {
    this.db.run('UPDATE observations SET image_file = NULL WHERE id = ?', [id]);
  }

  /** Observations whose image is older than the retention cutoff. */
  expiredImages(cutoffIso: string): Array<{ id: string; file: string }> {
    return this.db
      .all<{ id: string; image_file: string }>('SELECT id, image_file FROM observations WHERE image_file IS NOT NULL AND captured_at < ?', [cutoffIso])
      .map((r) => ({ id: r.id, file: r.image_file }));
  }

  delete(id: string): boolean {
    return this.db.run('DELETE FROM observations WHERE id = ?', [id]).changes > 0;
  }

  addAnalysis(a: { observationId: string; providerId: ProviderId; model: string; prompt: string; result: string }): ObservationAnalysis {
    const id = newId();
    const createdAt = nowIso();
    this.db.run(
      'INSERT INTO observation_analyses (id, observation_id, provider_id, model, prompt, result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, a.observationId, a.providerId, a.model, a.prompt, a.result, createdAt],
    );
    return { id, createdAt, ...a };
  }

  analyses(observationId: string): ObservationAnalysis[] {
    return this.db
      .all<{ id: string; observation_id: string; provider_id: ProviderId; model: string; prompt: string; result: string; created_at: string }>(
        'SELECT * FROM observation_analyses WHERE observation_id = ? ORDER BY created_at DESC',
        [observationId],
      )
      .map((r) => ({
        id: r.id,
        observationId: r.observation_id,
        providerId: r.provider_id,
        model: r.model,
        prompt: r.prompt,
        result: r.result,
        createdAt: r.created_at,
      }));
  }
}
