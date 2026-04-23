import { afterEach, describe, expect, it } from "vitest";

import { CodexRunnerService } from "../src/codex-runner-service.js";
import type {
  AgentSession,
  AgentSessionFactory,
  LogStreamer,
  ManagedSession,
  RunnerTaskRecord,
  SessionEvent,
  WorktreeAllocation,
  WorktreeManager,
} from "../src/contracts.js";
import { openCodexRunnerPersistence } from "../src/store/sqlite-runner-persistence.js";
import { cleanupDir, createTempDir } from "./helpers/git.js";

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

  async createWorktree(taskId: string, repoPath: string): Promise<WorktreeAllocation> {
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

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(cleanupDir));
});

describe("CodexRunnerService with SQLite-backed stores", () => {
  it("persists a child task decomposition and lists subtasks through SQLite stores", async () => {
    const tempDir = await createTempDir("codex-runner-sqlite-");
    tempDirs.push(tempDir);
    const persistence = openCodexRunnerPersistence({
      filePath: `${tempDir}/runner.sqlite`,
    });
    const agentSession = new FakeAgentSession();
    const service = new CodexRunnerService({
      store: persistence.store,
      sessionStore: persistence.sessionStore,
      logStreamer: new InMemoryLogStreamer(),
      worktreeManager: new FakeWorktreeManager(),
      maxConcurrentTasks: 0,
      agentSessionFactory: new FakeAgentSessionFactory(agentSession),
    });

    await service.startTask({
      taskId: "task-parent",
      repoPath: "/repo",
      prompt: "Parent task",
    });
    await service.startTask({
      taskId: "task-child",
      repoPath: "/repo",
      prompt: "Child task",
      decomposition: {
        kind: "subtask",
        parentTaskId: "task-parent",
      },
    });

    await expect(service.getTask("task-child")).resolves.toMatchObject({
      taskId: "task-child",
      state: "queued",
      decomposition: {
        kind: "subtask",
        parentTaskId: "task-parent",
      },
    });
    await expect(service.listSubtasks("task-parent")).resolves.toEqual([
      expect.objectContaining({
        taskId: "task-child",
        decomposition: {
          kind: "subtask",
          parentTaskId: "task-parent",
        },
      }),
    ]);
    persistence.close();
  });

  it("completes a task and persists the terminal session state", async () => {
    const tempDir = await createTempDir("codex-runner-sqlite-");
    tempDirs.push(tempDir);
    const persistence = openCodexRunnerPersistence({
      filePath: `${tempDir}/runner.sqlite`,
    });
    const agentSession = new FakeAgentSession();
    const service = new CodexRunnerService({
      store: persistence.store,
      sessionStore: persistence.sessionStore,
      logStreamer: new InMemoryLogStreamer(),
      worktreeManager: new FakeWorktreeManager(),
      agentSessionFactory: new FakeAgentSessionFactory(agentSession),
    });

    await service.startTask({
      taskId: "task-1",
      repoPath: "/repo",
      prompt: "complete it",
    });
    await agentSession.exit("session-1", 0);

    await expect(service.getTask("task-1")).resolves.toMatchObject({
      taskId: "task-1",
      state: "completed",
      activeSessionId: undefined,
    });
    await expect(persistence.sessionStore.getSession("session-1")).resolves.toMatchObject({
      sessionId: "session-1",
      taskId: "task-1",
      state: "completed",
      exitCode: 0,
    });
    persistence.close();
  });

  it("interrupts a task and preserves the interrupted session state", async () => {
    const tempDir = await createTempDir("codex-runner-sqlite-");
    tempDirs.push(tempDir);
    const persistence = openCodexRunnerPersistence({
      filePath: `${tempDir}/runner.sqlite`,
    });
    const agentSession = new FakeAgentSession();
    const service = new CodexRunnerService({
      store: persistence.store,
      sessionStore: persistence.sessionStore,
      logStreamer: new InMemoryLogStreamer(),
      worktreeManager: new FakeWorktreeManager(),
      agentSessionFactory: new FakeAgentSessionFactory(agentSession),
    });

    await service.startTask({
      taskId: "task-1",
      repoPath: "/repo",
      prompt: "interrupt it",
    });
    await service.interruptTask("task-1");

    expect(agentSession.interrupted).toEqual(["session-1"]);
    await expect(service.getTask("task-1")).resolves.toMatchObject({
      taskId: "task-1",
      state: "interrupted",
      activeSessionId: undefined,
      worktreePath: "/repo/.plato/worktrees/task-1",
    });
    await expect(persistence.sessionStore.getSession("session-1")).resolves.toMatchObject({
      sessionId: "session-1",
      taskId: "task-1",
      state: "interrupted",
      worktreePath: "/repo/.plato/worktrees/task-1",
    });
    persistence.close();
  });

  it("resumes a task and records a new session attempt in the same worktree", async () => {
    const tempDir = await createTempDir("codex-runner-sqlite-");
    tempDirs.push(tempDir);
    const persistence = openCodexRunnerPersistence({
      filePath: `${tempDir}/runner.sqlite`,
    });
    const agentSession = new FakeAgentSession();
    const service = new CodexRunnerService({
      store: persistence.store,
      sessionStore: persistence.sessionStore,
      logStreamer: new InMemoryLogStreamer(),
      worktreeManager: new FakeWorktreeManager(),
      agentSessionFactory: new FakeAgentSessionFactory(agentSession),
    });

    await service.startTask({
      taskId: "task-1",
      repoPath: "/repo",
      prompt: "resume it",
    });
    await service.interruptTask("task-1");
    const resumed = await service.resumeTask("task-1");

    expect(resumed.state).toBe("running");
    expect(resumed.worktreePath).toBe("/repo/.plato/worktrees/task-1");
    expect(resumed.activeSessionId).toBe("session-2");
    await expect(persistence.sessionStore.listSessionsByTask("task-1")).resolves.toEqual([
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
        pid: 2,
        state: "running",
      },
    ]);
    persistence.close();
  });
});
