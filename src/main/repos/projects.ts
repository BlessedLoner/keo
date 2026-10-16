import type { MemoryProvenance, Project, ProjectItem, ProjectItemStatus, ProjectItemType, ProjectStatus } from '../../shared/domain';
import type { Database } from '../db/database';
import { KeoError, nowIso } from '../util/errors';
import { newId } from '../util/ids';

interface ProjectRow {
  id: string;
  name: string;
  description: string;
  status: ProjectStatus;
  created_at: string;
  updated_at: string;
  open_count: number;
}

interface ItemRow {
  id: string;
  project_id: string;
  type: ProjectItemType;
  content: string;
  status: ProjectItemStatus;
  provenance: MemoryProvenance;
  source_conversation_id: string | null;
  source_message_id: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT = `SELECT p.*, (SELECT count(*) FROM project_items i WHERE i.project_id = p.id AND i.status IN ('open','proposed')) AS open_count FROM projects p`;

const toProject = (r: ProjectRow): Project => ({
  id: r.id,
  name: r.name,
  description: r.description,
  status: r.status,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  openItemCount: r.open_count,
});

const toItem = (r: ItemRow): ProjectItem => ({
  id: r.id,
  projectId: r.project_id,
  type: r.type,
  content: r.content,
  status: r.status,
  provenance: r.provenance,
  sourceConversationId: r.source_conversation_id,
  sourceMessageId: r.source_message_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class ProjectRepo {
  constructor(private readonly db: Database) {}

  list(): Project[] {
    return this.db.all<ProjectRow>(`${SELECT} ORDER BY CASE p.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, p.updated_at DESC`).map(toProject);
  }

  get(id: string): Project | null {
    const r = this.db.get<ProjectRow>(`${SELECT} WHERE p.id = ?`, [id]);
    return r ? toProject(r) : null;
  }

  require(id: string): Project {
    const p = this.get(id);
    if (!p) throw new KeoError('not_found', 'Project not found.');
    return p;
  }

  findByName(name: string): Project | null {
    const r = this.db.get<ProjectRow>(`${SELECT} WHERE lower(p.name) = lower(?)`, [name.trim()]);
    return r ? toProject(r) : null;
  }

  create(name: string, description = ''): Project {
    if (this.findByName(name)) throw new KeoError('conflict', 'A project with this name already exists.');
    const id = newId();
    const now = nowIso();
    this.db.run('INSERT INTO projects (id, name, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [
      id,
      name.trim(),
      description.trim(),
      'active',
      now,
      now,
    ]);
    return this.require(id);
  }

  update(id: string, patch: { name?: string; description?: string; status?: ProjectStatus }): Project {
    const cur = this.require(id);
    if (patch.name && patch.name.trim().toLowerCase() !== cur.name.toLowerCase() && this.findByName(patch.name)) {
      throw new KeoError('conflict', 'A project with this name already exists.');
    }
    this.db.run('UPDATE projects SET name = ?, description = ?, status = ?, updated_at = ? WHERE id = ?', [
      patch.name?.trim() ?? cur.name,
      patch.description?.trim() ?? cur.description,
      patch.status ?? cur.status,
      nowIso(),
      id,
    ]);
    return this.require(id);
  }

  delete(id: string): boolean {
    return this.db.run('DELETE FROM projects WHERE id = ?', [id]).changes > 0;
  }

  items(projectId: string): ProjectItem[] {
    return this.db
      .all<ItemRow>(
        "SELECT * FROM project_items WHERE project_id = ? ORDER BY CASE status WHEN 'proposed' THEN 0 WHEN 'open' THEN 1 WHEN 'resolved' THEN 2 ELSE 3 END, created_at DESC",
        [projectId],
      )
      .map(toItem);
  }

  getItem(id: string): ProjectItem | null {
    const r = this.db.get<ItemRow>('SELECT * FROM project_items WHERE id = ?', [id]);
    return r ? toItem(r) : null;
  }

  addItem(input: {
    projectId: string;
    type: ProjectItemType;
    content: string;
    status: ProjectItemStatus;
    provenance: MemoryProvenance;
    sourceConversationId?: string | null;
    sourceMessageId?: string | null;
  }): ProjectItem {
    this.require(input.projectId);
    if (input.provenance === 'model_inferred' && input.status !== 'proposed') {
      throw new KeoError('invalid_state', 'Model-inferred project items must start as proposals.');
    }
    const id = newId();
    const now = nowIso();
    this.db.tx(() => {
      this.db.run(
        `INSERT INTO project_items (id, project_id, type, content, status, provenance, source_conversation_id, source_message_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.projectId,
          input.type,
          input.content.trim(),
          input.status,
          input.provenance,
          input.sourceConversationId ?? null,
          input.sourceMessageId ?? null,
          now,
          now,
        ],
      );
      this.db.run('UPDATE projects SET updated_at = ? WHERE id = ?', [now, input.projectId]);
    });
    return this.getItem(id) as ProjectItem;
  }

  setItemStatus(id: string, status: Exclude<ProjectItemStatus, 'proposed'>): ProjectItem {
    const cur = this.getItem(id);
    if (!cur) throw new KeoError('not_found', 'Project item not found.');
    // Accepting a model proposal records explicit user confirmation.
    const provenance = cur.provenance === 'model_inferred' && status !== 'rejected' ? 'user_confirmed' : cur.provenance;
    this.db.run('UPDATE project_items SET status = ?, provenance = ?, updated_at = ? WHERE id = ?', [status, provenance, nowIso(), id]);
    return this.getItem(id) as ProjectItem;
  }

  deleteItem(id: string): boolean {
    return this.db.run('DELETE FROM project_items WHERE id = ?', [id]).changes > 0;
  }
}
