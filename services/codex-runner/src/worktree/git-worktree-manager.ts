import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { WorktreeAllocation, WorktreeManager } from "../contracts.js";
import { WorktreeProvisioningError } from "../contracts.js";

const execFileAsync = promisify(execFile);

export interface GitWorktreeManagerOptions {
  rootDirName?: string;
  branchPrefix?: string;
}

export class GitWorktreeManager implements WorktreeManager {
  readonly #rootDirName: string;
  readonly #branchPrefix: string;

  constructor(options: GitWorktreeManagerOptions = {}) {
    this.#rootDirName = options.rootDirName ?? ".plato/worktrees";
    this.#branchPrefix = options.branchPrefix ?? "plato/task-";
  }

  async createWorktree(taskId: string, repoPath: string): Promise<WorktreeAllocation> {
    const branchName = `${this.#branchPrefix}${taskId}`;
    const worktreeRoot = join(repoPath, this.#rootDirName);
    const worktreePath = join(worktreeRoot, taskId);

    await mkdir(worktreeRoot, { recursive: true });

    try {
      await execFileAsync("git", ["-C", repoPath, "worktree", "add", "-b", branchName, worktreePath, "HEAD"]);
    } catch (error) {
      const message =
        error instanceof Error && "stderr" in error && typeof error.stderr === "string" && error.stderr.length > 0
          ? error.stderr.trim()
          : error instanceof Error
            ? error.message
            : "Unknown git worktree failure";

      throw new WorktreeProvisioningError(message, taskId, repoPath);
    }

    return {
      taskId,
      repoPath,
      branchName,
      worktreePath,
    };
  }
}
