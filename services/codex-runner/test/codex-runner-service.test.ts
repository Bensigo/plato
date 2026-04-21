import { describe, expect, it } from "vitest";

import { CodexRunnerService } from "../src/codex-runner-service.js";
import {
  WorktreeProvisioningError,
  type LogStreamer,
  ManagedSession,
  ProcessPool,
  RunnerStore,
  RunnerTaskRecord,
  RunnerTaskState,
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
    this.#activeSessions += 1;
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
    if (this.#activeSessions > 0) {
      this.#activeSessions -= 1;
    }
  }
}

describe("CodexRunnerService", () => {
  it("starts a task immediately when process capacity is available", async () => {
    const store = new InMemoryRunnerStore();
    const logStreamer = new InMemoryLogStreamer();
    const worktreeManager = new FakeWorktreeManager();
    const processPool = new FakeProcessPool(1);
    const service = new CodexRunnerService({
      store,
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
        type: "task.started",
        sessionId: "session-1",
        worktreePath: "/repo/.plato/worktrees/task-1",
      },
    ]);
  });

  it("leaves later tasks queued when the pool is full", async () => {
    const store = new InMemoryRunnerStore();
    const logStreamer = new InMemoryLogStreamer();
    const worktreeManager = new FakeWorktreeManager();
    const processPool = new FakeProcessPool(1);
    const service = new CodexRunnerService({
      store,
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
    const logStreamer = new InMemoryLogStreamer();
    const worktreeManager = new FakeWorktreeManager();
    const processPool = new FakeProcessPool(1);
    const service = new CodexRunnerService({
      store,
      logStreamer,
      worktreeManager,
      processPool,
    });

    await service.startTask({
      taskId: "task-1",
      repoPath: "/repo",
      prompt: "first",
    });

    await service.interruptTask("task-1");
    const resumed = await service.resumeTask("task-1");

    expect(processPool.interrupted).toEqual(["session-1"]);
    expect(processPool.spawns).toHaveLength(2);
    expect(resumed.state).toBe("running");
    expect(resumed.worktreePath).toBe("/repo/.plato/worktrees/task-1");
    expect(resumed.activeSessionId).toBe("session-2");
    expect(worktreeManager.allocations).toHaveLength(1);

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
});
