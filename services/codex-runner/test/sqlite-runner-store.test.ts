import { DatabaseSync } from "node:sqlite";
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

  it("adds the parent task index after upgrading an existing database", async () => {
    const tempDir = await createTempDir("codex-runner-store-");
    tempDirs.push(tempDir);
    const filePath = `${tempDir}/runner.sqlite`;

    const connection = new DatabaseSync(filePath);
    connection.exec(`
      CREATE TABLE runner_tasks (
        task_id TEXT PRIMARY KEY,
        repo_path TEXT NOT NULL,
        prompt TEXT NOT NULL,
        priority INTEGER NOT NULL,
        state TEXT NOT NULL,
        worktree_path TEXT,
        active_session_id TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX runner_tasks_state_idx
        ON runner_tasks (state);

      CREATE TABLE runner_sessions (
        session_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        pid INTEGER,
        state TEXT NOT NULL,
        exit_code INTEGER,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(task_id) REFERENCES runner_tasks(task_id) ON DELETE CASCADE
      );

      CREATE INDEX runner_sessions_task_id_idx
        ON runner_sessions (task_id);
    `);
    connection.close();

    const persistence = openCodexRunnerPersistence({ filePath });

    const columns = persistence.database.connection
      .prepare("PRAGMA table_info(runner_tasks)")
      .all() as Array<{ name: string }>;
    expect(columns.some((column) => column.name === "parent_task_id")).toBe(true);

    const indexes = persistence.database.connection
      .prepare("PRAGMA index_list(runner_tasks)")
      .all() as Array<{ name: string }>;
    expect(indexes.some((index) => index.name === "runner_tasks_parent_task_id_idx")).toBe(true);

    persistence.close();
  });
});
