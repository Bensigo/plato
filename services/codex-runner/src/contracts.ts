export type RunnerTaskState =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "interrupted"
  | "completed"
  | "failed";

export class WorktreeProvisioningError extends Error {
  readonly code = "WORKTREE_PROVISIONING_FAILED";

  constructor(
    message: string,
    readonly taskId: string,
    readonly repoPath: string,
  ) {
    super(message);
    this.name = "WorktreeProvisioningError";
  }
}

export interface StartTaskInput {
  taskId: string;
  repoPath: string;
  prompt: string;
  priority?: number;
}

export interface RunnerTaskRecord {
  taskId: string;
  repoPath: string;
  prompt: string;
  priority: number;
  state: RunnerTaskState;
  worktreePath?: string;
  activeSessionId?: string;
}

export interface ManagedSession {
  sessionId: string;
  taskId: string;
  worktreePath: string;
  pid?: number;
}

export interface WorktreeAllocation {
  taskId: string;
  repoPath: string;
  branchName: string;
  worktreePath: string;
}

export interface SessionEvent {
  taskId: string;
  type:
    | "task.queued"
    | "task.started"
    | "task.failed"
    | "task.interrupted"
    | "task.completed"
    | "task.resumed";
  sessionId?: string;
  worktreePath?: string;
  errorCode?: string;
  message?: string;
}

export interface RunnerStore {
  saveTask(task: RunnerTaskRecord): Promise<void>;
  getTask(taskId: string): Promise<RunnerTaskRecord | undefined>;
  listTasksByState(state: RunnerTaskState): Promise<RunnerTaskRecord[]>;
}

export interface RunnerStoreRecord {
  tasks: RunnerTaskRecord[];
}

export interface WorktreeManager {
  createWorktree(taskId: string, repoPath: string): Promise<WorktreeAllocation>;
}

export interface ProcessPool {
  hasCapacity(): boolean;
  spawn(task: RunnerTaskRecord, worktree: WorktreeAllocation): Promise<ManagedSession>;
  interrupt(sessionId: string): Promise<void>;
}

export interface LogStreamer {
  append(event: SessionEvent): Promise<void>;
  list(taskId: string): Promise<SessionEvent[]>;
}

export interface LogStreamRecord {
  events: SessionEvent[];
}
