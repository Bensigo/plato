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
} from "../src/contracts.js";
import { openCodexRunnerPersistence } from "../src/store/sqlite-runner-persistence.js";
import { GitWorktreeManager } from "../src/worktree/git-worktree-manager.js";
import { cleanupDir, createGitRepo, createTempDir } from "./helpers/git.js";

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

class FakeAgentSession implements AgentSession {
  async start(task: RunnerTaskRecord, worktree: WorktreeAllocation): Promise<ManagedSession> {
    return {
      sessionId: "session-1",
      taskId: task.taskId,
      worktreePath: worktree.worktreePath,
    };
  }

  async interrupt(): Promise<void> {}
}

class FakeAgentSessionFactory implements AgentSessionFactory {
  create(): AgentSession {
    return new FakeAgentSession();
  }
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(cleanupDir));
});

describe("CodexRunnerService with real components", () => {
  it("starts a task with SQLite-backed stores and the git worktree manager", async () => {
    const repoPath = await createGitRepo();
    const storeDir = await createTempDir("codex-runner-store-");
    tempDirs.push(repoPath, storeDir);
    const persistence = openCodexRunnerPersistence({
      filePath: `${storeDir}/runner.sqlite`,
    });

    const service = new CodexRunnerService({
      store: persistence.store,
      sessionStore: persistence.sessionStore,
      worktreeManager: new GitWorktreeManager(),
      logStreamer: new InMemoryLogStreamer(),
      agentSessionFactory: new FakeAgentSessionFactory(),
    });

    const task = await service.startTask({
      taskId: "task-1",
      repoPath,
      prompt: "Implement persistence",
    });

    expect(task.state).toBe("running");
    expect(task.worktreePath).toBe(`${repoPath}/.plato/worktrees/task-1`);
    await expect(service.getTask("task-1")).resolves.toMatchObject({
      taskId: "task-1",
      state: "running",
      worktreePath: `${repoPath}/.plato/worktrees/task-1`,
    });
    await expect(persistence.sessionStore.listSessionsByTask("task-1")).resolves.toEqual([
      {
        sessionId: "session-1",
        taskId: "task-1",
        state: "running",
        worktreePath: `${repoPath}/.plato/worktrees/task-1`,
      },
    ]);
    persistence.close();
  });
});
