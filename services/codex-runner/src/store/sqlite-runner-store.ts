import type { DatabaseSync } from "node:sqlite";

import type { RunnerStore, RunnerTaskRecord, RunnerTaskState } from "../contracts.js";

interface RunnerTaskRow {
  task_id: string;
  repo_path: string;
  prompt: string;
  priority: number;
  state: RunnerTaskState;
  worktree_path: string | null;
  active_session_id: string | null;
  pending_approval_request_id: string | null;
  pending_approval_requested_action: string | null;
  pending_approval_reason: string | null;
  pending_approval_session_id: string | null;
}

export class SqliteRunnerStore implements RunnerStore {
  readonly #connection: DatabaseSync;

  constructor(connection: DatabaseSync) {
    this.#connection = connection;
  }

  async saveTask(task: RunnerTaskRecord): Promise<void> {
    this.#connection
      .prepare(`
        INSERT INTO runner_tasks (
          task_id,
          repo_path,
          prompt,
          priority,
          state,
          worktree_path,
          active_session_id,
          pending_approval_request_id,
          pending_approval_requested_action,
          pending_approval_reason,
          pending_approval_session_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          repo_path = excluded.repo_path,
          prompt = excluded.prompt,
          priority = excluded.priority,
          state = excluded.state,
          worktree_path = excluded.worktree_path,
          active_session_id = excluded.active_session_id,
          pending_approval_request_id = excluded.pending_approval_request_id,
          pending_approval_requested_action = excluded.pending_approval_requested_action,
          pending_approval_reason = excluded.pending_approval_reason,
          pending_approval_session_id = excluded.pending_approval_session_id,
          updated_at = CURRENT_TIMESTAMP
      `)
      .run(
        task.taskId,
        task.repoPath,
        task.prompt,
        task.priority,
        task.state,
        task.worktreePath ?? null,
        task.activeSessionId ?? null,
        task.pendingApproval?.approvalRequestId ?? null,
        task.pendingApproval?.requestedAction ?? null,
        task.pendingApproval?.reason ?? null,
        task.pendingApproval?.sessionId ?? null,
      );
  }

  async getTask(taskId: string): Promise<RunnerTaskRecord | undefined> {
    const row = this.#connection
      .prepare(
        `
          SELECT
            task_id,
            repo_path,
            prompt,
            priority,
            state,
            worktree_path,
            active_session_id,
            pending_approval_request_id,
            pending_approval_requested_action,
            pending_approval_reason,
            pending_approval_session_id
          FROM runner_tasks
          WHERE task_id = ?
        `,
      )
      .get(taskId) as RunnerTaskRow | undefined;

    return row ? mapRunnerTaskRow(row) : undefined;
  }

  async listTasksByState(state: RunnerTaskState): Promise<RunnerTaskRecord[]> {
    const rows = this.#connection
      .prepare(
        `
          SELECT
            task_id,
            repo_path,
            prompt,
            priority,
            state,
            worktree_path,
            active_session_id,
            pending_approval_request_id,
            pending_approval_requested_action,
            pending_approval_reason,
            pending_approval_session_id
          FROM runner_tasks
          WHERE state = ?
          ORDER BY rowid ASC
        `,
      )
      .all(state) as unknown as RunnerTaskRow[];

    return rows.map(mapRunnerTaskRow);
  }
}

function mapRunnerTaskRow(row: RunnerTaskRow): RunnerTaskRecord {
  return {
    taskId: row.task_id,
    repoPath: row.repo_path,
    prompt: row.prompt,
    priority: row.priority,
    state: row.state,
    worktreePath: row.worktree_path ?? undefined,
    activeSessionId: row.active_session_id ?? undefined,
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
