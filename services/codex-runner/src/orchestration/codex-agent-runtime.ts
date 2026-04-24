import type {
  AgentRuntime,
  CreateOrchestrationGraphInput,
  OrchestrationEvent,
  OrchestrationGraphState,
  OrchestrationResultClassification,
  OrchestrationSynthesisRecord,
  OrchestrationTaskGraphResultSnapshot,
  OrchestrationTaskGraphSnapshot,
  OrchestrationTaskRecord,
  OrchestrationTaskState,
  OrchestrationTaskResultRecord,
  StartOrchestrationTaskInput,
} from "@plato/orchestration";

import type {
  CreateTaskGraphInput,
  ParentTaskSynthesisRecord,
  RunnerTaskGraphResultSnapshot,
  RunnerTaskGraphSnapshot,
  RunnerTaskGraphState,
  RunnerTaskRecord,
  RunnerTaskState,
  SessionEvent,
  StartTaskInput,
  WorkerTaskResultClassification,
  WorkerTaskResultRecord,
} from "../contracts.js";

export interface CodexRunnerAgentRuntimeService {
  startTask(input: StartTaskInput): Promise<RunnerTaskRecord>;
  createTaskGraph(input: CreateTaskGraphInput): Promise<RunnerTaskGraphSnapshot>;
  getTask(taskId: string): Promise<RunnerTaskRecord | undefined>;
  getTaskGraph(taskId: string): Promise<RunnerTaskGraphSnapshot | undefined>;
  getTaskGraphResults(taskId: string): Promise<RunnerTaskGraphResultSnapshot | undefined>;
  listTasks(): Promise<RunnerTaskRecord[]>;
  listEvents(taskId: string): Promise<SessionEvent[]>;
  interruptTask(taskId: string): Promise<void>;
  resumeTask(taskId: string): Promise<RunnerTaskRecord>;
  approveTaskAction(taskId: string): Promise<RunnerTaskRecord>;
  rejectTaskAction(taskId: string, reason: string): Promise<RunnerTaskRecord>;
}

export interface CodexRunnerAgentRuntimeOptions {
  runtimeId?: string;
  service: CodexRunnerAgentRuntimeService;
}

export class CodexRunnerAgentRuntime implements AgentRuntime {
  readonly runtimeId: string;
  readonly backend = "codex";
  readonly #service: CodexRunnerAgentRuntimeService;

  constructor(options: CodexRunnerAgentRuntimeOptions) {
    this.runtimeId = options.runtimeId ?? "codex";
    this.#service = options.service;
  }

  async startTask(input: StartOrchestrationTaskInput): Promise<OrchestrationTaskRecord> {
    const task = await this.#service.startTask({
      taskId: input.taskId,
      repoPath: input.workspacePath,
      prompt: input.prompt,
      priority: input.priority,
      contextPackage: input.contextPackage,
    });
    return this.#mapTask(task);
  }

  async createTaskGraph(input: CreateOrchestrationGraphInput): Promise<OrchestrationTaskGraphSnapshot> {
    const graph = await this.#service.createTaskGraph({
      parent: {
        taskId: input.parent.taskId,
        repoPath: input.parent.workspacePath,
        prompt: input.parent.prompt,
        priority: input.parent.priority,
        contextPackage: input.parent.contextPackage,
      },
      children: input.children.map((child) => ({
        taskId: child.taskId,
        repoPath: child.workspacePath,
        prompt: child.prompt,
        priority: child.priority,
        dependencyTaskIds: child.dependencyTaskIds,
        contextPackage: child.contextPackage,
      })),
    });
    return this.#mapGraph(graph);
  }

  async getTask(taskId: string): Promise<OrchestrationTaskRecord | undefined> {
    const task = await this.#service.getTask(taskId);
    return task ? this.#mapTask(task) : undefined;
  }

  async getTaskGraph(taskId: string): Promise<OrchestrationTaskGraphSnapshot | undefined> {
    const graph = await this.#service.getTaskGraph(taskId);
    return graph ? this.#mapGraph(graph) : undefined;
  }

  async getTaskGraphResults(taskId: string): Promise<OrchestrationTaskGraphResultSnapshot | undefined> {
    const results = await this.#service.getTaskGraphResults(taskId);
    return results ? this.#mapGraphResults(results) : undefined;
  }

  async listTasks(): Promise<OrchestrationTaskRecord[]> {
    const tasks = await this.#service.listTasks();
    return tasks.map((task) => this.#mapTask(task));
  }

  async listEvents(taskId: string): Promise<OrchestrationEvent[]> {
    const events = await this.#service.listEvents(taskId);
    return events.map((event) => this.#mapEvent(event));
  }

  interruptTask(taskId: string): Promise<void> {
    return this.#service.interruptTask(taskId);
  }

  async resumeTask(taskId: string): Promise<OrchestrationTaskRecord> {
    const task = await this.#service.resumeTask(taskId);
    return this.#mapTask(task);
  }

  async approveTaskAction(taskId: string): Promise<OrchestrationTaskRecord> {
    const task = await this.#service.approveTaskAction(taskId);
    return this.#mapTask(task);
  }

  async rejectTaskAction(taskId: string, reason: string): Promise<OrchestrationTaskRecord> {
    const task = await this.#service.rejectTaskAction(taskId, reason);
    return this.#mapTask(task);
  }

  #mapGraph(graph: RunnerTaskGraphSnapshot): OrchestrationTaskGraphSnapshot {
    return {
      parent: this.#mapTask(graph.parent),
      children: graph.children.map((child) => this.#mapTask(child)),
      state: mapGraphState(graph.state),
    };
  }

  #mapGraphResults(results: RunnerTaskGraphResultSnapshot): OrchestrationTaskGraphResultSnapshot {
    return {
      parentTaskId: results.parentTaskId,
      results: results.results.map(mapWorkerResult),
      synthesis: results.synthesis ? mapSynthesis(results.synthesis) : undefined,
    };
  }

  #mapTask(task: RunnerTaskRecord): OrchestrationTaskRecord {
    return {
      taskId: task.taskId,
      workspacePath: task.repoPath,
      prompt: task.prompt,
      priority: task.priority,
      state: mapTaskState(task.state),
      worktreePath: task.worktreePath,
      activeSessionId: task.activeSessionId,
      decomposition: task.decomposition,
      execution: {
        runtimeId: this.runtimeId,
        backend: this.backend,
        backendTaskId: task.taskId,
      },
    };
  }

  #mapEvent(event: SessionEvent): OrchestrationEvent {
    return {
      taskId: event.taskId,
      type: event.type,
      runtimeId: this.runtimeId,
      backend: this.backend,
      sessionId: event.sessionId,
      parentTaskId: event.parentTaskId,
      childTaskId: event.childTaskId,
      dependencyTaskId: event.dependencyTaskId,
      dependencyTaskIds: event.dependencyTaskIds,
      blockedByTaskIds: event.blockedByTaskIds,
      worktreePath: event.worktreePath,
      graphState: event.graphState ? mapGraphState(event.graphState) : undefined,
      resultId: event.resultId,
      synthesisId: event.synthesisId,
      resultClassification: event.resultClassification
        ? mapResultClassification(event.resultClassification)
        : undefined,
      approvalRequestId: event.approvalRequestId,
      requestedAction: event.requestedAction,
      errorCode: event.errorCode,
      message: event.message,
      stream: event.stream,
      pid: event.pid,
      exitCode: event.exitCode,
      verificationId: event.verificationId,
      verificationStatus: event.verificationStatus,
      recoveredState: event.recoveredState,
    };
  }
}

function mapTaskState(state: RunnerTaskState): OrchestrationTaskState {
  return state;
}

function mapGraphState(state: RunnerTaskGraphState): OrchestrationGraphState {
  return state;
}

function mapResultClassification(
  classification: WorkerTaskResultClassification,
): OrchestrationResultClassification {
  return classification;
}

function mapWorkerResult(result: WorkerTaskResultRecord): OrchestrationTaskResultRecord {
  return {
    resultId: result.resultId,
    taskId: result.taskId,
    parentTaskId: result.parentTaskId,
    classification: mapResultClassification(result.classification),
    summary: result.summary,
    errorCode: result.errorCode,
    metadata: result.metadata,
  };
}

function mapSynthesis(synthesis: ParentTaskSynthesisRecord): OrchestrationSynthesisRecord {
  return {
    synthesisId: synthesis.synthesisId,
    parentTaskId: synthesis.parentTaskId,
    classification: mapResultClassification(synthesis.classification),
    summary: synthesis.summary,
    childTaskCount: synthesis.childTaskCount,
    resultIds: synthesis.resultIds,
    metadata: synthesis.metadata,
  };
}
