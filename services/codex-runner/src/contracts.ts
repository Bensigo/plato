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

export type RunnerSessionState =
  | "running"
  | "completed"
  | "failed"
  | "interrupted";

export interface ManagedSession {
  sessionId: string;
  taskId: string;
  worktreePath: string;
  pid?: number;
}

export interface RunnerSessionRecord extends ManagedSession {
  state: RunnerSessionState;
  exitCode?: number | null;
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
    | "runtime.checked"
    | "runtime.install.started"
    | "runtime.install.completed"
    | "runtime.install.failed"
    | "session.started"
    | "session.output"
    | "session.exited"
    | "task.queued"
    | "task.started"
    | "task.failed"
    | "task.interrupted"
    | "task.completed"
    | "task.resumed"
    | "task.reconciled";
  sessionId?: string;
  worktreePath?: string;
  recoveredState?: "interrupted" | "failed";
  errorCode?: string;
  message?: string;
  stream?: "stdout" | "stderr";
  pid?: number;
  exitCode?: number | null;
}

export interface RunnerStore {
  saveTask(task: RunnerTaskRecord): Promise<void>;
  getTask(taskId: string): Promise<RunnerTaskRecord | undefined>;
  listTasksByState(state: RunnerTaskState): Promise<RunnerTaskRecord[]>;
}

export interface SessionStore {
  saveSession(session: RunnerSessionRecord): Promise<void>;
  getSession(sessionId: string): Promise<RunnerSessionRecord | undefined>;
  listSessionsByTask(taskId: string): Promise<RunnerSessionRecord[]>;
}

export interface RunnerStoreRecord {
  tasks: RunnerTaskRecord[];
}

export interface WorktreeManager {
  createWorktree(taskId: string, repoPath: string): Promise<WorktreeAllocation>;
}

export interface AgentSessionHandlers {
  onExit?: (exitCode: number | null) => Promise<void> | void;
}

export interface LogStreamer {
  append(event: SessionEvent): Promise<void>;
  list(taskId: string): Promise<SessionEvent[]>;
}

export interface LogStreamRecord {
  events: SessionEvent[];
}

export interface AgentSession {
  start(
    task: RunnerTaskRecord,
    worktree: WorktreeAllocation,
    handlers?: AgentSessionHandlers,
  ): Promise<ManagedSession>;
  interrupt(sessionId: string): Promise<void>;
}

export interface AgentSessionFactory {
  create(logStreamer: LogStreamer): AgentSession;
}

export interface CodexRuntimeManager {
  ensureReady(task: RunnerTaskRecord, logStreamer: LogStreamer): Promise<void>;
}
