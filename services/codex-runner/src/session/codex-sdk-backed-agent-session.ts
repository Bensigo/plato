import { randomUUID } from "node:crypto";

import { Codex, type CodexOptions, type ThreadEvent, type ThreadItem, type ThreadOptions } from "@openai/codex-sdk";

import type {
  AgentSession,
  AgentSessionFactory,
  AgentSessionHandlers,
  LogStreamer,
  ManagedSession,
  RunnerTaskRecord,
  WorktreeAllocation,
} from "../contracts.js";

type StreamedTurnLike = {
  events: AsyncGenerator<ThreadEvent>;
};

type CodexThreadLike = {
  runStreamed(input: string, options?: { signal?: AbortSignal }): Promise<StreamedTurnLike>;
};

type CodexClientLike = {
  startThread(options?: ThreadOptions): CodexThreadLike;
};

export interface CodexSdkAgentSessionFactoryOptions {
  codex?: CodexClientLike;
  codexOptions?: CodexOptions;
  threadOptions?: Omit<ThreadOptions, "workingDirectory">;
}

export class CodexSdkBackedAgentSession implements AgentSession {
  readonly #codex: CodexClientLike;
  readonly #logStreamer: LogStreamer;
  readonly #threadOptions?: Omit<ThreadOptions, "workingDirectory">;
  readonly #abortControllers = new Map<string, AbortController>();

  constructor(
    codex: CodexClientLike,
    logStreamer: LogStreamer,
    threadOptions?: Omit<ThreadOptions, "workingDirectory">,
  ) {
    this.#codex = codex;
    this.#logStreamer = logStreamer;
    this.#threadOptions = threadOptions;
  }

  async start(
    task: RunnerTaskRecord,
    worktree: WorktreeAllocation,
    handlers?: AgentSessionHandlers,
  ): Promise<ManagedSession> {
    const sessionId = randomUUID();
    const thread = this.#codex.startThread({
      ...this.#threadOptions,
      workingDirectory: worktree.worktreePath,
    });
    const abortController = new AbortController();

    this.#abortControllers.set(sessionId, abortController);
    await this.#logStreamer.append({
      taskId: task.taskId,
      type: "session.started",
      sessionId,
      worktreePath: worktree.worktreePath,
    });
    void this.#consumeThread(task, worktree, sessionId, thread, abortController, handlers);

    return {
      sessionId,
      taskId: task.taskId,
      worktreePath: worktree.worktreePath,
    };
  }

  async interrupt(sessionId: string): Promise<void> {
    this.#abortControllers.get(sessionId)?.abort();
  }

  async #consumeThread(
    task: RunnerTaskRecord,
    worktree: WorktreeAllocation,
    sessionId: string,
    thread: CodexThreadLike,
    abortController: AbortController,
    handlers?: AgentSessionHandlers,
  ): Promise<void> {
    const emittedOutput = new Map<string, string>();
    let terminalExitCode: number | null | undefined;

    try {
      const { events } = await thread.runStreamed(task.prompt, {
        signal: abortController.signal,
      });

      for await (const event of events) {
        if (
          event.type === "item.started" ||
          event.type === "item.updated" ||
          event.type === "item.completed"
        ) {
          const nextText = this.#itemText(event.item);
          if (!nextText) {
            continue;
          }

          const previousText = emittedOutput.get(event.item.id) ?? "";
          const message =
            nextText.startsWith(previousText) ? nextText.slice(previousText.length) : nextText;

          emittedOutput.set(event.item.id, nextText);
          if (message.length === 0) {
            continue;
          }

          await this.#logStreamer.append({
            taskId: task.taskId,
            type: "session.output",
            sessionId,
            worktreePath: worktree.worktreePath,
            stream: event.item.type === "error" ? "stderr" : "stdout",
            message,
          });
          continue;
        }

        if (event.type === "turn.failed") {
          terminalExitCode = abortController.signal.aborted ? null : 1;
          await this.#logStreamer.append({
            taskId: task.taskId,
            type: "session.output",
            sessionId,
            worktreePath: worktree.worktreePath,
            stream: "stderr",
            message: event.error.message,
          });
          continue;
        }

        if (event.type === "error") {
          terminalExitCode = abortController.signal.aborted ? null : 1;
          await this.#logStreamer.append({
            taskId: task.taskId,
            type: "session.output",
            sessionId,
            worktreePath: worktree.worktreePath,
            stream: "stderr",
            message: event.message,
          });
          continue;
        }

        if (event.type === "turn.completed") {
          terminalExitCode = 0;
        }
      }
    } catch (error) {
      terminalExitCode = abortController.signal.aborted ? null : 1;
      if (!abortController.signal.aborted) {
        await this.#logStreamer.append({
          taskId: task.taskId,
          type: "session.output",
          sessionId,
          worktreePath: worktree.worktreePath,
          stream: "stderr",
          message: error instanceof Error ? error.message : "Unknown Codex SDK failure",
        });
      }
    } finally {
      this.#abortControllers.delete(sessionId);

      if (terminalExitCode === undefined) {
        terminalExitCode = abortController.signal.aborted ? null : 1;
      }

      await this.#logStreamer.append({
        taskId: task.taskId,
        type: "session.exited",
        sessionId,
        worktreePath: worktree.worktreePath,
        exitCode: terminalExitCode,
      });
      await handlers?.onExit?.(terminalExitCode);
    }
  }

  #itemText(item: ThreadItem): string {
    switch (item.type) {
      case "agent_message":
      case "reasoning":
        return item.text;
      case "error":
        return item.message;
      case "command_execution":
        return item.aggregated_output;
      case "mcp_tool_call":
        return item.error?.message ?? "";
      case "todo_list":
        return item.items.map((entry) => `${entry.completed ? "[x]" : "[ ]"} ${entry.text}`).join("\n");
      default:
        return "";
    }
  }
}

export class CodexSdkBackedAgentSessionFactory implements AgentSessionFactory {
  readonly #codex: CodexClientLike;
  readonly #threadOptions?: Omit<ThreadOptions, "workingDirectory">;

  constructor(options: CodexSdkAgentSessionFactoryOptions = {}) {
    this.#codex = options.codex ?? new Codex(options.codexOptions);
    this.#threadOptions = options.threadOptions;
  }

  create(logStreamer: LogStreamer): AgentSession {
    return new CodexSdkBackedAgentSession(this.#codex, logStreamer, this.#threadOptions);
  }
}
