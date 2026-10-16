import type { Conversation, Message, MessageMeta, MessageRole, MessageStatus } from '../../shared/domain';
import { parseJson, type Database } from '../db/database';
import { KeoError, nowIso } from '../util/errors';
import { newId } from '../util/ids';

interface ConvRow {
  id: string;
  title: string;
  project_id: string | null;
  created_at: string;
  updated_at: string;
  message_count: number;
}

interface MsgRow {
  id: string;
  conversation_id: string;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  created_at: string;
  meta: string;
}

const toConversation = (r: ConvRow): Conversation => ({
  id: r.id,
  title: r.title,
  projectId: r.project_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  messageCount: r.message_count,
});

const toMessage = (r: MsgRow): Message => ({
  id: r.id,
  conversationId: r.conversation_id,
  role: r.role,
  content: r.content,
  status: r.status,
  createdAt: r.created_at,
  meta: parseJson<MessageMeta>(r.meta, {}),
});

const CONV_SELECT = `
  SELECT c.id, c.title, c.project_id, c.created_at, c.updated_at,
         (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
  FROM conversations c`;

export class ConversationRepo {
  constructor(private readonly db: Database) {}

  list(opts: { projectId?: string | null; query?: string } = {}): Conversation[] {
    const where: string[] = [];
    const params: string[] = [];
    if (opts.projectId) {
      where.push('c.project_id = ?');
      params.push(opts.projectId);
    }
    if (opts.query && opts.query.trim()) {
      where.push(
        "(c.title LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.content LIKE ? ESCAPE '\\'))",
      );
      const like = `%${opts.query.trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      params.push(like, like);
    }
    const sql = `${CONV_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY c.updated_at DESC LIMIT 500`;
    return this.db.all<ConvRow>(sql, params).map(toConversation);
  }

  get(id: string): Conversation | null {
    const r = this.db.get<ConvRow>(`${CONV_SELECT} WHERE c.id = ?`, [id]);
    return r ? toConversation(r) : null;
  }

  require(id: string): Conversation {
    const c = this.get(id);
    if (!c) throw new KeoError('not_found', 'Conversation not found.');
    return c;
  }

  create(title = 'New conversation', projectId: string | null = null): Conversation {
    const id = newId();
    const now = nowIso();
    this.db.run('INSERT INTO conversations (id, title, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [
      id,
      title.trim() || 'New conversation',
      projectId,
      now,
      now,
    ]);
    return this.require(id);
  }

  rename(id: string, title: string): Conversation {
    const r = this.db.run('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?', [title.trim(), nowIso(), id]);
    if (r.changes === 0) throw new KeoError('not_found', 'Conversation not found.');
    return this.require(id);
  }

  setProject(id: string, projectId: string | null): Conversation {
    const r = this.db.run('UPDATE conversations SET project_id = ?, updated_at = ? WHERE id = ?', [projectId, nowIso(), id]);
    if (r.changes === 0) throw new KeoError('not_found', 'Conversation not found.');
    return this.require(id);
  }

  delete(id: string): boolean {
    return this.db.run('DELETE FROM conversations WHERE id = ?', [id]).changes > 0;
  }

  touch(id: string): void {
    this.db.run('UPDATE conversations SET updated_at = ? WHERE id = ?', [nowIso(), id]);
  }

  // -- messages --------------------------------------------------------------

  messages(conversationId: string): Message[] {
    return this.db
      .all<MsgRow>('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC', [conversationId])
      .map(toMessage);
  }

  /** Most recent `limit` messages in chronological order. */
  recentMessages(conversationId: string, limit: number): Message[] {
    return this.db
      .all<MsgRow>(
        'SELECT * FROM (SELECT *, rowid AS rid FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?) ORDER BY created_at ASC, rid ASC',
        [conversationId, limit],
      )
      .map(toMessage);
  }

  getMessage(id: string): Message | null {
    const r = this.db.get<MsgRow>('SELECT * FROM messages WHERE id = ?', [id]);
    return r ? toMessage(r) : null;
  }

  addMessage(m: { conversationId: string; role: MessageRole; content: string; status: MessageStatus; meta?: MessageMeta }): Message {
    const id = newId();
    const now = nowIso();
    this.db.tx(() => {
      this.db.run(
        'INSERT INTO messages (id, conversation_id, role, content, status, created_at, meta) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, m.conversationId, m.role, m.content, m.status, now, JSON.stringify(m.meta ?? {})],
      );
      this.db.run('UPDATE conversations SET updated_at = ? WHERE id = ?', [now, m.conversationId]);
    });
    return this.getMessage(id) as Message;
  }

  updateMessage(id: string, patch: { content?: string; status?: MessageStatus; meta?: MessageMeta }): Message {
    const cur = this.getMessage(id);
    if (!cur) throw new KeoError('not_found', 'Message not found.');
    this.db.run('UPDATE messages SET content = ?, status = ?, meta = ? WHERE id = ?', [
      patch.content ?? cur.content,
      patch.status ?? cur.status,
      JSON.stringify(patch.meta ?? cur.meta),
      id,
    ]);
    return this.getMessage(id) as Message;
  }

  deleteMessage(id: string): void {
    this.db.run('DELETE FROM messages WHERE id = ?', [id]);
  }

  /**
   * Startup recovery: any message still marked "streaming" was interrupted by
   * a crash or forced exit. Keep the partial text and label it honestly.
   */
  markInterrupted(): number {
    return this.db.run("UPDATE messages SET status = 'interrupted' WHERE status = 'streaming'").changes;
  }
}
