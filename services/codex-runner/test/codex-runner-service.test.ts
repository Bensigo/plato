import { describe, expect, it } from "vitest";

import { CodexRunnerService } from "../src/codex-runner-service.js";
import {
  type AgentSession,
  type AgentSessionFactory,
  type CodexRuntimeManager,
  WorktreeProvisioningError,
  type LogStreamer,
  ManagedSession,
  ProcessPool,
  RunnerStore,
  type RunnerSessionRecord,
  type RunnerSessionState,
  RunnerTaskRecord,
  RunnerTaskState,
  SessionStore,
  SessionEvent,
  WorktreeAllocation,
  WorktreeManager,
} from "../src/contracts.js";

class InMemoryRunnerStore implements RunnerStore {
  readonly #tasks = new Map<string, RunnerTaskRecord>();

  async saveTask(task: RunnerTaskRecord): Promise<void> {
    this.#tasks.set(task.taskId, task);
  }

  async getTask(taskId: string): Promise<RunnerTaskRecord | undefined> {
    return this.#tasks.get(taskId);
  }

  async listTasksByState(state: RunnerTaskState): Promise<RunnerTaskRecord[]> {
    return [...this.#tasks.values()].filter((task) => task.state === state);
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

class FakeProcessPool implements ProcessPool {
  readonly spawns: ManagedSession[] = [];
  readonly interrupted: string[] = [];
  #activeSessions = 0;

  constructor(private readonly capacity: number) {}

  hasCapacity(): boolean {
    return this.#activeSessions < this.capacity;
  }

  async spawn(task: RunnerTaskRecord, worktree: WorktreeAllocation): Promise<ManagedSession> {
    this.reserve();
    const session = {
      sessionId: `session-${this.spawns.length + 1}`,
      taskId: task.taskId,
      worktreePath: worktree.worktreePath,
    };
    this.spawns.push(session);
    return session;
  }

  async attach(): Promise<void> {}

  async interrupt(sessionId: string): Promise<void> {
    this.interrupted.push(sessionId);
    this.release();
  }

  reserve(): void {
    this.#activeSessions += 1;
  }

  release(): void {
    if (this.#activeSessions > 0) {
      this.#activeSessions -= 1;
    }
  }
}

class FakeRuntimeManager implements CodexRuntimeManager {
  readonly calls: string[] = [];
  failure?: Error;

  async ensureReady(task: RunnerTaskRecord): Promise<void> {
    this.calls.push(task.taskId);
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
  readonly #exitHandlers = new Map<string, (exitCode: number | null) => Promise<void> | void>();

  constructor(private readonly processPool: FakeProcessPool) {}

  async start(
    task: RunnerTaskRecord,
    worktree: WorktreeAllocation,
    handlers?: { onExit?: (exitCode: number | null) => Promise<void> | void },
  ): Promise<ManagedSession> {
    const sessionId = `session-${this.started.length + 1}`;
    this.processPool.reserve();
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
    this.processPool.release();
    await this.#exitHandlers.get(sessionId)?.(exitCode);
  }
}

class FakeAgentSessionFactory implements AgentSessionFactory {
  constructor(readonly session: FakeAgentSession) {}

  create(): AgentSession {
    return this.session;
  }
}

describe("CodexRunnerService", () => {
  it("starts a task immediately when process capacity is available", async () => {
    const store = new InMemoryRunnerStore();
    const sessionStore = new InMemorySessionStore();
    const logStreamer = new InMemoryLogStreamer();
    const worktreeManager = new FakeWorktreeManager();
    const processPool = new FakeProcessPool(1);
    const service = new CodexRunnerService({
      store,
      sessionStore,
      logStreamer,
      worktreeManager,
      processPool,
    });

    const task = await service.startTask({
      taskId: "task-1",
      repoPath: "/repo",
      prompt: "Implement the runner",
    });

    expect(task.state).toBe("running");
    expect(task.worktreePath).toBe("/repo/.plato/worktrees/task-1");
    expect(processPool.spawns).toHaveLength(1);
    expect(worktreeManager.allocations).toHaveLength(1);

    await expect(service.listEvents("task-1")).resolves.toEqual([
      { taskId: "task-1", type: "task.queued" },
      {
        taskId: "task-1",
        type: "session.started",
        sessionId: "session-1",
        worktreePath: "/repo/.plato/worktrees/task-1",
        pid: undefined,
      },
      {
        taskId: "task-1",
        type: "task.started",
        sessionId: "session-1",
        worktreePath: "/repo/.plato/worktrees/task-1",
      },
    ]);
  });

  it("fails the task when codex runtime bootstrap fails", async () => {
    const store = new InMemoryRunnerStore();
    const sessionStore = new InMemorySessionStore();
    const logStreamer = new InMemoryLogStreamer();
    const worktreeManager = new FakeWorktreeManager();
    const processPool = new FakeProcessPool(1);
    const runtimeManager = new FakeRuntimeManager();
    runtimeManager.failure = new Error("codex install failed");
    const service = new CodexRunnerService({
      store,
      sessionStore,
      logStreamer,
      worktreeManager,
      processPool,
      runtimeManager,
    });

    const task = await service.startTask({
      taskId: "task-1",
      repoPath: "/repo",
      prompt: "Implement the runner",
    });

    expect(runtimeManager.calls).toEqual(["task-1"]);
    expect(task.state).toBe("failed");
    expect(processPool.spawns).toHaveLength(0);
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

  it("leaves later tasks queued when the pool is full", async () => {
    const store = new InMemoryRunnerStore();
    const sessionStore = new InMemorySessionStore();
    const logStreamer = new InMemoryLogStreamer();
    const worktreeManager = new FakeWorktreeManager();
    const processPool = new FakeProcessPool(1);
    const service = new CodexRunnerService({
      store,
      sessionStore,
      logStreamer,
      worktreeManager,
      processPool,
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
    expect(processPool.spawns).toHaveLength(1);
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
    const processPool = new FakeProcessPool(1);
    const service = new CodexRunnerService({
      store,
      sessionStore,
      logStreamer,
      worktreeManager,
      processPool,
    });

    const task = await service.startTask({
      taskId: "task-1",
      repoPath: "/repo",
      prompt: "Implement the runner",
    });

    expect(task.state).toBe("failed");
    expect(task.worktreePath).toBeUndefined();
    expect(processPool.spawns).toHaveLength(0);

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
    const processPool = new FakeProcessPool(1);
    const agentSession = new FakeAgentSession(processPool);
    const service = new CodexRunnerService({
      store,
      sessionStore,
      logStreamer,
      worktreeManager,
      processPool,
      agentSessionFactory: new FakeAgentSessionFactory(agentSession),
    });

    await service.startTask({
      taskId: "task-1",
      repoPath: "/repo",
      prompt: "first",
    });

    await service.interruptTask("task-1");
    const resumed = await service.resumeTask("task-1");

    expect(processPool.interrupted).toEqual(["session-1"]);
    expect(processPool.spawns).toHaveLength(0);
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
    const processPool = new FakeProcessPool(1);
    const agentSession = new FakeAgentSession(processPool);
    const service = new CodexRunnerService({
      store,
      sessionStore,
      logStreamer,
      worktreeManager,
      processPool,
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

  it("marks a task failed when the session exits with a non-zero code", async () => {
    const store = new InMemoryRunnerStore();
    const sessionStore = new InMemorySessionStore();
    const logStreamer = new InMemoryLogStreamer();
    const worktreeManager = new FakeWorktreeManager();
    const processPool = new FakeProcessPool(1);
    const agentSession = new FakeAgentSession(processPool);
    const service = new CodexRunnerService({
      store,
      sessionStore,
      logStreamer,
      worktreeManager,
      processPool,
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
});
