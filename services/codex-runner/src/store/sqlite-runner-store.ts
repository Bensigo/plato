import type { DatabaseSync } from "node:sqlite";

import type {
  ContextArtifact,
  ContextPackageRecord,
  ContextSource,
  RunnerStore,
  RunnerTaskDecomposition,
  RunnerTaskRecord,
  RunnerTaskState,
} from "../contracts.js";

interface RunnerTaskRow {
  task_id: string;
  repo_path: string;
  prompt: string;
  priority: number;
  state: RunnerTaskState;
  worktree_path: string | null;
  active_session_id: string | null;
  decomposition_kind: RunnerTaskDecomposition["kind"] | null;
  parent_task_id: string | null;
  dependency_task_ids_json: string | null;
  pending_approval_request_id: string | null;
  pending_approval_requested_action: string | null;
  pending_approval_reason: string | null;
  pending_approval_session_id: string | null;
}

interface ContextPackageRow {
  task_id: string;
  summary: string | null;
  sources_json: string;
  artifacts_json: string;
}

export class SqliteRunnerStore implements RunnerStore {
  readonly #connection: DatabaseSync;

  constructor(connection: DatabaseSync) {
    this.#connection = connection;
  }

  async saveTask(task: RunnerTaskRecord): Promise<void> {
    this.#saveTaskRecord(task);
  }

  async saveTaskGraph(
    tasks: RunnerTaskRecord[],
    contextPackages: ContextPackageRecord[],
  ): Promise<void> {
    this.#connection.exec("BEGIN IMMEDIATE");
    try {
      for (const task of tasks) {
        this.#saveTaskRecord(task);
        this.#deleteContextPackageRecord(task.taskId);
      }
      for (const contextPackage of contextPackages) {
        this.#saveContextPackageRecord(contextPackage);
      }
      this.#connection.exec("COMMIT");
    } catch (error) {
      this.#connection.exec("ROLLBACK");
      throw error;
    }
  }

  #saveTaskRecord(task: RunnerTaskRecord): void {
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
          decomposition_kind,
          parent_task_id,
          dependency_task_ids_json,
          pending_approval_request_id,
          pending_approval_requested_action,
          pending_approval_reason,
          pending_approval_session_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          repo_path = excluded.repo_path,
          prompt = excluded.prompt,
          priority = excluded.priority,
          state = excluded.state,
          worktree_path = excluded.worktree_path,
          active_session_id = excluded.active_session_id,
          decomposition_kind = excluded.decomposition_kind,
          parent_task_id = excluded.parent_task_id,
          dependency_task_ids_json = excluded.dependency_task_ids_json,
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
        task.decomposition?.kind ?? null,
        task.decomposition?.parentTaskId ?? null,
        task.decomposition ? JSON.stringify(task.decomposition.dependencyTaskIds ?? []) : null,
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
            decomposition_kind,
            parent_task_id,
            dependency_task_ids_json,
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

  async listTasks(): Promise<RunnerTaskRecord[]> {
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
            decomposition_kind,
            parent_task_id,
            dependency_task_ids_json,
            pending_approval_request_id,
            pending_approval_requested_action,
            pending_approval_reason,
            pending_approval_session_id
          FROM runner_tasks
          ORDER BY rowid ASC
        `,
      )
      .all() as unknown as RunnerTaskRow[];

    return rows.map(mapRunnerTaskRow);
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
            decomposition_kind,
            parent_task_id,
            dependency_task_ids_json,
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

  async listChildTasks(parentTaskId: string): Promise<RunnerTaskRecord[]> {
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
            decomposition_kind,
            parent_task_id,
            dependency_task_ids_json,
            pending_approval_request_id,
            pending_approval_requested_action,
            pending_approval_reason,
            pending_approval_session_id
          FROM runner_tasks
          WHERE parent_task_id = ?
          ORDER BY rowid ASC
        `,
      )
      .all(parentTaskId) as unknown as RunnerTaskRow[];

    return rows.map(mapRunnerTaskRow);
  }

  async saveContextPackage(contextPackage: ContextPackageRecord): Promise<void> {
    this.#saveContextPackageRecord(contextPackage);
  }

  #saveContextPackageRecord(contextPackage: ContextPackageRecord): void {
    this.#connection
      .prepare(`
        INSERT INTO runner_task_context_packages (
          task_id,
          summary,
          sources_json,
          artifacts_json
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          summary = excluded.summary,
          sources_json = excluded.sources_json,
          artifacts_json = excluded.artifacts_json,
          updated_at = CURRENT_TIMESTAMP
      `)
      .run(
        contextPackage.taskId,
        contextPackage.summary ?? null,
        JSON.stringify(contextPackage.sources),
        JSON.stringify(contextPackage.artifacts),
      );
  }

  async deleteContextPackage(taskId: string): Promise<void> {
    this.#deleteContextPackageRecord(taskId);
  }

  #deleteContextPackageRecord(taskId: string): void {
    this.#connection
      .prepare(
        `
          DELETE FROM runner_task_context_packages
          WHERE task_id = ?
        `,
      )
      .run(taskId);
  }

  async getContextPackage(taskId: string): Promise<ContextPackageRecord | undefined> {
    const row = this.#connection
      .prepare(
        `
          SELECT
            task_id,
            summary,
            sources_json,
            artifacts_json
          FROM runner_task_context_packages
          WHERE task_id = ?
        `,
      )
      .get(taskId) as ContextPackageRow | undefined;

    if (!row) {
      return undefined;
    }

    return {
      taskId: row.task_id,
      summary: row.summary ?? undefined,
      sources: JSON.parse(row.sources_json) as ContextSource[],
      artifacts: JSON.parse(row.artifacts_json) as ContextArtifact[],
    };
  }
}

function mapRunnerTaskRow(row: RunnerTaskRow): RunnerTaskRecord {
  const dependencyTaskIds = row.dependency_task_ids_json
    ? JSON.parse(row.dependency_task_ids_json) as string[]
    : [];

  return {
    taskId: row.task_id,
    repoPath: row.repo_path,
    prompt: row.prompt,
    priority: row.priority,
    state: row.state,
    worktreePath: row.worktree_path ?? undefined,
    activeSessionId: row.active_session_id ?? undefined,
    ...(row.decomposition_kind && row.parent_task_id
      ? {
          decomposition: {
            kind: row.decomposition_kind,
            parentTaskId: row.parent_task_id,
            ...(dependencyTaskIds.length > 0 ? { dependencyTaskIds } : {}),
          },
        }
      : {}),
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
