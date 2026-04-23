import { describe, expect, it } from "vitest";

import { CodexRunnerService } from "../src/codex-runner-service.js";
import {
  type AgentSession,
  type AgentSessionFactory,
  type CodexRuntimeManager,
  WorktreeProvisioningError,
  type LogStreamer,
  ManagedSession,
  type PendingApprovalRecord,
  RunnerStore,
  type RunnerSessionRecord,
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
});
