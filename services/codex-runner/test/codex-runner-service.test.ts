import { setTimeout } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { CodexRunnerService } from "../src/codex-runner-service.js";
import {
  type AgentSession,
  type AgentSessionFactory,
  type CodexRuntimeManager,
  type ContextArtifact,
  type ContextPackageRecord,
  type ContextSource,
  type CreateTaskGraphInput,
  WorktreeProvisioningError,
  type LogStreamer,
  ManagedSession,
  type ParentTaskOutcomeSynthesizer,
  type ParentTaskSynthesisContext,
  type ParentTaskSynthesisRecord,
  type PendingApprovalRecord,
  RunnerStore,
  type RunnerSessionRecord,
  RunnerTaskRecord,
  RunnerTaskState,
  SessionStore,
  SessionEvent,
  type TaskResultCollector,
  type WorkerTaskResultCollectionContext,
  type WorkerTaskResultRecord,
  type TaskResultVerifier,
  type TaskVerificationContext,
  type TaskVerificationResult,
  WorktreeAllocation,
  WorktreeManager,
} from "../src/contracts.js";

class InMemoryRunnerStore implements RunnerStore {
  readonly #tasks = new Map<string, RunnerTaskRecord>();
  readonly #contextPackages = new Map<string, ContextPackageRecord>();
  readonly #workerResults = new Map<string, WorkerTaskResultRecord>();
  readonly #parentSyntheses = new Map<string, ParentTaskSynthesisRecord>();

  async saveTask(task: RunnerTaskRecord): Promise<void> {
    this.#tasks.set(task.taskId, task);
  }

  async saveTaskGraph(
    tasks: RunnerTaskRecord[],
    contextPackages: ContextPackageRecord[],
  ): Promise<void> {
    for (const task of tasks) {
      this.#tasks.set(task.taskId, task);
      this.#contextPackages.delete(task.taskId);
    }
    for (const contextPackage of contextPackages) {
      this.#contextPackages.set(contextPackage.taskId, contextPackage);
    }
  }

  async getTask(taskId: string): Promise<RunnerTaskRecord | undefined> {
    return this.#tasks.get(taskId);
  }

  async listTasks(): Promise<RunnerTaskRecord[]> {
    return [...this.#tasks.values()];
  }

  async listTasksByState(state: RunnerTaskState): Promise<RunnerTaskRecord[]> {
    return [...this.#tasks.values()].filter((task) => task.state === state);
  }

  async listChildTasks(parentTaskId: string): Promise<RunnerTaskRecord[]> {
    return [...this.#tasks.values()].filter(
      (task) => task.decomposition?.parentTaskId === parentTaskId,
    );
  }

  async saveContextPackage(contextPackage: ContextPackageRecord): Promise<void> {
    this.#contextPackages.set(contextPackage.taskId, contextPackage);
  }

  async deleteContextPackage(taskId: string): Promise<void> {
    this.#contextPackages.delete(taskId);
  }

  async getContextPackage(taskId: string): Promise<ContextPackageRecord | undefined> {
    return this.#contextPackages.get(taskId);
  }

  async saveWorkerTaskResult(result: WorkerTaskResultRecord): Promise<void> {
    const existing = this.#workerResults.get(result.taskId);
    if (existing) {
      this.#workerResults.delete(existing.taskId);
    }
    this.#workerResults.set(result.taskId, result);
  }

  async getWorkerTaskResult(taskId: string): Promise<WorkerTaskResultRecord | undefined> {
    return this.#workerResults.get(taskId);
  }

  async listWorkerTaskResults(parentTaskId: string): Promise<WorkerTaskResultRecord[]> {
    return [...this.#workerResults.values()].filter((result) => result.parentTaskId === parentTaskId);
  }

  async saveParentTaskSynthesis(synthesis: ParentTaskSynthesisRecord): Promise<void> {
    this.#parentSyntheses.set(synthesis.parentTaskId, synthesis);
  }

  async getParentTaskSynthesis(parentTaskId: string): Promise<ParentTaskSynthesisRecord | undefined> {
    return this.#parentSyntheses.get(parentTaskId);
  }
}

class InMemoryLogStreamer implements LogStreamer {
  readonly #events = new Map<string, SessionEvent[]>();

  async append(event: SessionEvent): Promise<void> {
    const current = this.#events.get(event.taskId) ?? [];
    current.push(event);
    this.#events.set(event.taskId, current);
  }

  async list(taskId: string): Promise<SessionEvent[]> {
    return this.#events.get(taskId) ?? [];
  }
}

class InMemorySessionStore implements SessionStore {
  readonly #sessions = new Map<string, RunnerSessionRecord>();

  async saveSession(session: RunnerSessionRecord): Promise<void> {
    this.#sessions.set(session.sessionId, session);
  }

  async getSession(sessionId: string): Promise<RunnerSessionRecord | undefined> {
    return this.#sessions.get(sessionId);
  }

  async listSessionsByTask(taskId: string): Promise<RunnerSessionRecord[]> {
    return [...this.#sessions.values()].filter((session) => session.taskId === taskId);
  }
}

class FakeWorktreeManager implements WorktreeManager {
  readonly allocations: WorktreeAllocation[] = [];
  failure?: Error;

  async createWorktree(taskId: string, repoPath: string): Promise<WorktreeAllocation> {
    if (this.failure) {
      throw this.failure;
    }

    const allocation = {
      taskId,
      repoPath,
      branchName: `plato/task-${taskId}`,
      worktreePath: `${repoPath}/.plato/worktrees/${taskId}`,
    };
    this.allocations.push(allocation);
    return allocation;
  }
}

class FakeRuntimeManager implements CodexRuntimeManager {
  readonly calls: string[] = [];
  failure?: Error;
  gate?: Promise<void>;

  async ensureReady(task: RunnerTaskRecord): Promise<void> {
    this.calls.push(task.taskId);
    await this.gate;
    if (this.failure) {
      throw this.failure;
    }
  }
}

class FakeAgentSession implements AgentSession {
  readonly started: {
    taskId: string;
    worktreePath: string;
    sessionId: string;
  }[] = [];
  readonly interrupted: string[] = [];
  readonly #exitHandlers = new Map<string, (exitCode: number | null) => Promise<void> | void>();

  async start(
    task: RunnerTaskRecord,
    worktree: WorktreeAllocation,
    handlers?: { onExit?: (exitCode: number | null) => Promise<void> | void },
  ): Promise<ManagedSession> {
    const sessionId = `session-${this.started.length + 1}`;
    this.started.push({
      taskId: task.taskId,
      worktreePath: worktree.worktreePath,
      sessionId,
    });

    if (handlers?.onExit) {
      this.#exitHandlers.set(sessionId, handlers.onExit);
    }

    return {
      sessionId,
      taskId: task.taskId,
      worktreePath: worktree.worktreePath,
      pid: this.started.length,
    };
  }

  async exit(sessionId: string, exitCode: number | null): Promise<void> {
    await this.#exitHandlers.get(sessionId)?.(exitCode);
  }

  async interrupt(sessionId: string): Promise<void> {
    this.interrupted.push(sessionId);
  }
}

class FakeAgentSessionFactory implements AgentSessionFactory {
  constructor(readonly session: FakeAgentSession) {}

  create(): AgentSession {
    return this.session;
  }
}

class FakeTaskResultVerifier implements TaskResultVerifier {
  readonly calls: TaskVerificationContext[] = [];
  result: TaskVerificationResult = {
    verificationId: "verification-1",
    status: "passed",
    message: "verification passed",
  };

  async verify(context: TaskVerificationContext): Promise<TaskVerificationResult> {
    this.calls.push(context);
    return this.result;
  }
}

function createDeferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });

  return { promise, resolve };
}

async function waitUntil(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await setTimeout(1);
    }
  }

  throw lastError;
}

class FakeTaskResultCollector implements TaskResultCollector {
  readonly calls: WorkerTaskResultCollectionContext[] = [];
  results = new Map<string, WorkerTaskResultRecord>();

  async collect(context: WorkerTaskResultCollectionContext): Promise<WorkerTaskResultRecord> {
    this.calls.push(context);
    return this.results.get(context.task.taskId) ?? {
      resultId: `result-${context.task.taskId}`,
      taskId: context.task.taskId,
      parentTaskId: context.parentTask.taskId,
      classification: "completed",
      summary: `${context.task.taskId} done`,
    };
  }
}

class FakeParentTaskOutcomeSynthesizer implements ParentTaskOutcomeSynthesizer {
  readonly calls: ParentTaskSynthesisContext[] = [];

  async synthesize(context: ParentTaskSynthesisContext): Promise<ParentTaskSynthesisRecord> {
    this.calls.push(context);
    return {
      synthesisId: `synthesis-${context.parentTask.taskId}`,
      parentTaskId: context.parentTask.taskId,
      classification: context.results.some((result) => result.classification === "failed")
        ? "failed"
        : "partial",
      summary: `Synthesized ${context.results.length} results`,
      childTaskCount: context.children.length,
      resultIds: context.results.map((result) => result.resultId),
    };
  }
}

describe("CodexRunnerService", () => {
  const buildPendingApproval = (
    sessionId = "session-1",
    overrides: Partial<PendingApprovalRecord> = {},
  ): PendingApprovalRecord => ({
    approvalRequestId: "approval-1",
    requestedAction: "apply_patch",
    reason: "Writes files in the worktree.",
    sessionId,
    ...overrides,
  });

  const buildContextSource = (): ContextSource => ({
    kind: "repo_file",
    sourceId: "source-1",
    label: "Touched file",
    uri: "file:///repo/src/index.ts",
    summary: "Contains the primary entry point.",
  });

  const buildContextArtifact = (): ContextArtifact => ({
    artifactId: "artifact-1",
    kind: "summary",
    label: "Implementation brief",
    mimeType: "text/markdown",
    content: "Focus on isolated worktree startup.",
    summary: "Short implementation brief.",
  });

  it("starts a task immediately when process capacity is available", async () => {
    const store = new InMemoryRunnerStore();
    const sessionStore = new InMemorySessionStore();
    const logStreamer = new InMemoryLogStreamer();
    const worktreeManager = new FakeWorktreeManager();
    const agentSession = new FakeAgentSession();
    const service = new CodexRunnerService({
      store,
      sessionStore,
      logStreamer,
      worktreeManager,
      maxConcurrentTasks: 1,
      agentSessionFactory: new FakeAgentSessionFactory(agentSession),
    });

    const task = await service.startTask({
      taskId: "task-1",
      repoPath: "/repo",
      prompt: "Implement the runner",
    });

    expect(task.state).toBe("running");
    expect(task.worktreePath).toBe("/repo/.plato/worktrees/task-1");
    expect(worktreeManager.allocations).toHaveLength(1);

    await expect(service.listEvents("task-1")).resolves.toEqual([
      { taskId: "task-1", type: "task.queued" },
      {
        taskId: "task-1",
        type: "task.started",
        sessionId: "session-1",
        worktreePath: "/repo/.plato/worktrees/task-1",
      },
    ]);
  });

  it("serializes scheduler passes so concurrent admissions cannot oversubscribe capacity", async () => {
    const store = new InMemoryRunnerStore();
    const sessionStore = new InMemorySessionStore();
    const logStreamer = new InMemoryLogStreamer();
    const worktreeManager = new FakeWorktreeManager();
    const agentSession = new FakeAgentSession();
    const runtimeManager = new FakeRuntimeManager();
    const gate = createDeferred();
    runtimeManager.gate = gate.promise;
    const service = new CodexRunnerService({
      store,
      sessionStore,
      logStreamer,
      worktreeManager,
      runtimeManager,
      maxConcurrentTasks: 1,
      agentSessionFactory: new FakeAgentSessionFactory(agentSession),
    });

    const firstTask = service.startTask({
      taskId: "task-1",
      repoPath: "/repo",
      prompt: "First",
    });
    await waitUntil(() => expect(runtimeManager.calls).toEqual(["task-1"]));

    const secondTask = service.startTask({
      taskId: "task-2",
      repoPath: "/repo",
      prompt: "Second",
    });
    await setTimeout(1);

    expect(runtimeManager.calls).toEqual(["task-1"]);
    expect(agentSession.started).toHaveLength(0);

    gate.resolve();

    await expect(firstTask).resolves.toMatchObject({
      taskId: "task-1",
      state: "running",
    });
    await expect(secondTask).resolves.toMatchObject({
      taskId: "task-2",
      state: "queued",
    });
    expect(agentSession.started.map((session) => session.taskId)).toEqual(["task-1"]);
    expect(worktreeManager.allocations).toHaveLength(1);
  });

  it("fails the task when codex runtime bootstrap fails", async () => {
    const store = new InMemoryRunnerStore();
    const sessionStore = new InMemorySessionStore();
    const logStreamer = new InMemoryLogStreamer();
    const worktreeManager = new FakeWorktreeManager();
    const runtimeManager = new FakeRuntimeManager();
    runtimeManager.failure = new Error("codex install failed");
    const service = new CodexRunnerService({
      store,
      sessionStore,
      logStreamer,
      worktreeManager,
      maxConcurrentTasks: 1,
      runtimeManager,
    });

    const task = await service.startTask({
      taskId: "task-1",
      repoPath: "/repo",
      prompt: "Implement the runner",
    });

    expect(runtimeManager.calls).toEqual(["task-1"]);
    expect(task.state).toBe("failed");
    expect(worktreeManager.allocations).toHaveLength(0);
    await expect(service.listEvents("task-1")).resolves.toEqual([
      { taskId: "task-1", type: "task.queued" },
      {
        taskId: "task-1",
        type: "task.failed",
        errorCode: "CODEX_RUNTIME_FAILED",
        message: "codex install failed",
      },
    ]);
  });

  it("persists a context package alongside the task admission record", async () => {
    const store = new InMemoryRunnerStore();
    const service = new CodexRunnerService({
      store,
      sessionStore: new InMemorySessionStore(),
      logStreamer: new InMemoryLogStreamer(),
      worktreeManager: new FakeWorktreeManager(),
      maxConcurrentTasks: 0,
    });

    await service.startTask({
      taskId: "task-1",
      repoPath: "/repo",
      prompt: "Use context",
      contextPackage: {
        summary: "Execution context summary",
        sources: [buildContextSource()],
        artifacts: [buildContextArtifact()],
      },
    });

    await expect(service.getContextPackage("task-1")).resolves.toEqual({
      taskId: "task-1",
      summary: "Execution context summary",
      sources: [buildContextSource()],
      artifacts: [buildContextArtifact()],
    });
  });

  it("clears stale context when a task is re-admitted without a context package", async () => {
    const store = new InMemoryRunnerStore();
    const service = new CodexRunnerService({
      store,
      sessionStore: new InMemorySessionStore(),
      logStreamer: new InMemoryLogStreamer(),
      worktreeManager: new FakeWorktreeManager(),
      maxConcurrentTasks: 0,
    });

    await service.startTask({
      taskId: "task-1",
      repoPath: "/repo",
      prompt: "Use context",
      contextPackage: {
        summary: "Execution context summary",
        sources: [buildContextSource()],
        artifacts: [buildContextArtifact()],
      },
    });

    await service.startTask({
      taskId: "task-1",
      repoPath: "/repo",
      prompt: "Retry without context",
    });

    await expect(service.getContextPackage("task-1")).resolves.toBeUndefined();
  });

  it("creates a subtask with a durable parent-child relationship", async () => {
    const store = new InMemoryRunnerStore();
    const sessionStore = new InMemorySessionStore();
    const logStreamer = new InMemoryLogStreamer();
    const worktreeManager = new FakeWorktreeManager();
    const agentSession = new FakeAgentSession();
    const service = new CodexRunnerService({
      store,
      sessionStore,
      logStreamer,
      worktreeManager,
      maxConcurrentTasks: 2,
      agentSessionFactory: new FakeAgentSessionFactory(agentSession),
    });

    await service.startTask({
      taskId: "task-parent",
      repoPath: "/repo",
      prompt: "Parent task",
    });

    const subtask = await service.startTask({
      taskId: "task-child",
      repoPath: "/repo",
      prompt: "Child task",
      decomposition: {
        kind: "subtask",
        parentTaskId: "task-parent",
      },
    });

    expect(subtask.decomposition).toEqual({
      kind: "subtask",
      parentTaskId: "task-parent",
    });
    await expect(service.listSubtasks("task-parent")).resolves.toEqual([subtask]);
  });

  it("rejects a subtask when its parent task does not exist", async () => {
    const service = new CodexRunnerService({
      store: new InMemoryRunnerStore(),
      sessionStore: new InMemorySessionStore(),
      logStreamer: new InMemoryLogStreamer(),
      worktreeManager: new FakeWorktreeManager(),
    });

    await expect(
      service.startTask({
        taskId: "task-child",
        repoPath: "/repo",
        prompt: "Child task",
        decomposition: {
          kind: "subtask",
          parentTaskId: "task-parent",
        },
      }),
    ).rejects.toThrow("Parent task task-parent was not found");
  });

  it("creates a parent task and children in one durable task graph", async () => {
    const store = new InMemoryRunnerStore();
    const service = new CodexRunnerService({
      store,
      sessionStore: new InMemorySessionStore(),
      logStreamer: new InMemoryLogStreamer(),
      worktreeManager: new FakeWorktreeManager(),
      maxConcurrentTasks: 0,
    });

    const graph = await service.createTaskGraph({
      parent: {
        taskId: "task-parent",
        repoPath: "/repo",
        prompt: "Coordinate the implementation",
        contextPackage: {
          summary: "Parent context",
          sources: [buildContextSource()],
          artifacts: [],
        },
      },
      children: [
        {
          taskId: "task-child-a",
          prompt: "Implement API",
          priority: 2,
        },
        {
          taskId: "task-child-b",
          repoPath: "/other-repo",
          prompt: "Write docs",
          dependencyTaskIds: ["task-child-a"],
          contextPackage: {
            sources: [],
            artifacts: [buildContextArtifact()],
          },
        },
      ],
    });

    expect(graph).toEqual({
      parent: {
        taskId: "task-parent",
        repoPath: "/repo",
        prompt: "Coordinate the implementation",
        priority: 0,
        state: "queued",
        decomposition: undefined,
      },
      children: [
        {
          taskId: "task-child-a",
          repoPath: "/repo",
          prompt: "Implement API",
          priority: 2,
          state: "queued",
          decomposition: {
            kind: "subtask",
            parentTaskId: "task-parent",
          },
        },
        {
          taskId: "task-child-b",
          repoPath: "/other-repo",
          prompt: "Write docs",
          priority: 0,
          state: "queued",
          decomposition: {
            kind: "subtask",
            parentTaskId: "task-parent",
            dependencyTaskIds: ["task-child-a"],
          },
        },
      ],
      state: "queued",
    });
    await expect(service.getContextPackage("task-parent")).resolves.toMatchObject({
      taskId: "task-parent",
      summary: "Parent context",
    });
    await expect(service.getContextPackage("task-child-b")).resolves.toMatchObject({
      taskId: "task-child-b",
      artifacts: [buildContextArtifact()],
    });
    await expect(service.listEvents("task-parent")).resolves.toEqual([
      {
        taskId: "task-parent",
        type: "task.graph.created",
        graphState: "queued",
        message: "Created task graph with 2 child tasks",
      },
      { taskId: "task-parent", type: "task.queued" },
    ]);
  });

  it("does not schedule a task graph parent as a worker", async () => {
    const store = new InMemoryRunnerStore();
    const sessionStore = new InMemorySessionStore();
    const logStreamer = new InMemoryLogStreamer();
    const worktreeManager = new FakeWorktreeManager();
    const agentSession = new FakeAgentSession();
    const service = new CodexRunnerService({
      store,
      sessionStore,
      logStreamer,
      worktreeManager,
      maxConcurrentTasks: 1,
      agentSessionFactory: new FakeAgentSessionFactory(agentSession),
    });

    await service.createTaskGraph({
      parent: {
        taskId: "task-parent",
        repoPath: "/repo",
        prompt: "Coordinate",
      },
      children: [
        {
          taskId: "task-child",
          prompt: "Do the work",
        },
      ],
    });

    expect(agentSession.started.map((session) => session.taskId)).toEqual(["task-child"]);
    expect(worktreeManager.allocations.map((allocation) => allocation.taskId)).toEqual(["task-child"]);
    const parentTask = await service.getTask("task-parent");
    expect(parentTask).toMatchObject({
      taskId: "task-parent",
      state: "queued",
    });
    expect(parentTask).not.toHaveProperty("activeSessionId");
    expect(parentTask).not.toHaveProperty("worktreePath");
  });

  it("rejects a task graph with duplicate task ids before persisting it", async () => {
    const store = new InMemoryRunnerStore();
    const service = new CodexRunnerService({
      store,
      sessionStore: new InMemorySessionStore(),
      logStreamer: new InMemoryLogStreamer(),
      worktreeManager: new FakeWorktreeManager(),
      maxConcurrentTasks: 0,
    });

    await expect(
      service.createTaskGraph({
        parent: {
          taskId: "task-parent",
          repoPath: "/repo",
          prompt: "Parent",
        },
        children: [
          {
            taskId: "task-child",
            prompt: "First child",
          },
          {
            taskId: "task-child",
            prompt: "Duplicate child",
          },
        ],
      }),
    ).rejects.toThrow("Task graph contains duplicate task id task-child");
    await expect(service.listTasks()).resolves.toEqual([]);
  });

  it("rejects invalid child dependency metadata before persisting a task graph", async () => {
    const cases: Array<{
      children: CreateTaskGraphInput["children"];
      message: string;
    }> = [
      {
        children: [
          {
            taskId: "task-child-a",
            prompt: "First child",
            dependencyTaskIds: ["task-child-b", "task-child-b"],
          },
          {
            taskId: "task-child-b",
            prompt: "Second child",
          },
        ],
        message: "Task graph child task-child-a contains duplicate dependency task-child-b",
      },
      {
        children: [
          {
            taskId: "task-child-a",
            prompt: "First child",
            dependencyTaskIds: ["task-missing"],
          },
        ],
        message: "Task graph child task-child-a depends on missing child task task-missing",
      },
      {
        children: [
          {
            taskId: "task-child-a",
            prompt: "First child",
            dependencyTaskIds: ["task-child-a"],
          },
        ],
        message: "Task graph child task-child-a cannot depend on itself",
      },
      {
        children: [
          {
            taskId: "task-child-a",
            prompt: "First child",
            dependencyTaskIds: ["task-child-b"],
          },
          {
            taskId: "task-child-b",
            prompt: "Second child",
            dependencyTaskIds: ["task-child-a"],
          },
        ],
        message:
          "Task graph child dependencies contain a cycle: task-child-a -> task-child-b -> task-child-a",
      },
    ];

    for (const testCase of cases) {
      const store = new InMemoryRunnerStore();
      const service = new CodexRunnerService({
        store,
        sessionStore: new InMemorySessionStore(),
        logStreamer: new InMemoryLogStreamer(),
        worktreeManager: new FakeWorktreeManager(),
        maxConcurrentTasks: 0,
      });

      await expect(
        service.createTaskGraph({
          parent: {
            taskId: "task-parent",
            repoPath: "/repo",
            prompt: "Parent",
          },
          children: testCase.children,
        }),
      ).rejects.toThrow(testCase.message);
      await expect(service.listTasks()).resolves.toEqual([]);
    }
  });

  it("leaves later tasks queued when the pool is full", async () => {
    const store = new InMemoryRunnerStore();
    const sessionStore = new InMemorySessionStore();
    const logStreamer = new InMemoryLogStreamer();
    const worktreeManager = new FakeWorktreeManager();
    const agentSession = new FakeAgentSession();
    const service = new CodexRunnerService({
      store,
      sessionStore,
      logStreamer,
      worktreeManager,
      maxConcurrentTasks: 1,
      agentSessionFactory: new FakeAgentSessionFactory(agentSession),
    });

    await service.startTask({
      taskId: "task-1",
      repoPath: "/repo",
      prompt: "first",
    });
    const secondTask = await service.startTask({
      taskId: "task-2",
      repoPath: "/repo",
      prompt: "second",
    });

    expect(secondTask.state).toBe("queued");
    expect(secondTask.worktreePath).toBeUndefined();
    expect(worktreeManager.allocations).toHaveLength(1);
  });

  it("fails the task when worktree provisioning fails", async () => {
    const store = new InMemoryRunnerStore();
    const sessionStore = new InMemorySessionStore();
    const logStreamer = new InMemoryLogStreamer();
    const worktreeManager = new FakeWorktreeManager();
    worktreeManager.failure = new WorktreeProvisioningError(
      "git worktree add failed",
      "task-1",
      "/repo",
    );
    const service = new CodexRunnerService({
      store,
      sessionStore,
      logStreamer,
      worktreeManager,
      maxConcurrentTasks: 1,
    });

    const task = await service.startTask({
      taskId: "task-1",
      repoPath: "/repo",
      prompt: "Implement the runner",
    });

    expect(task.state).toBe("failed");
    expect(task.worktreePath).toBeUndefined();

    await expect(service.listEvents("task-1")).resolves.toEqual([
      { taskId: "task-1", type: "task.queued" },
      {
        taskId: "task-1",
        type: "task.failed",
        errorCode: "WORKTREE_PROVISIONING_FAILED",
        message: "git worktree add failed",
      },
    ]);
  });

  it("resumes an interrupted task in the same worktree", async () => {
    const store = new InMemoryRunnerStore();
    const sessionStore = new InMemorySessionStore();
    const logStreamer = new InMemoryLogStreamer();
    const worktreeManager = new FakeWorktreeManager();
    const agentSession = new FakeAgentSession();
    const service = new CodexRunnerService({
      store,
      sessionStore,
      logStreamer,
      worktreeManager,
      maxConcurrentTasks: 1,
      agentSessionFactory: new FakeAgentSessionFactory(agentSession),
    });

    await service.startTask({
      taskId: "task-1",
      repoPath: "/repo",
      prompt: "first",
    });

    await service.interruptTask("task-1");
    const resumed = await service.resumeTask("task-1");

    expect(agentSession.interrupted).toEqual(["session-1"]);
    expect(resumed.state).toBe("running");
    expect(resumed.worktreePath).toBe("/repo/.plato/worktrees/task-1");
    expect(resumed.activeSessionId).toBe("session-2");
    expect(worktreeManager.allocations).toHaveLength(1);
    await expect(sessionStore.listSessionsByTask("task-1")).resolves.toEqual([
      {
        sessionId: "session-1",
        taskId: "task-1",
        worktreePath: "/repo/.plato/worktrees/task-1",
        state: "interrupted",
      },
      {
        sessionId: "session-2",
        taskId: "task-1",
        worktreePath: "/repo/.plato/worktrees/task-1",
        state: "running",
        pid: 2,
      },
    ]);

    await expect(service.listEvents("task-1")).resolves.toEqual([
      { taskId: "task-1", type: "task.queued" },
      {
        taskId: "task-1",
        type: "task.started",
        sessionId: "session-1",
        worktreePath: "/repo/.plato/worktrees/task-1",
      },
      {
        taskId: "task-1",
        type: "task.interrupted",
        worktreePath: "/repo/.plato/worktrees/task-1",
      },
      {
        taskId: "task-1",
        type: "task.resumed",
        sessionId: "session-2",
        worktreePath: "/repo/.plato/worktrees/task-1",
      },
    ]);
  });

  it("completes a task and schedules the next queued task when the session exits successfully", async () => {
    const store = new InMemoryRunnerStore();
    const sessionStore = new InMemorySessionStore();
    const logStreamer = new InMemoryLogStreamer();
    const worktreeManager = new FakeWorktreeManager();
    const agentSession = new FakeAgentSession();
    const service = new CodexRunnerService({
      store,
      sessionStore,
      logStreamer,
      worktreeManager,
      maxConcurrentTasks: 1,
      agentSessionFactory: new FakeAgentSessionFactory(agentSession),
    });

    const firstTask = await service.startTask({
      taskId: "task-1",
      repoPath: "/repo",
      prompt: "first",
    });
    const secondTask = await service.startTask({
      taskId: "task-2",
      repoPath: "/repo",
      prompt: "second",
    });

    expect(firstTask.state).toBe("running");
    expect(secondTask.state).toBe("queued");

    await agentSession.exit("session-1", 0);

    await expect(service.getTask("task-1")).resolves.toMatchObject({
      taskId: "task-1",
      state: "completed",
      activeSessionId: undefined,
    });
    await expect(service.getTask("task-2")).resolves.toMatchObject({
      taskId: "task-2",
      state: "running",
      activeSessionId: "session-2",
    });
    await expect(sessionStore.getSession("session-1")).resolves.toMatchObject({
      sessionId: "session-1",
      taskId: "task-1",
      state: "completed",
      exitCode: 0,
    });

    await expect(service.listEvents("task-1")).resolves.toEqual([
      { taskId: "task-1", type: "task.queued" },
      {
        taskId: "task-1",
        type: "task.started",
        sessionId: "session-1",
        worktreePath: "/repo/.plato/worktrees/task-1",
      },
      {
        taskId: "task-1",
        type: "task.completed",
        sessionId: "session-1",
        worktreePath: "/repo/.plato/worktrees/task-1",
        exitCode: 0,
      },
    ]);
  });

  it("fills every newly freed slot after a running task completes", async () => {
    const store = new InMemoryRunnerStore();
    const sessionStore = new InMemorySessionStore();
    const logStreamer = new InMemoryLogStreamer();
    const worktreeManager = new FakeWorktreeManager();
    const agentSession = new FakeAgentSession();
    const service = new CodexRunnerService({
      store,
      sessionStore,
      logStreamer,
      worktreeManager,
      maxConcurrentTasks: 3,
      agentSessionFactory: new FakeAgentSessionFactory(agentSession),
    });

    await service.startTask({
      taskId: "task-1",
      repoPath: "/repo",
      prompt: "first running",
    });
    await service.startTask({
      taskId: "task-2",
      repoPath: "/repo",
      prompt: "second running",
    });
    await service.startTask({
      taskId: "task-3",
      repoPath: "/repo",
      prompt: "third queued",
    });
    await service.startTask({
      taskId: "task-4",
      repoPath: "/repo",
      prompt: "fourth queued",
    });

    await agentSession.exit("session-1", 0);

    await expect(service.getTask("task-2")).resolves.toMatchObject({
      taskId: "task-2",
      state: "running",
      activeSessionId: "session-2",
    });
    await expect(service.getTask("task-3")).resolves.toMatchObject({
      taskId: "task-3",
      state: "running",
      activeSessionId: "session-3",
    });
    await expect(service.getTask("task-4")).resolves.toMatchObject({
      taskId: "task-4",
      state: "running",
      activeSessionId: "session-4",
    });
  });

  it("marks a task failed when the session exits with a non-zero code", async () => {
    const store = new InMemoryRunnerStore();
    const sessionStore = new InMemorySessionStore();
    const logStreamer = new InMemoryLogStreamer();
    const worktreeManager = new FakeWorktreeManager();
    const agentSession = new FakeAgentSession();
    const service = new CodexRunnerService({
      store,
      sessionStore,
      logStreamer,
      worktreeManager,
      maxConcurrentTasks: 1,
      agentSessionFactory: new FakeAgentSessionFactory(agentSession),
    });

    await service.startTask({
      taskId: "task-1",
      repoPath: "/repo",
      prompt: "failing task",
    });

    await agentSession.exit("session-1", 23);

    await expect(service.getTask("task-1")).resolves.toMatchObject({
      taskId: "task-1",
      state: "failed",
      activeSessionId: undefined,
    });
    await expect(sessionStore.getSession("session-1")).resolves.toMatchObject({
      sessionId: "session-1",
      taskId: "task-1",
      state: "failed",
      exitCode: 23,
    });
    await expect(service.listEvents("task-1")).resolves.toEqual([
      { taskId: "task-1", type: "task.queued" },
      {
        taskId: "task-1",
        type: "task.started",
        sessionId: "session-1",
        worktreePath: "/repo/.plato/worktrees/task-1",
      },
      {
        taskId: "task-1",
        type: "task.failed",
        sessionId: "session-1",
        worktreePath: "/repo/.plato/worktrees/task-1",
        exitCode: 23,
        errorCode: "TASK_EXIT_NON_ZERO",
        message: "Task exited with code 23",
      },
    ]);
  });

  it("emits parent graph lifecycle events as child tasks reach terminal states", async () => {
    const store = new InMemoryRunnerStore();
    const sessionStore = new InMemorySessionStore();
    const logStreamer = new InMemoryLogStreamer();
    const worktreeManager = new FakeWorktreeManager();
    const agentSession = new FakeAgentSession();
    const service = new CodexRunnerService({
      store,
      sessionStore,
      logStreamer,
      worktreeManager,
      maxConcurrentTasks: 3,
      agentSessionFactory: new FakeAgentSessionFactory(agentSession),
    });

    await service.createTaskGraph({
      parent: {
        taskId: "task-parent",
        repoPath: "/repo",
        prompt: "Coordinate",
      },
      children: [
        {
          taskId: "task-child-a",
          prompt: "First child",
        },
        {
          taskId: "task-child-b",
          prompt: "Second child",
        },
      ],
    });

    await agentSession.exit("session-1", 0);
    await expect(service.getTaskGraph("task-child-a")).resolves.toMatchObject({
      parent: {
        taskId: "task-parent",
      },
      state: "running",
    });

    await agentSession.exit("session-3", 0);
    await agentSession.exit("session-2", 1);

    await expect(service.getTaskGraph("task-parent")).resolves.toMatchObject({
      parent: {
        taskId: "task-parent",
        state: "failed",
      },
      state: "failed",
    });
    await expect(service.listEvents("task-parent")).resolves.toEqual([
      {
        taskId: "task-parent",
        type: "task.graph.created",
        graphState: "queued",
        message: "Created task graph with 2 child tasks",
      },
      { taskId: "task-parent", type: "task.queued" },
      {
        taskId: "task-parent",
        type: "task.graph.result.collected",
        parentTaskId: "task-parent",
        childTaskId: "task-child-a",
        resultId: "result-task-child-a",
        resultClassification: "completed",
        errorCode: undefined,
        message: "Task task-child-a completed successfully.",
      },
      {
        taskId: "task-parent",
        type: "task.graph.child.completed",
        parentTaskId: "task-parent",
        childTaskId: "task-child-a",
        graphState: "running",
      },
      {
        taskId: "task-parent",
        type: "task.failed",
        sessionId: undefined,
        worktreePath: undefined,
        errorCode: "TASK_GRAPH_CHILD_FAILED",
        message: "Graph failed because child task task-child-b failed",
      },
      {
        taskId: "task-parent",
        type: "task.graph.result.collected",
        parentTaskId: "task-parent",
        childTaskId: "task-child-b",
        resultId: "result-task-child-b",
        resultClassification: "failed",
        errorCode: "TASK_EXIT_NON_ZERO",
        message: "Task exited with code 1",
      },
      {
        taskId: "task-parent",
        type: "task.graph.child.failed",
        parentTaskId: "task-parent",
        childTaskId: "task-child-b",
        graphState: "failed",
      },
      {
        taskId: "task-parent",
        type: "task.graph.synthesized",
        parentTaskId: "task-parent",
        synthesisId: "synthesis-task-parent",
        resultClassification: "failed",
        message: "Synthesized 2 child task results as failed. completed=1 partial=0 conflicted=0 failed=1",
      },
      {
        taskId: "task-parent",
        type: "task.graph.failed",
        parentTaskId: "task-parent",
        graphState: "failed",
      },
    ]);
  });

  it("emits the graph terminal event when the parent is the last task to complete", async () => {
    const store = new InMemoryRunnerStore();
    const sessionStore = new InMemorySessionStore();
    const logStreamer = new InMemoryLogStreamer();
    const worktreeManager = new FakeWorktreeManager();
    const agentSession = new FakeAgentSession();
    const service = new CodexRunnerService({
      store,
      sessionStore,
      logStreamer,
      worktreeManager,
      maxConcurrentTasks: 3,
      agentSessionFactory: new FakeAgentSessionFactory(agentSession),
    });

    await service.createTaskGraph({
      parent: {
        taskId: "task-parent",
        repoPath: "/repo",
        prompt: "Coordinate",
      },
      children: [
        {
          taskId: "task-child-a",
          prompt: "First child",
        },
        {
          taskId: "task-child-b",
          prompt: "Second child",
        },
      ],
    });

    await agentSession.exit("session-1", 0);
    await agentSession.exit("session-2", 0);

    await expect(service.getTaskGraph("task-parent")).resolves.toMatchObject({
      state: "completed",
    });
    await expect(service.listEvents("task-parent")).resolves.toContainEqual({
      taskId: "task-parent",
      type: "task.graph.completed",
      parentTaskId: "task-parent",
      graphState: "completed",
    });
  });

  it("collects durable child results and synthesizes the parent once every child is terminal", async () => {
    const store = new InMemoryRunnerStore();
    const sessionStore = new InMemorySessionStore();
    const logStreamer = new InMemoryLogStreamer();
    const worktreeManager = new FakeWorktreeManager();
    const agentSession = new FakeAgentSession();
    const resultCollector = new FakeTaskResultCollector();
    const synthesizer = new FakeParentTaskOutcomeSynthesizer();
    resultCollector.results.set("task-child-a", {
      resultId: "result-a",
      taskId: "task-child-a",
      parentTaskId: "task-parent",
      classification: "partial",
      summary: "API complete, tests pending",
    });
    const service = new CodexRunnerService({
      store,
      sessionStore,
      logStreamer,
      worktreeManager,
      maxConcurrentTasks: 2,
      agentSessionFactory: new FakeAgentSessionFactory(agentSession),
      taskResultCollector: resultCollector,
      parentTaskOutcomeSynthesizer: synthesizer,
    });

    await service.createTaskGraph({
      parent: {
        taskId: "task-parent",
        repoPath: "/repo",
        prompt: "Coordinate",
      },
      children: [
        {
          taskId: "task-child-a",
          prompt: "First child",
        },
        {
          taskId: "task-child-b",
          prompt: "Second child",
        },
      ],
    });

    await agentSession.exit("session-1", 0);

    await expect(service.getTaskGraphResults("task-parent")).resolves.toEqual({
      parentTaskId: "task-parent",
      results: [
        {
          resultId: "result-a",
          taskId: "task-child-a",
          parentTaskId: "task-parent",
          classification: "partial",
          summary: "API complete, tests pending",
        },
      ],
      synthesis: undefined,
    });

    await agentSession.exit("session-2", 1);

    await expect(service.getTaskGraphResults("task-child-a")).resolves.toEqual({
      parentTaskId: "task-parent",
      results: [
        {
          resultId: "result-a",
          taskId: "task-child-a",
          parentTaskId: "task-parent",
          classification: "partial",
          summary: "API complete, tests pending",
        },
        {
          resultId: "result-task-child-b",
          taskId: "task-child-b",
          parentTaskId: "task-parent",
          classification: "failed",
          summary: "Task exited with code 1",
          errorCode: "TASK_EXIT_NON_ZERO",
        },
      ],
      synthesis: {
        synthesisId: "synthesis-task-parent",
        parentTaskId: "task-parent",
        classification: "failed",
        summary: "Synthesized 2 results",
        childTaskCount: 2,
        resultIds: ["result-a", "result-task-child-b"],
      },
    });
    expect(resultCollector.calls.map((call) => call.task.taskId)).toEqual(["task-child-a"]);
    expect(synthesizer.calls).toHaveLength(1);
    await expect(service.listEvents("task-parent")).resolves.toContainEqual({
      taskId: "task-parent",
      type: "task.graph.synthesized",
      parentTaskId: "task-parent",
      synthesisId: "synthesis-task-parent",
      resultClassification: "failed",
      message: "Synthesized 2 results",
    });
  });

  it("synthesizes partial and conflicted child outputs when all workers succeed", async () => {
    const store = new InMemoryRunnerStore();
    const sessionStore = new InMemorySessionStore();
    const logStreamer = new InMemoryLogStreamer();
    const worktreeManager = new FakeWorktreeManager();
    const agentSession = new FakeAgentSession();
    const resultCollector = new FakeTaskResultCollector();
    const synthesizer = new FakeParentTaskOutcomeSynthesizer();
    resultCollector.results.set("task-child-a", {
      resultId: "result-a",
      taskId: "task-child-a",
      parentTaskId: "task-parent",
      classification: "partial",
      summary: "API complete, docs pending",
    });
    resultCollector.results.set("task-child-b", {
      resultId: "result-b",
      taskId: "task-child-b",
      parentTaskId: "task-parent",
      classification: "conflicted",
      summary: "Both workers edited the same file",
    });
    const service = new CodexRunnerService({
      store,
      sessionStore,
      logStreamer,
      worktreeManager,
      maxConcurrentTasks: 2,
      agentSessionFactory: new FakeAgentSessionFactory(agentSession),
      taskResultCollector: resultCollector,
      parentTaskOutcomeSynthesizer: synthesizer,
    });

    await service.createTaskGraph({
      parent: {
        taskId: "task-parent",
        repoPath: "/repo",
        prompt: "Coordinate",
      },
      children: [
        {
          taskId: "task-child-a",
          prompt: "First child",
        },
        {
          taskId: "task-child-b",
          prompt: "Second child",
        },
      ],
    });

    await agentSession.exit("session-1", 0);
    await agentSession.exit("session-2", 0);

    await expect(service.getTaskGraphResults("task-parent")).resolves.toMatchObject({
      parentTaskId: "task-parent",
      results: [
        {
          resultId: "result-a",
          classification: "partial",
        },
        {
          resultId: "result-b",
          classification: "conflicted",
        },
      ],
      synthesis: {
        synthesisId: "synthesis-task-parent",
        parentTaskId: "task-parent",
        classification: "partial",
        summary: "Synthesized 2 results",
        childTaskCount: 2,
        resultIds: ["result-a", "result-b"],
      },
    });
    expect(synthesizer.calls).toHaveLength(1);
  });

  it("reconciles missing graph results for already-terminal children", async () => {
    const store = new InMemoryRunnerStore();
    const service = new CodexRunnerService({
      store,
      sessionStore: new InMemorySessionStore(),
      logStreamer: new InMemoryLogStreamer(),
      worktreeManager: new FakeWorktreeManager(),
      maxConcurrentTasks: 0,
    });

    await store.saveTaskGraph(
      [
        {
          taskId: "task-parent",
          repoPath: "/repo",
          prompt: "Coordinate",
          priority: 0,
          state: "queued",
        },
        {
          taskId: "task-child-a",
          repoPath: "/repo",
          prompt: "Done",
          priority: 0,
          state: "completed",
          decomposition: {
            kind: "subtask",
            parentTaskId: "task-parent",
          },
        },
        {
          taskId: "task-child-b",
          repoPath: "/repo",
          prompt: "Failed",
          priority: 0,
          state: "failed",
          decomposition: {
            kind: "subtask",
            parentTaskId: "task-parent",
          },
        },
      ],
      [],
    );

    await expect(service.reconcileTaskGraphResults("task-parent")).resolves.toEqual({
      parentTaskId: "task-parent",
      results: [
        {
          resultId: "result-task-child-a",
          taskId: "task-child-a",
          parentTaskId: "task-parent",
          classification: "completed",
          summary: "Task task-child-a completed successfully.",
        },
        {
          resultId: "result-task-child-b",
          taskId: "task-child-b",
          parentTaskId: "task-parent",
          classification: "failed",
          summary: "Recovered missing failed result for task task-child-b.",
          errorCode: "TASK_RESULT_RECOVERED_FROM_FAILED_CHILD",
        },
      ],
      synthesis: {
        synthesisId: "synthesis-task-parent",
        parentTaskId: "task-parent",
        classification: "failed",
        summary: "Synthesized 2 child task results as failed. completed=1 partial=0 conflicted=0 failed=1",
        childTaskCount: 2,
        resultIds: ["result-task-child-a", "result-task-child-b"],
      },
    });
  });

  it("runs only dependency-satisfied graph workers while independent workers run concurrently", async () => {
    const store = new InMemoryRunnerStore();
    const sessionStore = new InMemorySessionStore();
    const logStreamer = new InMemoryLogStreamer();
    const worktreeManager = new FakeWorktreeManager();
    const agentSession = new FakeAgentSession();
    const service = new CodexRunnerService({
      store,
      sessionStore,
      logStreamer,
      worktreeManager,
      maxConcurrentTasks: 4,
      agentSessionFactory: new FakeAgentSessionFactory(agentSession),
    });

    await service.createTaskGraph({
      parent: {
        taskId: "task-parent",
        repoPath: "/repo",
        prompt: "Coordinate",
      },
      children: [
        {
          taskId: "task-api",
          prompt: "Build API",
        },
        {
          taskId: "task-ui",
          prompt: "Build UI",
        },
        {
          taskId: "task-integration",
          prompt: "Wire integration",
          priority: 100,
          dependencyTaskIds: ["task-api"],
        },
      ],
    });

    expect(agentSession.started.map((session) => session.taskId)).toEqual([
      "task-api",
      "task-ui",
    ]);
    await expect(service.getTask("task-integration")).resolves.toMatchObject({
      taskId: "task-integration",
      state: "queued",
      decomposition: {
        kind: "subtask",
        parentTaskId: "task-parent",
        dependencyTaskIds: ["task-api"],
      },
    });

    await agentSession.exit("session-1", 0);

    await expect(service.getTask("task-integration")).resolves.toMatchObject({
      taskId: "task-integration",
      state: "running",
      activeSessionId: "session-3",
    });
    expect(agentSession.started.map((session) => session.taskId)).toEqual([
      "task-api",
      "task-ui",
      "task-integration",
    ]);
    await expect(service.listEvents("task-integration")).resolves.toEqual([
      { taskId: "task-integration", type: "task.queued" },
      {
        taskId: "task-integration",
        type: "task.graph.dependency.satisfied",
        parentTaskId: "task-parent",
        dependencyTaskId: "task-api",
        dependencyTaskIds: ["task-api"],
      },
      {
        taskId: "task-integration",
        type: "task.started",
        sessionId: "session-3",
        worktreePath: "/repo/.plato/worktrees/task-integration",
      },
      {
        taskId: "task-integration",
        type: "task.graph.worker.started",
        parentTaskId: "task-parent",
        dependencyTaskIds: ["task-api"],
        sessionId: "session-3",
        worktreePath: "/repo/.plato/worktrees/task-integration",
      },
    ]);
  });

  it("blocks dependent graph workers when a prerequisite fails", async () => {
    const store = new InMemoryRunnerStore();
    const sessionStore = new InMemorySessionStore();
    const logStreamer = new InMemoryLogStreamer();
    const worktreeManager = new FakeWorktreeManager();
    const agentSession = new FakeAgentSession();
    const service = new CodexRunnerService({
      store,
      sessionStore,
      logStreamer,
      worktreeManager,
      maxConcurrentTasks: 3,
      agentSessionFactory: new FakeAgentSessionFactory(agentSession),
    });

    await service.createTaskGraph({
      parent: {
        taskId: "task-parent",
        repoPath: "/repo",
        prompt: "Coordinate",
      },
      children: [
        {
          taskId: "task-prereq",
          prompt: "Build prerequisite",
        },
        {
          taskId: "task-dependent",
          prompt: "Use prerequisite",
          dependencyTaskIds: ["task-prereq"],
        },
        {
          taskId: "task-docs",
          prompt: "Document prerequisite",
          dependencyTaskIds: ["task-prereq"],
        },
      ],
    });

    await agentSession.exit("session-1", 1);

    await expect(service.getTask("task-dependent")).resolves.toMatchObject({
      taskId: "task-dependent",
      state: "failed",
      activeSessionId: undefined,
    });
    await expect(service.getTask("task-docs")).resolves.toMatchObject({
      taskId: "task-docs",
      state: "failed",
      activeSessionId: undefined,
    });
    await expect(service.getTask("task-parent")).resolves.toMatchObject({
      taskId: "task-parent",
      state: "failed",
      activeSessionId: undefined,
    });
    expect(agentSession.started.map((session) => session.taskId)).toEqual([
      "task-prereq",
    ]);
    await expect(service.listEvents("task-dependent")).resolves.toEqual([
      { taskId: "task-dependent", type: "task.queued" },
      {
        taskId: "task-dependent",
        type: "task.graph.dependency.blocked",
        parentTaskId: "task-parent",
        dependencyTaskIds: ["task-prereq"],
        blockedByTaskIds: ["task-prereq"],
        errorCode: "TASK_GRAPH_DEPENDENCY_FAILED",
        message: "Blocked by failed graph dependency task-prereq",
      },
      {
        taskId: "task-dependent",
        type: "task.failed",
        errorCode: "TASK_GRAPH_DEPENDENCY_FAILED",
        message: "Blocked by failed graph dependency task-prereq",
      },
    ]);
    const parentEvents = await service.listEvents("task-parent");
    expect(parentEvents.filter((event) => event.type === "task.graph.failed")).toHaveLength(1);
    expect(parentEvents).toContainEqual({
      taskId: "task-parent",
      type: "task.failed",
      sessionId: undefined,
      worktreePath: undefined,
      errorCode: "TASK_GRAPH_CHILD_FAILED",
      message: "Graph failed because child task task-dependent failed",
    });
  });

  it("persists a pending approval checkpoint and resumes with a new session when approved", async () => {
    const store = new InMemoryRunnerStore();
    const sessionStore = new InMemorySessionStore();
    const logStreamer = new InMemoryLogStreamer();
    const worktreeManager = new FakeWorktreeManager();
    const agentSession = new FakeAgentSession();
    const service = new CodexRunnerService({
      store,
      sessionStore,
      logStreamer,
      worktreeManager,
      maxConcurrentTasks: 1,
      agentSessionFactory: new FakeAgentSessionFactory(agentSession),
    });

    await service.startTask({
      taskId: "task-1",
      repoPath: "/repo",
      prompt: "needs approval",
    });
    const awaitingApproval = await service.requestTaskApproval("task-1", {
      approvalRequestId: "approval-1",
      requestedAction: "apply_patch",
      reason: "Writes files in the worktree.",
    });

    expect(awaitingApproval).toMatchObject({
      taskId: "task-1",
      state: "awaiting_approval",
      activeSessionId: "session-1",
      pendingApproval: buildPendingApproval(),
    });
    await expect(sessionStore.getSession("session-1")).resolves.toMatchObject({
      sessionId: "session-1",
      taskId: "task-1",
      state: "awaiting_approval",
      pendingApproval: buildPendingApproval(),
    });

    const approved = await service.approveTaskAction("task-1");

    expect(approved).toMatchObject({
      taskId: "task-1",
      state: "running",
      activeSessionId: "session-2",
      worktreePath: "/repo/.plato/worktrees/task-1",
      pendingApproval: undefined,
    });
    await expect(sessionStore.listSessionsByTask("task-1")).resolves.toEqual([
      {
        sessionId: "session-1",
        taskId: "task-1",
        worktreePath: "/repo/.plato/worktrees/task-1",
        pid: 1,
        state: "awaiting_approval",
        pendingApproval: buildPendingApproval(),
      },
      {
        sessionId: "session-2",
        taskId: "task-1",
        worktreePath: "/repo/.plato/worktrees/task-1",
        pid: 2,
        state: "running",
      },
    ]);
    await expect(service.listEvents("task-1")).resolves.toEqual([
      { taskId: "task-1", type: "task.queued" },
      {
        taskId: "task-1",
        type: "task.started",
        sessionId: "session-1",
        worktreePath: "/repo/.plato/worktrees/task-1",
      },
      {
        taskId: "task-1",
        type: "task.awaiting_approval",
        sessionId: "session-1",
        worktreePath: "/repo/.plato/worktrees/task-1",
        approvalRequestId: "approval-1",
        requestedAction: "apply_patch",
        message: "Writes files in the worktree.",
      },
      {
        taskId: "task-1",
        type: "task.approval.granted",
        sessionId: "session-1",
        worktreePath: "/repo/.plato/worktrees/task-1",
        approvalRequestId: "approval-1",
        requestedAction: "apply_patch",
      },
      {
        taskId: "task-1",
        type: "task.resumed",
        sessionId: "session-2",
        worktreePath: "/repo/.plato/worktrees/task-1",
      },
    ]);
  });

  it("keeps awaiting approval tasks counted against capacity until the checkpoint resolves", async () => {
    const store = new InMemoryRunnerStore();
    const sessionStore = new InMemorySessionStore();
    const logStreamer = new InMemoryLogStreamer();
    const worktreeManager = new FakeWorktreeManager();
    const agentSession = new FakeAgentSession();
    const service = new CodexRunnerService({
      store,
      sessionStore,
      logStreamer,
      worktreeManager,
      maxConcurrentTasks: 1,
      agentSessionFactory: new FakeAgentSessionFactory(agentSession),
    });

    await service.startTask({
      taskId: "task-1",
      repoPath: "/repo",
      prompt: "needs approval",
    });
    await service.requestTaskApproval("task-1", {
      approvalRequestId: "approval-1",
      requestedAction: "apply_patch",
      reason: "Writes files in the worktree.",
    });

    const queuedWhileAwaitingApproval = await service.startTask({
      taskId: "task-2",
      repoPath: "/repo",
      prompt: "queued until approval clears",
    });

    expect(queuedWhileAwaitingApproval.taskId).toBe("task-2");
    expect(queuedWhileAwaitingApproval.state).toBe("queued");
    expect(queuedWhileAwaitingApproval.activeSessionId).toBeUndefined();
    expect(agentSession.started).toEqual([
      {
        taskId: "task-1",
        worktreePath: "/repo/.plato/worktrees/task-1",
        sessionId: "session-1",
      },
    ]);

    await service.rejectTaskAction("task-1", "Operator denied the change.");

    await expect(service.getTask("task-2")).resolves.toMatchObject({
      taskId: "task-2",
      state: "running",
      activeSessionId: "session-2",
      worktreePath: "/repo/.plato/worktrees/task-2",
    });
  });

  it("rejects approval requests for stale session ids", async () => {
    const store = new InMemoryRunnerStore();
    const sessionStore = new InMemorySessionStore();
    const logStreamer = new InMemoryLogStreamer();
    const worktreeManager = new FakeWorktreeManager();
    const agentSession = new FakeAgentSession();
    const service = new CodexRunnerService({
      store,
      sessionStore,
      logStreamer,
      worktreeManager,
      maxConcurrentTasks: 1,
      agentSessionFactory: new FakeAgentSessionFactory(agentSession),
    });

    await service.startTask({
      taskId: "task-1",
      repoPath: "/repo",
      prompt: "needs approval",
    });

    await expect(
      service.requestTaskApproval("task-1", {
        sessionId: "session-stale",
        approvalRequestId: "approval-1",
        requestedAction: "apply_patch",
        reason: "Writes files in the worktree.",
      }),
    ).rejects.toThrow("Task task-1 approval session session-stale is not the active session");

    await expect(service.getTask("task-1")).resolves.toMatchObject({
      taskId: "task-1",
      state: "running",
      activeSessionId: "session-1",
    });
    await expect(service.getTask("task-1")).resolves.not.toHaveProperty("pendingApproval");
    await expect(service.listEvents("task-1")).resolves.toEqual([
      { taskId: "task-1", type: "task.queued" },
      {
        taskId: "task-1",
        type: "task.started",
        sessionId: "session-1",
        worktreePath: "/repo/.plato/worktrees/task-1",
      },
    ]);
  });

  it("rejects approval requests when the active session is no longer running", async () => {
    const store = new InMemoryRunnerStore();
    const sessionStore = new InMemorySessionStore();
    const logStreamer = new InMemoryLogStreamer();
    const worktreeManager = new FakeWorktreeManager();
    const agentSession = new FakeAgentSession();
    const service = new CodexRunnerService({
      store,
      sessionStore,
      logStreamer,
      worktreeManager,
      maxConcurrentTasks: 1,
      agentSessionFactory: new FakeAgentSessionFactory(agentSession),
    });

    await service.startTask({
      taskId: "task-1",
      repoPath: "/repo",
      prompt: "needs approval",
    });
    await sessionStore.saveSession({
      sessionId: "session-1",
      taskId: "task-1",
      worktreePath: "/repo/.plato/worktrees/task-1",
      pid: 1,
      state: "interrupted",
    });

    await expect(
      service.requestTaskApproval("task-1", {
        approvalRequestId: "approval-1",
        requestedAction: "apply_patch",
        reason: "Writes files in the worktree.",
      }),
    ).rejects.toThrow("Task task-1 approval session session-1 is not active");

    await expect(service.getTask("task-1")).resolves.toMatchObject({
      taskId: "task-1",
      state: "running",
      activeSessionId: "session-1",
    });
    await expect(service.getTask("task-1")).resolves.not.toHaveProperty("pendingApproval");
  });

  it("fails a task when a pending approval checkpoint is rejected", async () => {
    const store = new InMemoryRunnerStore();
    const sessionStore = new InMemorySessionStore();
    const logStreamer = new InMemoryLogStreamer();
    const worktreeManager = new FakeWorktreeManager();
    const agentSession = new FakeAgentSession();
    const service = new CodexRunnerService({
      store,
      sessionStore,
      logStreamer,
      worktreeManager,
      maxConcurrentTasks: 1,
      agentSessionFactory: new FakeAgentSessionFactory(agentSession),
    });

    await service.startTask({
      taskId: "task-1",
      repoPath: "/repo",
      prompt: "reject me",
    });
    await service.requestTaskApproval("task-1", {
      approvalRequestId: "approval-1",
      requestedAction: "apply_patch",
      reason: "Writes files in the worktree.",
    });

    const rejected = await service.rejectTaskAction("task-1", "Operator denied the change.");

    expect(rejected).toMatchObject({
      taskId: "task-1",
      state: "failed",
      activeSessionId: undefined,
      worktreePath: "/repo/.plato/worktrees/task-1",
      pendingApproval: undefined,
    });
    await expect(sessionStore.getSession("session-1")).resolves.toMatchObject({
      sessionId: "session-1",
      taskId: "task-1",
      state: "failed",
      worktreePath: "/repo/.plato/worktrees/task-1",
      pendingApproval: buildPendingApproval(),
    });
    await expect(service.listEvents("task-1")).resolves.toEqual([
      { taskId: "task-1", type: "task.queued" },
      {
        taskId: "task-1",
        type: "task.started",
        sessionId: "session-1",
        worktreePath: "/repo/.plato/worktrees/task-1",
      },
      {
        taskId: "task-1",
        type: "task.awaiting_approval",
        sessionId: "session-1",
        worktreePath: "/repo/.plato/worktrees/task-1",
        approvalRequestId: "approval-1",
        requestedAction: "apply_patch",
        message: "Writes files in the worktree.",
      },
      {
        taskId: "task-1",
        type: "task.approval.rejected",
        sessionId: "session-1",
        worktreePath: "/repo/.plato/worktrees/task-1",
        approvalRequestId: "approval-1",
        requestedAction: "apply_patch",
        message: "Operator denied the change.",
      },
      {
        taskId: "task-1",
        type: "task.failed",
        sessionId: "session-1",
        worktreePath: "/repo/.plato/worktrees/task-1",
        errorCode: "TASK_APPROVAL_REJECTED",
        message: "Operator denied the change.",
      },
    ]);
  });

  it("verifies a successful task before marking it completed", async () => {
    const store = new InMemoryRunnerStore();
    const sessionStore = new InMemorySessionStore();
    const logStreamer = new InMemoryLogStreamer();
    const worktreeManager = new FakeWorktreeManager();
    const agentSession = new FakeAgentSession();
    const verifier = new FakeTaskResultVerifier();
    const service = new CodexRunnerService({
      store,
      sessionStore,
      logStreamer,
      worktreeManager,
      maxConcurrentTasks: 1,
      agentSessionFactory: new FakeAgentSessionFactory(agentSession),
      taskResultVerifier: verifier,
    });

    await service.startTask({
      taskId: "task-1",
      repoPath: "/repo",
      prompt: "verified task",
    });

    await agentSession.exit("session-1", 0);

    expect(verifier.calls).toEqual([
      {
        task: expect.objectContaining({
          taskId: "task-1",
          state: "running",
          activeSessionId: "session-1",
        }),
        session: {
          sessionId: "session-1",
          taskId: "task-1",
          worktreePath: "/repo/.plato/worktrees/task-1",
          state: "verifying",
          exitCode: 0,
        },
      },
    ]);
    await expect(service.getTask("task-1")).resolves.toMatchObject({
      taskId: "task-1",
      state: "completed",
      activeSessionId: undefined,
    });
    await expect(service.listEvents("task-1")).resolves.toEqual([
      { taskId: "task-1", type: "task.queued" },
      {
        taskId: "task-1",
        type: "task.started",
        sessionId: "session-1",
        worktreePath: "/repo/.plato/worktrees/task-1",
      },
      {
        taskId: "task-1",
        type: "verification.started",
        sessionId: "session-1",
        worktreePath: "/repo/.plato/worktrees/task-1",
      },
      {
        taskId: "task-1",
        type: "verification.completed",
        sessionId: "session-1",
        worktreePath: "/repo/.plato/worktrees/task-1",
        verificationId: "verification-1",
        verificationStatus: "passed",
        errorCode: undefined,
        message: "verification passed",
      },
      {
        taskId: "task-1",
        type: "task.completed",
        sessionId: "session-1",
        worktreePath: "/repo/.plato/worktrees/task-1",
        exitCode: 0,
      },
    ]);
  });

  it("marks a task failed when post-run verification fails", async () => {
    const store = new InMemoryRunnerStore();
    const sessionStore = new InMemorySessionStore();
    const logStreamer = new InMemoryLogStreamer();
    const worktreeManager = new FakeWorktreeManager();
    const agentSession = new FakeAgentSession();
    const verifier = new FakeTaskResultVerifier();
    verifier.result = {
      verificationId: "verification-1",
      status: "failed",
      errorCode: "TESTS_FAILED",
      message: "unit tests failed",
    };
    const service = new CodexRunnerService({
      store,
      sessionStore,
      logStreamer,
      worktreeManager,
      maxConcurrentTasks: 1,
      agentSessionFactory: new FakeAgentSessionFactory(agentSession),
      taskResultVerifier: verifier,
    });

    await service.startTask({
      taskId: "task-1",
      repoPath: "/repo",
      prompt: "verified task",
    });

    await agentSession.exit("session-1", 0);

    await expect(service.getTask("task-1")).resolves.toMatchObject({
      taskId: "task-1",
      state: "failed",
      activeSessionId: undefined,
    });
    await expect(sessionStore.getSession("session-1")).resolves.toMatchObject({
      sessionId: "session-1",
      taskId: "task-1",
      state: "failed",
      exitCode: 0,
    });
    await expect(service.listEvents("task-1")).resolves.toEqual([
      { taskId: "task-1", type: "task.queued" },
      {
        taskId: "task-1",
        type: "task.started",
        sessionId: "session-1",
        worktreePath: "/repo/.plato/worktrees/task-1",
      },
      {
        taskId: "task-1",
        type: "verification.started",
        sessionId: "session-1",
        worktreePath: "/repo/.plato/worktrees/task-1",
      },
      {
        taskId: "task-1",
        type: "verification.failed",
        sessionId: "session-1",
        worktreePath: "/repo/.plato/worktrees/task-1",
        verificationId: "verification-1",
        verificationStatus: "failed",
        errorCode: "TESTS_FAILED",
        message: "unit tests failed",
      },
      {
        taskId: "task-1",
        type: "task.failed",
        sessionId: "session-1",
        worktreePath: "/repo/.plato/worktrees/task-1",
        exitCode: 0,
        errorCode: "TESTS_FAILED",
        message: "unit tests failed",
      },
    ]);
  });

  it("delegates interruption to the active agent session", async () => {
    const store = new InMemoryRunnerStore();
    const sessionStore = new InMemorySessionStore();
    const logStreamer = new InMemoryLogStreamer();
    const worktreeManager = new FakeWorktreeManager();
    const agentSession = new FakeAgentSession();
    const service = new CodexRunnerService({
      store,
      sessionStore,
      logStreamer,
      worktreeManager,
      maxConcurrentTasks: 1,
      agentSessionFactory: new FakeAgentSessionFactory(agentSession),
    });

    await service.startTask({
      taskId: "task-1",
      repoPath: "/repo",
      prompt: "interrupt me",
    });

    await service.interruptTask("task-1");

    expect(agentSession.interrupted).toEqual(["session-1"]);
    await expect(service.getTask("task-1")).resolves.toMatchObject({
      taskId: "task-1",
      state: "interrupted",
      activeSessionId: undefined,
    });
  });

  it("reconciles a running task with a missing active session to interrupted", async () => {
    const store = new InMemoryRunnerStore();
    const sessionStore = new InMemorySessionStore();
    const logStreamer = new InMemoryLogStreamer();
    const worktreeManager = new FakeWorktreeManager();
    const service = new CodexRunnerService({
      store,
      sessionStore,
      logStreamer,
      worktreeManager,
      maxConcurrentTasks: 1,
    });

    await store.saveTask({
      taskId: "task-1",
      repoPath: "/repo",
      prompt: "recover me",
      priority: 0,
      state: "running",
      worktreePath: "/repo/.plato/worktrees/task-1",
      activeSessionId: "session-missing",
    });

    const reconciled = await service.reconcileRunningTasks();

    expect(reconciled).toEqual([
      {
        taskId: "task-1",
        repoPath: "/repo",
        prompt: "recover me",
        priority: 0,
        state: "interrupted",
        worktreePath: "/repo/.plato/worktrees/task-1",
        activeSessionId: undefined,
      },
    ]);
    await expect(service.getTask("task-1")).resolves.toEqual(reconciled[0]);
    await expect(service.listEvents("task-1")).resolves.toEqual([
      {
        taskId: "task-1",
        type: "task.reconciled",
        sessionId: "session-missing",
        worktreePath: "/repo/.plato/worktrees/task-1",
        recoveredState: "interrupted",
        errorCode: "TASK_RECOVERY_SESSION_MISSING",
        message: "Recovered running task without a persisted active session",
      },
    ]);
  });

  it("reconciles a running task before returning task status", async () => {
    const store = new InMemoryRunnerStore();
    const sessionStore = new InMemorySessionStore();
    const logStreamer = new InMemoryLogStreamer();
    const worktreeManager = new FakeWorktreeManager();
    const agentSession = new FakeAgentSession();
    const service = new CodexRunnerService({
      store,
      sessionStore,
      logStreamer,
      worktreeManager,
      maxConcurrentTasks: 1,
      agentSessionFactory: new FakeAgentSessionFactory(agentSession),
    });

    await store.saveTask({
      taskId: "task-1",
      repoPath: "/repo",
      prompt: "recover me",
      priority: 1,
      state: "running",
      worktreePath: "/repo/.plato/worktrees/task-1",
      activeSessionId: "session-missing",
    });
    await store.saveTask({
      taskId: "task-2",
      repoPath: "/repo",
      prompt: "next task",
      priority: 0,
      state: "queued",
    });

    await expect(service.getTaskStatus("task-1")).resolves.toEqual({
      task: {
        taskId: "task-1",
        repoPath: "/repo",
        prompt: "recover me",
        priority: 1,
        state: "interrupted",
        worktreePath: "/repo/.plato/worktrees/task-1",
        activeSessionId: undefined,
      },
      sessions: [],
    });
    await expect(service.getTask("task-2")).resolves.toMatchObject({
      taskId: "task-2",
      state: "running",
      activeSessionId: "session-1",
      worktreePath: "/repo/.plato/worktrees/task-2",
    });
  });

  it("reconciles a running task with a terminal failed session to failed and schedules queued work", async () => {
    const store = new InMemoryRunnerStore();
    const sessionStore = new InMemorySessionStore();
    const logStreamer = new InMemoryLogStreamer();
    const worktreeManager = new FakeWorktreeManager();
    const agentSession = new FakeAgentSession();
    const service = new CodexRunnerService({
      store,
      sessionStore,
      logStreamer,
      worktreeManager,
      maxConcurrentTasks: 1,
      agentSessionFactory: new FakeAgentSessionFactory(agentSession),
    });

    await store.saveTask({
      taskId: "task-1",
      repoPath: "/repo",
      prompt: "recover me",
      priority: 1,
      state: "running",
      worktreePath: "/repo/.plato/worktrees/task-1",
      activeSessionId: "session-1",
    });
    await sessionStore.saveSession({
      sessionId: "session-1",
      taskId: "task-1",
      worktreePath: "/repo/.plato/worktrees/task-1",
      state: "failed",
      exitCode: 23,
    });
    await store.saveTask({
      taskId: "task-2",
      repoPath: "/repo",
      prompt: "next task",
      priority: 0,
      state: "queued",
    });

    const reconciled = await service.reconcileRunningTasks();

    expect(reconciled).toEqual([
      {
        taskId: "task-1",
        repoPath: "/repo",
        prompt: "recover me",
        priority: 1,
        state: "failed",
        worktreePath: "/repo/.plato/worktrees/task-1",
        activeSessionId: undefined,
      },
    ]);
    await expect(service.getTask("task-2")).resolves.toMatchObject({
      taskId: "task-2",
      state: "running",
      activeSessionId: "session-1",
      worktreePath: "/repo/.plato/worktrees/task-2",
    });
    await expect(service.listEvents("task-1")).resolves.toEqual([
      {
        taskId: "task-1",
        type: "task.reconciled",
        sessionId: "session-1",
        worktreePath: "/repo/.plato/worktrees/task-1",
        recoveredState: "failed",
        exitCode: 23,
        errorCode: "TASK_RECOVERY_SESSION_FAILED",
        message: "Recovered running task from failed session state",
      },
    ]);
  });

  it("reconciles a persisted running session to interrupted so queued work can continue", async () => {
    const store = new InMemoryRunnerStore();
    const sessionStore = new InMemorySessionStore();
    const logStreamer = new InMemoryLogStreamer();
    const worktreeManager = new FakeWorktreeManager();
    const agentSession = new FakeAgentSession();
    const service = new CodexRunnerService({
      store,
      sessionStore,
      logStreamer,
      worktreeManager,
      maxConcurrentTasks: 1,
      agentSessionFactory: new FakeAgentSessionFactory(agentSession),
    });

    await store.saveTask({
      taskId: "task-1",
      repoPath: "/repo",
      prompt: "recover me",
      priority: 1,
      state: "running",
      worktreePath: "/repo/.plato/worktrees/task-1",
      activeSessionId: "session-1",
    });
    await sessionStore.saveSession({
      sessionId: "session-1",
      taskId: "task-1",
      worktreePath: "/repo/.plato/worktrees/task-1",
      state: "running",
      pid: 42,
    });
    await store.saveTask({
      taskId: "task-2",
      repoPath: "/repo",
      prompt: "next task",
      priority: 0,
      state: "queued",
    });

    const reconciled = await service.reconcileRunningTasks();

    expect(reconciled).toEqual([
      {
        taskId: "task-1",
        repoPath: "/repo",
        prompt: "recover me",
        priority: 1,
        state: "interrupted",
        worktreePath: "/repo/.plato/worktrees/task-1",
        activeSessionId: undefined,
      },
    ]);
    await expect(service.getTask("task-2")).resolves.toMatchObject({
      taskId: "task-2",
      state: "running",
      activeSessionId: "session-1",
      worktreePath: "/repo/.plato/worktrees/task-2",
    });
    await expect(service.listEvents("task-1")).resolves.toEqual([
      {
        taskId: "task-1",
        type: "task.reconciled",
        sessionId: "session-1",
        worktreePath: "/repo/.plato/worktrees/task-1",
        recoveredState: "interrupted",
        errorCode: "TASK_RECOVERY_SESSION_ORPHANED",
        message: "Recovered running task from a persisted running session after startup",
      },
    ]);
  });

  it("keeps the session in verifying until post-run verification finishes", async () => {
    const store = new InMemoryRunnerStore();
    const sessionStore = new InMemorySessionStore();
    const logStreamer = new InMemoryLogStreamer();
    const worktreeManager = new FakeWorktreeManager();
    const agentSession = new FakeAgentSession();
    let resolveVerification: ((result: TaskVerificationResult) => void) | undefined;
    const verifier: TaskResultVerifier = {
      verify: async (context) => {
        const checkpoint = await sessionStore.getSession(context.session.sessionId);
        expect(checkpoint).toMatchObject({
          sessionId: "session-1",
          taskId: "task-1",
          state: "verifying",
          exitCode: 0,
        });

        return new Promise<TaskVerificationResult>((resolve) => {
          resolveVerification = resolve;
        });
      },
    };
    const service = new CodexRunnerService({
      store,
      sessionStore,
      logStreamer,
      worktreeManager,
      maxConcurrentTasks: 1,
      agentSessionFactory: new FakeAgentSessionFactory(agentSession),
      taskResultVerifier: verifier,
    });

    await service.startTask({
      taskId: "task-1",
      repoPath: "/repo",
      prompt: "verified task",
    });

    const exitPromise = agentSession.exit("session-1", 0);
    await Promise.resolve();

    await expect(sessionStore.getSession("session-1")).resolves.toMatchObject({
      sessionId: "session-1",
      taskId: "task-1",
      state: "verifying",
      exitCode: 0,
    });
    await expect(service.getTask("task-1")).resolves.toMatchObject({
      taskId: "task-1",
      state: "running",
      activeSessionId: "session-1",
    });

    resolveVerification?.({
      verificationId: "verification-1",
      status: "passed",
      message: "verification passed",
    });
    await exitPromise;

    await expect(sessionStore.getSession("session-1")).resolves.toMatchObject({
      sessionId: "session-1",
      taskId: "task-1",
      state: "completed",
      exitCode: 0,
    });
    await expect(service.getTask("task-1")).resolves.toMatchObject({
      taskId: "task-1",
      state: "completed",
      activeSessionId: undefined,
    });
  });

  it("reconciles a running task in verification by finishing verification instead of force-failing it", async () => {
    const store = new InMemoryRunnerStore();
    const sessionStore = new InMemorySessionStore();
    const logStreamer = new InMemoryLogStreamer();
    const worktreeManager = new FakeWorktreeManager();
    const verifier = new FakeTaskResultVerifier();
    const service = new CodexRunnerService({
      store,
      sessionStore,
      logStreamer,
      worktreeManager,
      maxConcurrentTasks: 1,
      taskResultVerifier: verifier,
    });

    await store.saveTask({
      taskId: "task-1",
      repoPath: "/repo",
      prompt: "recover me",
      priority: 0,
      state: "running",
      worktreePath: "/repo/.plato/worktrees/task-1",
      activeSessionId: "session-1",
    });
    await sessionStore.saveSession({
      sessionId: "session-1",
      taskId: "task-1",
      worktreePath: "/repo/.plato/worktrees/task-1",
      state: "verifying",
      exitCode: 0,
    });

    const reconciled = await service.reconcileRunningTasks();

    expect(reconciled).toEqual([
      {
        taskId: "task-1",
        repoPath: "/repo",
        prompt: "recover me",
        priority: 0,
        state: "completed",
        worktreePath: "/repo/.plato/worktrees/task-1",
        activeSessionId: undefined,
      },
    ]);
    expect(verifier.calls).toEqual([
      {
        task: expect.objectContaining({
          taskId: "task-1",
          state: "running",
          activeSessionId: "session-1",
        }),
        session: {
          sessionId: "session-1",
          taskId: "task-1",
          worktreePath: "/repo/.plato/worktrees/task-1",
          state: "verifying",
          exitCode: 0,
        },
      },
    ]);
    await expect(sessionStore.getSession("session-1")).resolves.toMatchObject({
      sessionId: "session-1",
      taskId: "task-1",
      state: "completed",
      exitCode: 0,
    });
    await expect(service.listEvents("task-1")).resolves.toEqual([
      {
        taskId: "task-1",
        type: "verification.started",
        sessionId: "session-1",
        worktreePath: "/repo/.plato/worktrees/task-1",
      },
      {
        taskId: "task-1",
        type: "verification.completed",
        sessionId: "session-1",
        worktreePath: "/repo/.plato/worktrees/task-1",
        verificationId: "verification-1",
        verificationStatus: "passed",
        errorCode: undefined,
        message: "verification passed",
      },
      {
        taskId: "task-1",
        type: "task.reconciled",
        sessionId: "session-1",
        worktreePath: "/repo/.plato/worktrees/task-1",
        recoveredState: "completed",
        errorCode: "TASK_RECOVERY_SESSION_VERIFICATION_COMPLETED",
        message: "Recovered running task by completing post-run verification",
        exitCode: 0,
      },
    ]);
  });
});
