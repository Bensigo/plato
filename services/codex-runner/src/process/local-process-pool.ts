import { spawn, type ChildProcess } from "node:child_process";

import type { ManagedSession, ProcessPool, RunnerTaskRecord, WorktreeAllocation } from "../contracts.js";

export interface ProcessCommand {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface LocalProcessPoolOptions {
  maxConcurrent: number;
  createCommand: (task: RunnerTaskRecord, worktree: WorktreeAllocation) => ProcessCommand;
}

export class LocalProcessPool implements ProcessPool {
  readonly #maxConcurrent: number;
  readonly #createCommand: LocalProcessPoolOptions["createCommand"];
  readonly #processes = new Map<string, ChildProcess>();
  #sessionCounter = 0;

  constructor(options: LocalProcessPoolOptions) {
    this.#maxConcurrent = options.maxConcurrent;
    this.#createCommand = options.createCommand;
  }

  hasCapacity(): boolean {
    return this.#processes.size < this.#maxConcurrent;
  }

  async spawn(task: RunnerTaskRecord, worktree: WorktreeAllocation): Promise<ManagedSession> {
    if (!this.hasCapacity()) {
      throw new Error("Process pool is at capacity");
    }

    const sessionId = `session-${++this.#sessionCounter}`;
    const command = this.#createCommand(task, worktree);
    const child = spawn(command.command, command.args ?? [], {
      cwd: command.cwd ?? worktree.worktreePath,
      env: command.env,
      stdio: "ignore",
    });

    this.#processes.set(sessionId, child);
    child.once("exit", () => {
      this.#processes.delete(sessionId);
    });

    return {
      sessionId,
      taskId: task.taskId,
      worktreePath: worktree.worktreePath,
      pid: child.pid,
    };
  }

  async interrupt(sessionId: string): Promise<void> {
    const child = this.#processes.get(sessionId);
    if (!child) {
      return;
    }

    child.kill("SIGTERM");
    this.#processes.delete(sessionId);
  }
}
