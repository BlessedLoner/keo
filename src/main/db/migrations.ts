/**
 * Ordered, append-only schema migrations. Never edit a shipped migration —
 * add a new one. Each runs inside a transaction and is recorded in
 * schema_migrations.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
  /** Table rebuilds must run with foreign keys off so dependent rows are not cascaded away. */
  foreignKeysOff?: boolean;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('active','paused','done','archived')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user','assistant','note')),
        content TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('complete','streaming','interrupted','error','cancelled')),
        created_at TEXT NOT NULL,
        meta TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at);

      CREATE TABLE project_items (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('objective','decision','blocker','question','progress')),
        content TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('proposed','open','resolved','rejected')),
        provenance TEXT NOT NULL CHECK (provenance IN ('user_authored','user_confirmed','model_inferred')),
        source_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
        source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_project_items_project ON project_items(project_id);

      CREATE TABLE memory_items (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('fact','preference','instruction','person','context')),
        subject TEXT,
        content TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('proposed','confirmed','superseded','rejected')),
        provenance TEXT NOT NULL CHECK (provenance IN ('user_authored','user_confirmed','model_inferred')),
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        source_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
        source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        source_excerpt TEXT,
        superseded_by TEXT REFERENCES memory_items(id) ON DELETE SET NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        confirmed_at TEXT
      );
      CREATE INDEX idx_memory_status ON memory_items(status);
      CREATE INDEX idx_memory_subject ON memory_items(subject);

      CREATE TABLE memory_revisions (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        content TEXT NOT NULL,
        changed_at TEXT NOT NULL,
        reason TEXT NOT NULL
      );

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        rationale TEXT NOT NULL DEFAULT '',
        origin TEXT NOT NULL CHECK (origin IN ('model','user','plan')),
        conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        note TEXT,
        correlation_id TEXT NOT NULL
      );
      CREATE INDEX idx_tasks_state ON tasks(state);

      CREATE TABLE task_steps (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        idx INTEGER NOT NULL,
        capability_id TEXT NOT NULL,
        capability_version TEXT NOT NULL,
        title TEXT NOT NULL,
        input TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        depends_on TEXT NOT NULL DEFAULT '[]',
        state TEXT NOT NULL,
        requires_approval INTEGER NOT NULL,
        approval TEXT,
        preview TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        result TEXT,
        error TEXT,
        error_code TEXT,
        verification TEXT NOT NULL DEFAULT 'not_applicable',
        verification_detail TEXT,
        started_at TEXT,
        finished_at TEXT
      );
      CREATE INDEX idx_steps_task ON task_steps(task_id, idx);
      CREATE INDEX idx_steps_state ON task_steps(state);

      CREATE TABLE execution_receipts (
        idempotency_key TEXT PRIMARY KEY,
        step_id TEXT NOT NULL,
        capability_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('started','finished','not_dispatched')),
        started_at TEXT NOT NULL,
        finished_at TEXT,
        result TEXT
      );

      CREATE TABLE audit_log (
        id TEXT PRIMARY KEY,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL,
        capability_id TEXT,
        task_id TEXT,
        decision TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '{}',
        correlation_id TEXT
      );
      CREATE INDEX idx_audit_ts ON audit_log(ts);

      CREATE TABLE observations (
        id TEXT PRIMARY KEY,
        hwnd TEXT NOT NULL,
        pid INTEGER NOT NULL,
        process_name TEXT NOT NULL,
        title TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        method TEXT NOT NULL,
        image_file TEXT,
        initiated_by TEXT NOT NULL CHECK (initiated_by IN ('user','task')),
        task_id TEXT
      );

      CREATE TABLE observation_analyses (
        id TEXT PRIMARY KEY,
        observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
        provider_id TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt TEXT NOT NULL,
        result TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE usage_log (
        id TEXT PRIMARY KEY,
        ts TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        correlation_id TEXT
      );
    `,
  },
  {
    version: 2,
    name: 'memory_user_stated_provenance',
    foreignKeysOff: true,
    sql: `
      CREATE TABLE memory_items_v2 (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('fact','preference','instruction','person','context')),
        subject TEXT,
        content TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('proposed','confirmed','superseded','rejected')),
        provenance TEXT NOT NULL CHECK (provenance IN ('user_authored','user_confirmed','user_stated','model_inferred')),
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        source_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
        source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        source_excerpt TEXT,
        superseded_by TEXT REFERENCES memory_items(id) ON DELETE SET NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        confirmed_at TEXT
      );
      INSERT INTO memory_items_v2 SELECT id, kind, subject, content, status, provenance, project_id, source_conversation_id,
        source_message_id, source_excerpt, superseded_by, version, created_at, updated_at, confirmed_at FROM memory_items;
      DROP TABLE memory_items;
      ALTER TABLE memory_items_v2 RENAME TO memory_items;
      CREATE INDEX idx_memory_status ON memory_items(status);
      CREATE INDEX idx_memory_subject ON memory_items(subject);
    `,
  },
  {
    version: 3,
    name: 'photo_descriptions',
    sql: `
      CREATE TABLE photo_descriptions (
        path_key TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime_ms INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('described','skipped')),
        description TEXT NOT NULL,
        keywords TEXT NOT NULL,
        provider TEXT,
        model TEXT,
        created_at TEXT NOT NULL
      );
    `,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
