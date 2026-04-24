export type OrchestrationTaskState =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "interrupted"
  | "completed"
  | "failed";

export type OrchestrationGraphState = OrchestrationTaskState;

export type OrchestrationResultClassification =
  | "completed"
  | "partial"
  | "conflicted"
  | "failed";

export interface AgentRuntimeSelector {
  runtimeId: string;
}

export interface StartOrchestrationTaskInput {
  taskId: string;
  workspacePath: string;
  prompt: string;
  priority?: number;
  agent?: AgentRuntimeSelector;
  contextPackage?: OrchestrationContextPackageInput;
}

export interface CreateOrchestrationGraphChildInput {
  taskId: string;
  workspacePath?: string;
  prompt: string;
  priority?: number;
  dependencyTaskIds?: string[];
  contextPackage?: OrchestrationContextPackageInput;
}

export interface CreateOrchestrationGraphInput {
  parent: StartOrchestrationTaskInput;
  children: CreateOrchestrationGraphChildInput[];
}

export interface OrchestrationTaskDecomposition {
  kind: "subtask";
  parentTaskId: string;
  dependencyTaskIds?: string[];
}

export interface OrchestrationTaskExecution {
  runtimeId: string;
  backend: string;
  backendTaskId?: string;
}

export interface OrchestrationTaskRecord {
  taskId: string;
  workspacePath: string;
  prompt: string;
  priority: number;
  state: OrchestrationTaskState;
  worktreePath?: string;
  activeSessionId?: string;
  decomposition?: OrchestrationTaskDecomposition;
  execution: OrchestrationTaskExecution;
}

export interface OrchestrationTaskGraphSnapshot {
  parent: OrchestrationTaskRecord;
  children: OrchestrationTaskRecord[];
  state: OrchestrationGraphState;
}

export interface OrchestrationTaskResultRecord {
  resultId: string;
  taskId: string;
  parentTaskId: string;
  classification: OrchestrationResultClassification;
  summary: string;
  errorCode?: string;
  metadata?: Record<string, unknown>;
}

export interface OrchestrationSynthesisRecord {
  synthesisId: string;
  parentTaskId: string;
  classification: OrchestrationResultClassification;
  summary: string;
  childTaskCount: number;
  resultIds: string[];
  metadata?: Record<string, unknown>;
}

export interface OrchestrationTaskGraphResultSnapshot {
  parentTaskId: string;
  results: OrchestrationTaskResultRecord[];
  synthesis?: OrchestrationSynthesisRecord;
}

export interface OrchestrationEvent {
  taskId: string;
  type: string;
  runtimeId: string;
  backend: string;
  sessionId?: string;
  parentTaskId?: string;
  childTaskId?: string;
  dependencyTaskId?: string;
  dependencyTaskIds?: string[];
  blockedByTaskIds?: string[];
  worktreePath?: string;
  graphState?: OrchestrationGraphState;
  resultId?: string;
  synthesisId?: string;
  resultClassification?: OrchestrationResultClassification;
  approvalRequestId?: string;
  requestedAction?: string;
  errorCode?: string;
  message?: string;
  stream?: "stdout" | "stderr";
  pid?: number;
  exitCode?: number | null;
  verificationId?: string;
  verificationStatus?: "passed" | "failed";
  recoveredState?: "interrupted" | "failed" | "completed";
  metadata?: Record<string, unknown>;
}

export type OrchestrationContextSourceKind =
  | "repo_file"
  | "git_diff"
  | "task_brief"
  | "session_summary";

export interface OrchestrationContextSource {
  sourceId: string;
  kind: OrchestrationContextSourceKind;
  label: string;
  uri: string;
  summary?: string;
}

export type OrchestrationContextArtifactKind = "summary" | "file_excerpt" | "patch";

export interface OrchestrationContextArtifact {
  artifactId: string;
  kind: OrchestrationContextArtifactKind;
  label: string;
  mimeType: string;
  content: string;
  summary?: string;
}

export interface OrchestrationContextPackageInput {
  summary?: string;
  sources: OrchestrationContextSource[];
  artifacts: OrchestrationContextArtifact[];
}

export interface AgentRuntime {
  readonly runtimeId: string;
  readonly backend: string;
  startTask(input: StartOrchestrationTaskInput): Promise<OrchestrationTaskRecord>;
  createTaskGraph(input: CreateOrchestrationGraphInput): Promise<OrchestrationTaskGraphSnapshot>;
  getTask(taskId: string): Promise<OrchestrationTaskRecord | undefined>;
  getTaskGraph(taskId: string): Promise<OrchestrationTaskGraphSnapshot | undefined>;
  getTaskGraphResults?(taskId: string): Promise<OrchestrationTaskGraphResultSnapshot | undefined>;
  listTasks(): Promise<OrchestrationTaskRecord[]>;
  listEvents(taskId: string): Promise<OrchestrationEvent[]>;
  interruptTask(taskId: string): Promise<void>;
  resumeTask(taskId: string): Promise<OrchestrationTaskRecord>;
  approveTaskAction?(taskId: string): Promise<OrchestrationTaskRecord>;
  rejectTaskAction?(taskId: string, reason: string): Promise<OrchestrationTaskRecord>;
}

export interface TaskOrchestrationServiceOptions {
  defaultRuntimeId: string;
  runtimes: AgentRuntime[];
}

export class TaskOrchestrationService {
  readonly #defaultRuntimeId: string;
  readonly #runtimes: Map<string, AgentRuntime>;
  readonly #taskRuntimeIds = new Map<string, string>();

  constructor(options: TaskOrchestrationServiceOptions) {
    this.#defaultRuntimeId = options.defaultRuntimeId;
    this.#runtimes = new Map(options.runtimes.map((runtime) => [runtime.runtimeId, runtime]));
    if (!this.#runtimes.has(this.#defaultRuntimeId)) {
      throw new Error(`Default agent runtime '${this.#defaultRuntimeId}' is not registered`);
    }
  }

  listRuntimes(): AgentRuntime[] {
    return [...this.#runtimes.values()];
  }

  async startTask(input: StartOrchestrationTaskInput): Promise<OrchestrationTaskRecord> {
    const task = await this.#runtimeFor(input.agent).startTask(input);
    this.#rememberTaskRuntime(task);
    return task;
  }

  async createTaskGraph(input: CreateOrchestrationGraphInput): Promise<OrchestrationTaskGraphSnapshot> {
    const graph = await this.#runtimeFor(input.parent.agent).createTaskGraph(input);
    this.#rememberGraphRuntime(graph);
    return graph;
  }

  async getTask(
    taskId: string,
    selector?: AgentRuntimeSelector,
  ): Promise<OrchestrationTaskRecord | undefined> {
    if (selector) {
      const task = await this.#runtimeFor(selector).getTask(taskId);
      if (task) {
        this.#rememberTaskRuntime(task);
      }
      return task;
    }

    return this.#findTask(taskId);
  }

  async getTaskGraph(
    taskId: string,
    selector?: AgentRuntimeSelector,
  ): Promise<OrchestrationTaskGraphSnapshot | undefined> {
    if (selector) {
      const graph = await this.#runtimeFor(selector).getTaskGraph(taskId);
      if (graph) {
        this.#rememberGraphRuntime(graph);
      }
      return graph;
    }

    const knownRuntime = this.#runtimeForKnownTask(taskId);
    if (knownRuntime) {
      const graph = await knownRuntime.getTaskGraph(taskId);
      if (graph) {
        this.#rememberGraphRuntime(graph);
        return graph;
      }
    }

    for (const runtime of this.#runtimes.values()) {
      if (runtime === knownRuntime) {
        continue;
      }
      const graph = await runtime.getTaskGraph(taskId);
      if (graph) {
        this.#rememberGraphRuntime(graph);
        return graph;
      }
    }

    return undefined;
  }

  async getTaskGraphResults(
    taskId: string,
    selector?: AgentRuntimeSelector,
  ): Promise<OrchestrationTaskGraphResultSnapshot | undefined> {
    const runtime = selector ? this.#runtimeFor(selector) : await this.#resolveRuntimeForTask(taskId);
    return runtime.getTaskGraphResults?.(taskId) ?? Promise.resolve(undefined);
  }

  listTasks(selector?: AgentRuntimeSelector): Promise<OrchestrationTaskRecord[]> {
    return this.#runtimeFor(selector).listTasks();
  }

  async listEvents(taskId: string, selector?: AgentRuntimeSelector): Promise<OrchestrationEvent[]> {
    return (await this.#resolveRuntimeForTask(taskId, selector)).listEvents(taskId);
  }

  async interruptTask(taskId: string, selector?: AgentRuntimeSelector): Promise<void> {
    return (await this.#resolveRuntimeForTask(taskId, selector)).interruptTask(taskId);
  }

  async resumeTask(taskId: string, selector?: AgentRuntimeSelector): Promise<OrchestrationTaskRecord> {
    const task = await (await this.#resolveRuntimeForTask(taskId, selector)).resumeTask(taskId);
    this.#rememberTaskRuntime(task);
    return task;
  }

  async approveTaskAction(taskId: string, selector?: AgentRuntimeSelector): Promise<OrchestrationTaskRecord> {
    const runtime = await this.#resolveRuntimeForTask(taskId, selector);
    if (!runtime.approveTaskAction) {
      throw new Error(`Agent runtime '${runtime.runtimeId}' does not support approval`);
    }
    const task = await runtime.approveTaskAction(taskId);
    this.#rememberTaskRuntime(task);
    return task;
  }

  async rejectTaskAction(
    taskId: string,
    reason: string,
    selector?: AgentRuntimeSelector,
  ): Promise<OrchestrationTaskRecord> {
    const runtime = await this.#resolveRuntimeForTask(taskId, selector);
    if (!runtime.rejectTaskAction) {
      throw new Error(`Agent runtime '${runtime.runtimeId}' does not support approval rejection`);
    }
    const task = await runtime.rejectTaskAction(taskId, reason);
    this.#rememberTaskRuntime(task);
    return task;
  }

  #runtimeFor(selector?: AgentRuntimeSelector): AgentRuntime {
    const runtimeId = selector?.runtimeId ?? this.#defaultRuntimeId;
    const runtime = this.#runtimes.get(runtimeId);
    if (!runtime) {
      throw new Error(`Agent runtime '${runtimeId}' is not registered`);
    }
    return runtime;
  }

  async #resolveRuntimeForTask(taskId: string, selector?: AgentRuntimeSelector): Promise<AgentRuntime> {
    if (selector) {
      return this.#runtimeFor(selector);
    }

    const knownRuntime = this.#runtimeForKnownTask(taskId);
    if (knownRuntime) {
      return knownRuntime;
    }

    const task = await this.#findTask(taskId);
    return task ? this.#runtimeFor(task.execution) : this.#runtimeFor();
  }

  async #findTask(taskId: string): Promise<OrchestrationTaskRecord | undefined> {
    const knownRuntime = this.#runtimeForKnownTask(taskId);
    if (knownRuntime) {
      const knownTask = await knownRuntime.getTask(taskId);
      if (knownTask) {
        this.#rememberTaskRuntime(knownTask);
        return knownTask;
      }
    }

    for (const runtime of this.#runtimes.values()) {
      if (runtime === knownRuntime) {
        continue;
      }
      const task = await runtime.getTask(taskId);
      if (task) {
        this.#rememberTaskRuntime(task);
        return task;
      }
    }

    return undefined;
  }

  #runtimeForKnownTask(taskId: string): AgentRuntime | undefined {
    const runtimeId = this.#taskRuntimeIds.get(taskId);
    return runtimeId ? this.#runtimes.get(runtimeId) : undefined;
  }

  #rememberGraphRuntime(graph: OrchestrationTaskGraphSnapshot): void {
    this.#rememberTaskRuntime(graph.parent);
    for (const child of graph.children) {
      this.#rememberTaskRuntime(child);
    }
  }

  #rememberTaskRuntime(task: OrchestrationTaskRecord): void {
    if (this.#runtimes.has(task.execution.runtimeId)) {
      this.#taskRuntimeIds.set(task.taskId, task.execution.runtimeId);
    }
  }
}
