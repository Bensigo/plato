import { afterEach, describe, expect, it } from "vitest";

import type { RunnerTaskRecord, WorktreeAllocation } from "../src/contracts.js";
import { LocalProcessPool } from "../src/process/local-process-pool.js";
import { cleanupDir, createTempDir } from "./helpers/git.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(cleanupDir));
});

function buildTask(taskId: string): RunnerTaskRecord {
  return {
    taskId,
    repoPath: "/repo",
    prompt: "run",
    priority: 1,
    state: "queued",
  };
}

function buildAllocation(taskId: string, worktreePath: string): WorktreeAllocation {
  return {
    taskId,
    repoPath: "/repo",
    branchName: `plato/task-${taskId}`,
    worktreePath,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for predicate");
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("LocalProcessPool", () => {
  it("spawns a real process and frees capacity after exit", async () => {
    const worktreePath = await createTempDir("codex-runner-process-");
    tempDirs.push(worktreePath);

    const pool = new LocalProcessPool({
      maxConcurrent: 1,
      createCommand: () => ({
        command: process.execPath,
        args: ["-e", "setTimeout(() => process.exit(0), 50)"],
      }),
    });

    const session = await pool.spawn(buildTask("task-1"), buildAllocation("task-1", worktreePath));

    expect(session.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(session.pid).toBeTypeOf("number");
    expect(pool.hasCapacity()).toBe(false);

    await waitFor(() => pool.hasCapacity());
    expect(pool.hasCapacity()).toBe(true);
  });

  it("interrupts a running session and restores capacity", async () => {
    const worktreePath = await createTempDir("codex-runner-process-");
    tempDirs.push(worktreePath);

    const pool = new LocalProcessPool({
      maxConcurrent: 1,
      createCommand: () => ({
        command: process.execPath,
        args: ["-e", "setTimeout(() => process.exit(0), 5000)"],
      }),
    });

    const session = await pool.spawn(buildTask("task-1"), buildAllocation("task-1", worktreePath));
    expect(pool.hasCapacity()).toBe(false);

    await pool.interrupt(session.sessionId);
    await waitFor(() => pool.hasCapacity());
    expect(pool.hasCapacity()).toBe(true);
  });
});
