import type { DatabaseSync } from "node:sqlite";

export function bootstrapCodexRunnerSchema(connection: DatabaseSync): void {
  connection.exec(`
    CREATE TABLE IF NOT EXISTS runner_tasks (
      task_id TEXT PRIMARY KEY,
      repo_path TEXT NOT NULL,
      prompt TEXT NOT NULL,
      priority INTEGER NOT NULL,
      state TEXT NOT NULL,
      worktree_path TEXT,
      active_session_id TEXT,
      pending_approval_request_id TEXT,
      pending_approval_requested_action TEXT,
      pending_approval_reason TEXT,
      pending_approval_session_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK (
        (pending_approval_request_id IS NULL AND pending_approval_requested_action IS NULL
         AND pending_approval_reason IS NULL AND pending_approval_session_id IS NULL)
        OR (pending_approval_request_id IS NOT NULL AND pending_approval_requested_action IS NOT NULL
         AND pending_approval_reason IS NOT NULL AND pending_approval_session_id IS NOT NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS runner_tasks_state_idx
      ON runner_tasks (state);

    CREATE TABLE IF NOT EXISTS runner_sessions (
      session_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      pid INTEGER,
      state TEXT NOT NULL,
      exit_code INTEGER,
      pending_approval_request_id TEXT,
      pending_approval_requested_action TEXT,
      pending_approval_reason TEXT,
      pending_approval_session_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(task_id) REFERENCES runner_tasks(task_id) ON DELETE CASCADE,
      CHECK (
        (pending_approval_request_id IS NULL AND pending_approval_requested_action IS NULL
         AND pending_approval_reason IS NULL AND pending_approval_session_id IS NULL)
        OR (pending_approval_request_id IS NOT NULL AND pending_approval_requested_action IS NOT NULL
         AND pending_approval_reason IS NOT NULL AND pending_approval_session_id IS NOT NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS runner_sessions_task_id_idx
      ON runner_sessions (task_id);
  `);

  ensureColumn(connection, "runner_tasks", "pending_approval_request_id", "TEXT");
  ensureColumn(connection, "runner_tasks", "pending_approval_requested_action", "TEXT");
  ensureColumn(connection, "runner_tasks", "pending_approval_reason", "TEXT");
  ensureColumn(connection, "runner_tasks", "pending_approval_session_id", "TEXT");
  ensureColumn(connection, "runner_sessions", "pending_approval_request_id", "TEXT");
  ensureColumn(connection, "runner_sessions", "pending_approval_requested_action", "TEXT");
  ensureColumn(connection, "runner_sessions", "pending_approval_reason", "TEXT");
  ensureColumn(connection, "runner_sessions", "pending_approval_session_id", "TEXT");
}

function ensureColumn(
  connection: DatabaseSync,
  tableName: string,
  columnName: string,
  columnDefinition: string,
): void {
  const columns = connection
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as Array<{ name: string }>;

  if (columns.some((column) => column.name === columnName)) {
    return;
  }

  connection.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
}
