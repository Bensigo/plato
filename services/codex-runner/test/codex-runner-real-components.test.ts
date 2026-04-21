import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";

import { CodexRunnerService } from "../src/codex-runner-service.js";
import type {
  LogStreamer,
  ManagedSession,
  ProcessPool,
  SessionEvent,
  WorktreeAllocation,
  RunnerTaskRecord,
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

class FakeProcessPool implements ProcessPool {
  readonly spawns: ManagedSession[] = [];
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

  async interrupt(): Promise<void> {
    if (this.#activeSessions > 0) {
      this.#activeSessions -= 1;
    }
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
      worktreeManager: new GitWorktreeManager(),
      processPool: new FakeProcessPool(1),
      logStreamer: new InMemoryLogStreamer(),
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
