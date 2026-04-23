import { afterEach, describe, expect, it } from "vitest";

import type { RunnerSessionRecord } from "../src/contracts.js";
import { openCodexRunnerPersistence } from "../src/store/sqlite-runner-persistence.js";
import { cleanupDir, createTempDir } from "./helpers/git.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(cleanupDir));
});

function buildSession(
  sessionId: string,
  taskId: string,
  state: RunnerSessionRecord["state"],
): RunnerSessionRecord {
  return {
    sessionId,
    taskId,
    worktreePath: `/repo/.plato/worktrees/${taskId}`,
    pid: 12,
    state,
  };
}

describe("SqliteSessionStore", () => {
  it("persists sessions across store instances", async () => {
    const tempDir = await createTempDir("codex-session-store-");
    tempDirs.push(tempDir);
    const filePath = `${tempDir}/runner.sqlite`;

    const firstPersistence = openCodexRunnerPersistence({ filePath });
    await firstPersistence.store.saveTask({
      taskId: "task-1",
      repoPath: "/repo",
      prompt: "prompt",
      priority: 0,
      state: "queued",
    });
    await firstPersistence.sessionStore.saveSession(buildSession("session-1", "task-1", "running"));
    firstPersistence.close();

    const secondPersistence = openCodexRunnerPersistence({ filePath });
    await expect(secondPersistence.sessionStore.getSession("session-1")).resolves.toEqual(
      buildSession("session-1", "task-1", "running"),
    );
    secondPersistence.close();
  });

  it("updates an existing session instead of duplicating it", async () => {
    const tempDir = await createTempDir("codex-session-store-");
    tempDirs.push(tempDir);
    const persistence = openCodexRunnerPersistence({
      filePath: `${tempDir}/runner.sqlite`,
    });

    await persistence.store.saveTask({
      taskId: "task-1",
      repoPath: "/repo",
      prompt: "prompt",
      priority: 0,
      state: "queued",
    });
    await persistence.sessionStore.saveSession(buildSession("session-1", "task-1", "running"));
    await persistence.sessionStore.saveSession({
      ...buildSession("session-1", "task-1", "completed"),
      exitCode: 0,
    });

    await expect(persistence.sessionStore.listSessionsByTask("task-1")).resolves.toEqual([
      {
        ...buildSession("session-1", "task-1", "completed"),
        exitCode: 0,
      },
    ]);

    const row = persistence.database.connection
      .prepare("SELECT COUNT(*) AS count FROM runner_sessions WHERE session_id = ?")
      .get("session-1") as { count: number };

    expect(row.count).toBe(1);
    persistence.close();
  });

  it("lists sessions by task", async () => {
    const tempDir = await createTempDir("codex-session-store-");
    tempDirs.push(tempDir);
    const persistence = openCodexRunnerPersistence({
      filePath: `${tempDir}/runner.sqlite`,
    });

    await persistence.store.saveTask({
      taskId: "task-1",
      repoPath: "/repo",
      prompt: "prompt",
      priority: 0,
      state: "queued",
    });
    await persistence.store.saveTask({
      taskId: "task-2",
      repoPath: "/repo",
      prompt: "prompt",
      priority: 0,
      state: "queued",
    });
    await persistence.sessionStore.saveSession(buildSession("session-1", "task-1", "running"));
    await persistence.sessionStore.saveSession({
      ...buildSession("session-2", "task-1", "completed"),
      exitCode: 0,
    });
    await persistence.sessionStore.saveSession(buildSession("session-3", "task-2", "running"));

    await expect(persistence.sessionStore.listSessionsByTask("task-1")).resolves.toEqual([
      buildSession("session-1", "task-1", "running"),
      {
        ...buildSession("session-2", "task-1", "completed"),
        exitCode: 0,
      },
    ]);
    persistence.close();
  });
});
