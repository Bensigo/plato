import { afterEach, describe, expect, it } from "vitest";

import type { RunnerTaskRecord } from "../src/contracts.js";
import { openCodexRunnerPersistence } from "../src/store/sqlite-runner-persistence.js";
import { cleanupDir, createTempDir } from "./helpers/git.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(cleanupDir));
});

function buildTask(taskId: string, state: RunnerTaskRecord["state"]): RunnerTaskRecord {
  return {
    taskId,
    repoPath: "/repo",
    prompt: `prompt-${taskId}`,
    priority: 1,
    state,
  };
}

describe("SqliteRunnerStore", () => {
  it("persists tasks across store instances", async () => {
    const tempDir = await createTempDir("codex-runner-store-");
    tempDirs.push(tempDir);
    const filePath = `${tempDir}/runner.sqlite`;

    const firstPersistence = openCodexRunnerPersistence({ filePath });
    await firstPersistence.store.saveTask(buildTask("task-1", "queued"));
    firstPersistence.close();

    const secondPersistence = openCodexRunnerPersistence({ filePath });
    await expect(secondPersistence.store.getTask("task-1")).resolves.toEqual(
      buildTask("task-1", "queued"),
    );
    secondPersistence.close();
  });

  it("updates an existing task instead of duplicating it", async () => {
    const tempDir = await createTempDir("codex-runner-store-");
    tempDirs.push(tempDir);
    const persistence = openCodexRunnerPersistence({
      filePath: `${tempDir}/runner.sqlite`,
    });

    await persistence.store.saveTask(buildTask("task-1", "queued"));
    await persistence.store.saveTask(buildTask("task-1", "running"));

    await expect(persistence.store.listTasksByState("running")).resolves.toEqual([
      buildTask("task-1", "running"),
    ]);

    const row = persistence.database.connection
      .prepare("SELECT COUNT(*) AS count FROM runner_tasks WHERE task_id = ?")
      .get("task-1") as { count: number };

    expect(row.count).toBe(1);
    persistence.close();
  });

  it("lists tasks by state", async () => {
    const tempDir = await createTempDir("codex-runner-store-");
    tempDirs.push(tempDir);
    const persistence = openCodexRunnerPersistence({
      filePath: `${tempDir}/runner.sqlite`,
    });

    await persistence.store.saveTask(buildTask("task-1", "queued"));
    await persistence.store.saveTask(buildTask("task-2", "running"));
    await persistence.store.saveTask(buildTask("task-3", "running"));

    await expect(persistence.store.listTasksByState("running")).resolves.toEqual([
      buildTask("task-2", "running"),
      buildTask("task-3", "running"),
    ]);
    persistence.close();
  });
});
