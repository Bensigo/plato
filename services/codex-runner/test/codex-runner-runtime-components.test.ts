import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";

import { CodexRunnerService } from "../src/codex-runner-service.js";
import type { SessionEvent } from "../src/contracts.js";
import { FileLogStreamer } from "../src/logs/file-log-streamer.js";
import { LocalProcessPool } from "../src/process/local-process-pool.js";
import { createCodexAppServerCommand } from "../src/session/codex-app-server-command.js";
import { ProcessBackedAgentSessionFactory } from "../src/session/process-backed-agent-session.js";
import { FileRunnerStore } from "../src/store/file-runner-store.js";
import { FileSessionStore } from "../src/store/file-session-store.js";
import { GitWorktreeManager } from "../src/worktree/git-worktree-manager.js";
import { cleanupDir, createGitRepo, createTempDir } from "./helpers/git.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(cleanupDir));
});

describe("CodexRunnerService with runtime components", () => {
  it("writes session and task events through the file log streamer while using the local process pool", async () => {
    const repoPath = await createGitRepo();
    const storeDir = await createTempDir("codex-runner-runtime-store-");
    tempDirs.push(repoPath, storeDir);

    const processPool = new LocalProcessPool({
      maxConcurrent: 1,
      createCommand: () => ({
        command: process.execPath,
        args: [
          "-e",
          'console.log("session-ready"); console.error("stderr-line"); setTimeout(() => process.exit(0), 25)',
        ],
      }),
    });
    const logStreamer = new FileLogStreamer(join(storeDir, "runner-events.json"));
    const service = new CodexRunnerService({
      store: new FileRunnerStore(join(storeDir, "runner-store.json")),
      sessionStore: new FileSessionStore(join(storeDir, "runner-sessions.json")),
      worktreeManager: new GitWorktreeManager(),
      processPool,
      logStreamer,
      agentSessionFactory: new ProcessBackedAgentSessionFactory(processPool),
    });

    const task = await service.startTask({
      taskId: "task-1",
      repoPath,
      prompt: "Run with real runtime components",
    });

    expect(task.state).toBe("running");
    await new Promise((resolve) => setTimeout(resolve, 100));

    await expect(service.listEvents("task-1")).resolves.toSatisfy((events) => {
      expect(events.length).toBeGreaterThanOrEqual(6);
      expect(events[0]).toEqual({ taskId: "task-1", type: "task.queued" });
      expect(events[1]).toMatchObject({
        taskId: "task-1",
        type: "session.started",
        worktreePath: `${repoPath}/.plato/worktrees/task-1`,
      });
      expect(events[1]?.sessionId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(events[2]).toMatchObject({
        taskId: "task-1",
        type: "task.started",
        worktreePath: `${repoPath}/.plato/worktrees/task-1`,
      });
      expect(
        events.some((event: SessionEvent) => event.type === "session.output" && event.message === "session-ready"),
      ).toBe(true);
      expect(
        events.some((event: SessionEvent) => event.type === "session.output" && event.stream === "stderr"),
      ).toBe(true);
      expect(events.some((event: SessionEvent) => event.type === "session.exited")).toBe(true);
      expect(events.some((event: SessionEvent) => event.type === "task.completed")).toBe(true);
      return true;
    });
  });

  it("builds the default codex app-server command for a task worktree", () => {
    const command = createCodexAppServerCommand(
      {
        taskId: "task-1",
        repoPath: "/repo",
        prompt: "Run codex",
        priority: 1,
        state: "queued",
      },
      {
        taskId: "task-1",
        repoPath: "/repo",
        branchName: "plato/task-task-1",
        worktreePath: "/repo/.plato/worktrees/task-1",
      },
    );

    expect(command.command).toBe("codex");
    expect(command.args).toEqual(["app-server", "--listen", "stdio://"]);
    expect(command.cwd).toBe("/repo/.plato/worktrees/task-1");
    expect(command.env?.PLATO_TASK_ID).toBe("task-1");
  });
});
