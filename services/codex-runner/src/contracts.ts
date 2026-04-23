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
  decomposition?: RunnerTaskDecomposition;
  contextPackage?: TaskContextPackageInput;
}

export interface CreateTaskGraphChildInput {
  taskId: string;
  repoPath?: string;
  prompt: string;
  priority?: number;
  dependencyTaskIds?: string[];
  contextPackage?: TaskContextPackageInput;
}

export interface CreateTaskGraphInput {
  parent: StartTaskInput;
  children: CreateTaskGraphChildInput[];
}

export interface PendingApprovalRecord {
  approvalRequestId: string;
  requestedAction: string;
  reason: string;
  sessionId: string;
}

export interface RequestTaskApprovalInput {
  approvalRequestId: string;
  requestedAction: string;
  reason: string;
  sessionId?: string;
}

export type RunnerTaskDecompositionKind = "subtask";

export interface RunnerTaskDecomposition {
  kind: RunnerTaskDecompositionKind;
  parentTaskId: string;
  dependencyTaskIds?: string[];
}

export type ContextSourceKind =
  | "repo_file"
  | "git_diff"
  | "task_brief"
  | "session_summary";

export interface ContextSource {
  sourceId: string;
  kind: ContextSourceKind;
  label: string;
  uri: string;
  summary?: string;
}

export type ContextArtifactKind = "summary" | "file_excerpt" | "patch";

export interface ContextArtifact {
  artifactId: string;
  kind: ContextArtifactKind;
  label: string;
  mimeType: string;
  content: string;
  summary?: string;
}

export interface TaskContextPackageInput {
  summary?: string;
  sources: ContextSource[];
  artifacts: ContextArtifact[];
}

export interface ContextPackageRecord extends TaskContextPackageInput {
  taskId: string;
}

export interface RunnerTaskRecord {
  taskId: string;
  repoPath: string;
  prompt: string;
  priority: number;
  state: RunnerTaskState;
  worktreePath?: string;
  activeSessionId?: string;
  decomposition?: RunnerTaskDecomposition;
  pendingApproval?: PendingApprovalRecord;
}

export type RunnerSessionState =
  | "running"
  | "awaiting_approval"
  | "verifying"
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
  pendingApproval?: PendingApprovalRecord;
}

export interface RunnerTaskStatusSnapshot {
  task: RunnerTaskRecord;
  sessions: RunnerSessionRecord[];
}

export type RunnerTaskGraphState =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "interrupted"
  | "completed"
  | "failed";

export interface RunnerTaskGraphSnapshot {
  parent: RunnerTaskRecord;
  children: RunnerTaskRecord[];
  state: RunnerTaskGraphState;
}

export type WorkerTaskResultClassification =
  | "completed"
  | "partial"
  | "conflicted"
  | "failed";

export interface WorkerTaskResultRecord {
  resultId: string;
  taskId: string;
  parentTaskId: string;
  classification: WorkerTaskResultClassification;
  summary: string;
  errorCode?: string;
  metadata?: Record<string, unknown>;
}

export interface ParentTaskSynthesisRecord {
  synthesisId: string;
  parentTaskId: string;
  classification: WorkerTaskResultClassification;
  summary: string;
  childTaskCount: number;
  resultIds: string[];
  metadata?: Record<string, unknown>;
}

export interface RunnerTaskGraphResultSnapshot {
  parentTaskId: string;
  results: WorkerTaskResultRecord[];
  synthesis?: ParentTaskSynthesisRecord;
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
    | "task.awaiting_approval"
    | "task.approval.granted"
    | "task.approval.rejected"
    | "task.failed"
    | "task.interrupted"
    | "task.completed"
    | "task.resumed"
    | "task.reconciled"
    | "task.graph.created"
    | "task.graph.child.completed"
    | "task.graph.child.failed"
    | "task.graph.dependency.blocked"
    | "task.graph.dependency.satisfied"
    | "task.graph.worker.started"
    | "task.graph.result.collected"
    | "task.graph.synthesized"
    | "task.graph.completed"
    | "task.graph.failed"
    | "verification.started"
    | "verification.completed"
    | "verification.failed";
  sessionId?: string;
  parentTaskId?: string;
  childTaskId?: string;
  dependencyTaskId?: string;
  dependencyTaskIds?: string[];
  blockedByTaskIds?: string[];
  worktreePath?: string;
  graphState?: RunnerTaskGraphState;
  resultId?: string;
  synthesisId?: string;
  resultClassification?: WorkerTaskResultClassification;
  recoveredState?: "interrupted" | "failed" | "completed";
  approvalRequestId?: string;
  requestedAction?: string;
  verificationId?: string;
  verificationStatus?: TaskVerificationStatus;
  errorCode?: string;
  message?: string;
  stream?: "stdout" | "stderr";
  pid?: number;
  exitCode?: number | null;
}

export type TaskVerificationStatus = "passed" | "failed";

export interface TaskVerificationResult {
  verificationId: string;
  status: TaskVerificationStatus;
  errorCode?: string;
  message?: string;
}

export interface TaskVerificationContext {
  task: RunnerTaskRecord;
  session: RunnerSessionRecord;
}

export interface TaskResultVerifier {
  verify(context: TaskVerificationContext): Promise<TaskVerificationResult>;
}

export interface WorkerTaskResultCollectionContext {
  task: RunnerTaskRecord;
  parentTask: RunnerTaskRecord;
  session?: RunnerSessionRecord;
}

export interface TaskResultCollector {
  collect(context: WorkerTaskResultCollectionContext): Promise<WorkerTaskResultRecord>;
}

export interface ParentTaskSynthesisContext {
  parentTask: RunnerTaskRecord;
  children: RunnerTaskRecord[];
  results: WorkerTaskResultRecord[];
}

export interface ParentTaskOutcomeSynthesizer {
  synthesize(context: ParentTaskSynthesisContext): Promise<ParentTaskSynthesisRecord>;
}

export interface RunnerStore {
  saveTask(task: RunnerTaskRecord): Promise<void>;
  saveTaskGraph(tasks: RunnerTaskRecord[], contextPackages: ContextPackageRecord[]): Promise<void>;
  getTask(taskId: string): Promise<RunnerTaskRecord | undefined>;
  listTasks(): Promise<RunnerTaskRecord[]>;
  listTasksByState(state: RunnerTaskState): Promise<RunnerTaskRecord[]>;
  listChildTasks(parentTaskId: string): Promise<RunnerTaskRecord[]>;
  saveContextPackage(contextPackage: ContextPackageRecord): Promise<void>;
  deleteContextPackage(taskId: string): Promise<void>;
  getContextPackage(taskId: string): Promise<ContextPackageRecord | undefined>;
  saveWorkerTaskResult(result: WorkerTaskResultRecord): Promise<void>;
  getWorkerTaskResult(taskId: string): Promise<WorkerTaskResultRecord | undefined>;
  listWorkerTaskResults(parentTaskId: string): Promise<WorkerTaskResultRecord[]>;
  saveParentTaskSynthesis(synthesis: ParentTaskSynthesisRecord): Promise<void>;
  getParentTaskSynthesis(parentTaskId: string): Promise<ParentTaskSynthesisRecord | undefined>;
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
