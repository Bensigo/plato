import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { RunnerTaskRecord } from "../src/contracts.js";
import { FileRunnerStore } from "../src/store/file-runner-store.js";
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

describe("FileRunnerStore", () => {
  it("persists tasks across store instances", async () => {
    const tempDir = await createTempDir("codex-runner-store-");
    tempDirs.push(tempDir);
    const filePath = join(tempDir, "runner-store.json");

    const firstStore = new FileRunnerStore(filePath);
    await firstStore.saveTask(buildTask("task-1", "queued"));

    const secondStore = new FileRunnerStore(filePath);
    await expect(secondStore.getTask("task-1")).resolves.toEqual(buildTask("task-1", "queued"));
  });

  it("updates an existing task instead of duplicating it", async () => {
    const tempDir = await createTempDir("codex-runner-store-");
    tempDirs.push(tempDir);
    const filePath = join(tempDir, "runner-store.json");
    const store = new FileRunnerStore(filePath);

    await store.saveTask(buildTask("task-1", "queued"));
    await store.saveTask(buildTask("task-1", "running"));

    await expect(store.listTasksByState("running")).resolves.toEqual([buildTask("task-1", "running")]);
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as { tasks: RunnerTaskRecord[] };
    expect(parsed.tasks).toHaveLength(1);
  });
});
