import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";

import { CodexRunnerService } from "../src/codex-runner-service.js";
import { FileLogStreamer } from "../src/logs/file-log-streamer.js";
import { LocalProcessPool } from "../src/process/local-process-pool.js";
import { FileRunnerStore } from "../src/store/file-runner-store.js";
import { GitWorktreeManager } from "../src/worktree/git-worktree-manager.js";
import { cleanupDir, createGitRepo, createTempDir } from "./helpers/git.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(cleanupDir));
});

describe("CodexRunnerService with runtime components", () => {
  it("writes task events through the file log streamer while using the local process pool", async () => {
    const repoPath = await createGitRepo();
    const storeDir = await createTempDir("codex-runner-runtime-store-");
    tempDirs.push(repoPath, storeDir);

    const service = new CodexRunnerService({
      store: new FileRunnerStore(join(storeDir, "runner-store.json")),
      worktreeManager: new GitWorktreeManager(),
      processPool: new LocalProcessPool({
        maxConcurrent: 1,
        createCommand: () => ({
          command: process.execPath,
          args: ["-e", "setTimeout(() => process.exit(0), 25)"],
        }),
      }),
      logStreamer: new FileLogStreamer(join(storeDir, "runner-events.json")),
    });

    const task = await service.startTask({
      taskId: "task-1",
      repoPath,
      prompt: "Run with real runtime components",
    });

    expect(task.state).toBe("running");
    await expect(service.listEvents("task-1")).resolves.toEqual([
      { taskId: "task-1", type: "task.queued" },
      {
        taskId: "task-1",
        type: "task.started",
        sessionId: "session-1",
        worktreePath: `${repoPath}/.plato/worktrees/task-1`,
      },
    ]);
  });
});
