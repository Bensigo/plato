import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";

import { CodexRunnerService } from "../src/codex-runner-service.js";
import type {
  AgentSession,
  AgentSessionFactory,
  LogStreamer,
  ManagedSession,
  RunnerSessionRecord,
  RunnerTaskRecord,
  SessionEvent,
  SessionStore,
  WorktreeAllocation,
} from "../src/contracts.js";
import { FileRunnerStore } from "../src/store/file-runner-store.js";
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
  it("starts a task with the file store and git worktree manager", async () => {
    const repoPath = await createGitRepo();
    const storeDir = await createTempDir("codex-runner-store-");
    tempDirs.push(repoPath, storeDir);

    const service = new CodexRunnerService({
      store: new FileRunnerStore(join(storeDir, "runner-store.json")),
      sessionStore: new InMemorySessionStore(),
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
  });
});
