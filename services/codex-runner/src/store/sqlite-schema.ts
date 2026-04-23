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
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(task_id) REFERENCES runner_tasks(task_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS runner_sessions_task_id_idx
      ON runner_sessions (task_id);
  `);
}
