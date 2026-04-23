import type { DatabaseSync } from "node:sqlite";

import type { RunnerSessionRecord, SessionStore } from "../contracts.js";

interface RunnerSessionRow {
  session_id: string;
  task_id: string;
  worktree_path: string;
  pid: number | null;
  state: RunnerSessionRecord["state"];
  exit_code: number | null;
  pending_approval_request_id: string | null;
  pending_approval_requested_action: string | null;
  pending_approval_reason: string | null;
  pending_approval_session_id: string | null;
}

export class SqliteSessionStore implements SessionStore {
  readonly #connection: DatabaseSync;

  constructor(connection: DatabaseSync) {
    this.#connection = connection;
  }

  async saveSession(session: RunnerSessionRecord): Promise<void> {
    this.#connection
      .prepare(`
        INSERT INTO runner_sessions (
          session_id,
          task_id,
          worktree_path,
          pid,
          state,
          exit_code,
          pending_approval_request_id,
          pending_approval_requested_action,
          pending_approval_reason,
          pending_approval_session_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          task_id = excluded.task_id,
          worktree_path = excluded.worktree_path,
          pid = excluded.pid,
          state = excluded.state,
          exit_code = excluded.exit_code,
          pending_approval_request_id = excluded.pending_approval_request_id,
          pending_approval_requested_action = excluded.pending_approval_requested_action,
          pending_approval_reason = excluded.pending_approval_reason,
          pending_approval_session_id = excluded.pending_approval_session_id,
          updated_at = CURRENT_TIMESTAMP
      `)
      .run(
        session.sessionId,
        session.taskId,
        session.worktreePath,
        session.pid ?? null,
        session.state,
        session.exitCode ?? null,
        session.pendingApproval?.approvalRequestId ?? null,
        session.pendingApproval?.requestedAction ?? null,
        session.pendingApproval?.reason ?? null,
        session.pendingApproval?.sessionId ?? null,
      );
  }

  async getSession(sessionId: string): Promise<RunnerSessionRecord | undefined> {
    const row = this.#connection
      .prepare(
        `
          SELECT
            session_id,
            task_id,
            worktree_path,
            pid,
            state,
            exit_code,
            pending_approval_request_id,
            pending_approval_requested_action,
            pending_approval_reason,
            pending_approval_session_id
          FROM runner_sessions
          WHERE session_id = ?
        `,
      )
      .get(sessionId) as RunnerSessionRow | undefined;

    return row ? mapRunnerSessionRow(row) : undefined;
  }

  async listSessionsByTask(taskId: string): Promise<RunnerSessionRecord[]> {
    const rows = this.#connection
      .prepare(
        `
          SELECT
            session_id,
            task_id,
            worktree_path,
            pid,
            state,
            exit_code,
            pending_approval_request_id,
            pending_approval_requested_action,
            pending_approval_reason,
            pending_approval_session_id
          FROM runner_sessions
          WHERE task_id = ?
          ORDER BY rowid ASC
        `,
      )
      .all(taskId) as unknown as RunnerSessionRow[];

    return rows.map(mapRunnerSessionRow);
  }
}

function mapRunnerSessionRow(row: RunnerSessionRow): RunnerSessionRecord {
  return {
    sessionId: row.session_id,
    taskId: row.task_id,
    worktreePath: row.worktree_path,
    pid: row.pid ?? undefined,
    state: row.state,
    exitCode: row.exit_code ?? undefined,
    ...(row.pending_approval_request_id &&
    row.pending_approval_requested_action &&
    row.pending_approval_reason &&
    row.pending_approval_session_id
      ? {
          pendingApproval: {
            approvalRequestId: row.pending_approval_request_id,
            requestedAction: row.pending_approval_requested_action,
            reason: row.pending_approval_reason,
            sessionId: row.pending_approval_session_id,
          },
        }
      : {}),
  };
}
