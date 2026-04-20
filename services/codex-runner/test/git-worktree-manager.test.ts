import { afterEach, describe, expect, it } from "vitest";

import { WorktreeProvisioningError } from "../src/contracts.js";
import { GitWorktreeManager } from "../src/worktree/git-worktree-manager.js";
import { cleanupDir, createGitRepo, createTempDir, runGit } from "./helpers/git.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(cleanupDir));
});

describe("GitWorktreeManager", () => {
  it("creates a git worktree on a task branch", async () => {
    const repoPath = await createGitRepo();
    tempDirs.push(repoPath);
    const manager = new GitWorktreeManager();

    const allocation = await manager.createWorktree("task-1", repoPath);

    expect(allocation.branchName).toBe("plato/task-task-1");
    expect(allocation.worktreePath).toBe(`${repoPath}/.plato/worktrees/task-1`);
    await expect(runGit(repoPath, ["branch", "--list", allocation.branchName])).resolves.toContain(
      allocation.branchName,
    );
    await expect(runGit(repoPath, ["-C", allocation.worktreePath, "rev-parse", "--abbrev-ref", "HEAD"])).resolves.toBe(
      allocation.branchName,
    );
  });

  it("throws a WorktreeProvisioningError when the repo is invalid", async () => {
    const invalidRepoPath = await createTempDir("codex-runner-invalid-repo-");
    tempDirs.push(invalidRepoPath);
    const manager = new GitWorktreeManager();

    await expect(manager.createWorktree("task-1", invalidRepoPath)).rejects.toBeInstanceOf(
      WorktreeProvisioningError,
    );
  });
});
