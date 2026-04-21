import type { RunnerTaskRecord, WorktreeAllocation } from "../contracts.js";
import type { ProcessCommand } from "../process/local-process-pool.js";

export function createCodexAppServerCommand(
  task: RunnerTaskRecord,
  worktree: WorktreeAllocation,
): ProcessCommand {
  return {
    command: "codex",
    args: ["app-server", "--listen", "stdio://"],
    cwd: worktree.worktreePath,
    env: {
      ...process.env,
      PLATO_TASK_ID: task.taskId,
      PLATO_REPO_PATH: task.repoPath,
      PLATO_WORKTREE_PATH: worktree.worktreePath,
    },
  };
}
