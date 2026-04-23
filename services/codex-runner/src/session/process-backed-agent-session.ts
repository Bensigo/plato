import type {
  AgentSession,
  AgentSessionHandlers,
  AgentSessionFactory,
  LogStreamer,
  ManagedSession,
  ProcessPool,
  RunnerTaskRecord,
  WorktreeAllocation,
} from "../contracts.js";

export class ProcessBackedAgentSession implements AgentSession {
  readonly #processPool: ProcessPool;
  readonly #logStreamer: LogStreamer;

  constructor(processPool: ProcessPool, logStreamer: LogStreamer) {
    this.#processPool = processPool;
    this.#logStreamer = logStreamer;
  }

  async start(
    task: RunnerTaskRecord,
    worktree: WorktreeAllocation,
    handlers?: AgentSessionHandlers,
  ): Promise<ManagedSession> {
    const session = await this.#processPool.spawn(task, worktree);

    await this.#logStreamer.append({
      taskId: task.taskId,
      type: "session.started",
      sessionId: session.sessionId,
      worktreePath: worktree.worktreePath,
      pid: session.pid,
    });

    await this.#processPool.attach(session.sessionId, {
      onStdoutLine: async (line) => {
        await this.#logStreamer.append({
          taskId: task.taskId,
          type: "session.output",
          sessionId: session.sessionId,
          worktreePath: worktree.worktreePath,
          stream: "stdout",
          message: line,
        });
      },
      onStderrLine: async (line) => {
        await this.#logStreamer.append({
          taskId: task.taskId,
          type: "session.output",
          sessionId: session.sessionId,
          worktreePath: worktree.worktreePath,
          stream: "stderr",
          message: line,
        });
      },
      onExit: async (exitCode) => {
        await this.#logStreamer.append({
          taskId: task.taskId,
          type: "session.exited",
          sessionId: session.sessionId,
          worktreePath: worktree.worktreePath,
          exitCode,
        });
        await handlers?.onExit?.(exitCode);
      },
    });

    return session;
  }
}

export class ProcessBackedAgentSessionFactory implements AgentSessionFactory {
  readonly #processPool: ProcessPool;

  constructor(processPool: ProcessPool) {
    this.#processPool = processPool;
  }

  create(logStreamer: LogStreamer): AgentSession {
    return new ProcessBackedAgentSession(this.#processPool, logStreamer);
  }
}
