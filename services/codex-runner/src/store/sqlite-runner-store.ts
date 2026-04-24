import type { DatabaseSync } from "node:sqlite";

import type {
  ContextArtifact,
  ContextPackageRecord,
  ContextSource,
  ParentTaskSynthesisRecord,
  RunnerStore,
  RunnerTaskDecomposition,
  RunnerTaskRecord,
  RunnerTaskState,
  WorkerTaskResultClassification,
  WorkerTaskResultRecord,
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

interface WorkerTaskResultRow {
  result_id: string;
  task_id: string;
  parent_task_id: string;
  classification: WorkerTaskResultClassification;
  summary: string;
  error_code: string | null;
  metadata_json: string | null;
}

interface ParentTaskSynthesisRow {
  synthesis_id: string;
  parent_task_id: string;
  classification: WorkerTaskResultClassification;
  summary: string;
  child_task_count: number;
  result_ids_json: string;
  metadata_json: string | null;
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
            dependency_task_ids_json,
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
            dependency_task_ids_json,
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
            dependency_task_ids_json,
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
            dependency_task_ids_json,
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

  async saveWorkerTaskResult(result: WorkerTaskResultRecord): Promise<void> {
    this.#connection
      .prepare(`
        INSERT INTO runner_worker_task_results (
          result_id,
          task_id,
          parent_task_id,
          classification,
          summary,
          error_code,
          metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          result_id = excluded.result_id,
          parent_task_id = excluded.parent_task_id,
          classification = excluded.classification,
          summary = excluded.summary,
          error_code = excluded.error_code,
          metadata_json = excluded.metadata_json,
          updated_at = CURRENT_TIMESTAMP
      `)
      .run(
        result.resultId,
        result.taskId,
        result.parentTaskId,
        result.classification,
        result.summary,
        result.errorCode ?? null,
        result.metadata ? JSON.stringify(result.metadata) : null,
      );
  }

  async getWorkerTaskResult(taskId: string): Promise<WorkerTaskResultRecord | undefined> {
    const row = this.#connection
      .prepare(
        `
          SELECT
            result_id,
            task_id,
            parent_task_id,
            classification,
            summary,
            error_code,
            metadata_json
          FROM runner_worker_task_results
          WHERE task_id = ?
        `,
      )
      .get(taskId) as WorkerTaskResultRow | undefined;

    return row ? mapWorkerTaskResultRow(row) : undefined;
  }

  async listWorkerTaskResults(parentTaskId: string): Promise<WorkerTaskResultRecord[]> {
    const rows = this.#connection
      .prepare(
        `
          SELECT
            result_id,
            task_id,
            parent_task_id,
            classification,
            summary,
            error_code,
            metadata_json
          FROM runner_worker_task_results
          WHERE parent_task_id = ?
          ORDER BY rowid ASC
        `,
      )
      .all(parentTaskId) as unknown as WorkerTaskResultRow[];

    return rows.map(mapWorkerTaskResultRow);
  }

  async saveParentTaskSynthesis(synthesis: ParentTaskSynthesisRecord): Promise<void> {
    this.#connection
      .prepare(`
        INSERT INTO runner_parent_task_syntheses (
          synthesis_id,
          parent_task_id,
          classification,
          summary,
          child_task_count,
          result_ids_json,
          metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(parent_task_id) DO UPDATE SET
          synthesis_id = excluded.synthesis_id,
          classification = excluded.classification,
          summary = excluded.summary,
          child_task_count = excluded.child_task_count,
          result_ids_json = excluded.result_ids_json,
          metadata_json = excluded.metadata_json,
          updated_at = CURRENT_TIMESTAMP
      `)
      .run(
        synthesis.synthesisId,
        synthesis.parentTaskId,
        synthesis.classification,
        synthesis.summary,
        synthesis.childTaskCount,
        JSON.stringify(synthesis.resultIds),
        synthesis.metadata ? JSON.stringify(synthesis.metadata) : null,
      );
  }

  async getParentTaskSynthesis(parentTaskId: string): Promise<ParentTaskSynthesisRecord | undefined> {
    const row = this.#connection
      .prepare(
        `
          SELECT
            synthesis_id,
            parent_task_id,
            classification,
            summary,
            child_task_count,
            result_ids_json,
            metadata_json
          FROM runner_parent_task_syntheses
          WHERE parent_task_id = ?
        `,
      )
      .get(parentTaskId) as ParentTaskSynthesisRow | undefined;

    return row ? mapParentTaskSynthesisRow(row) : undefined;
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

function mapWorkerTaskResultRow(row: WorkerTaskResultRow): WorkerTaskResultRecord {
  return {
    resultId: row.result_id,
    taskId: row.task_id,
    parentTaskId: row.parent_task_id,
    classification: row.classification,
    summary: row.summary,
    errorCode: row.error_code ?? undefined,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) as Record<string, unknown> : undefined,
  };
}

function mapParentTaskSynthesisRow(row: ParentTaskSynthesisRow): ParentTaskSynthesisRecord {
  return {
    synthesisId: row.synthesis_id,
    parentTaskId: row.parent_task_id,
    classification: row.classification,
    summary: row.summary,
    childTaskCount: row.child_task_count,
    resultIds: JSON.parse(row.result_ids_json) as string[],
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) as Record<string, unknown> : undefined,
  };
}
