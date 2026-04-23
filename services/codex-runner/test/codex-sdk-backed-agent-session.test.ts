import { describe, expect, it } from "vitest";

import type { LogStreamer, SessionEvent } from "../src/contracts.js";
import type { ThreadEvent } from "@openai/codex-sdk";
import { CodexSdkBackedAgentSession } from "../src/session/codex-sdk-backed-agent-session.js";

class InMemoryLogStreamer implements LogStreamer {
  readonly #events = new Map<string, SessionEvent[]>();

  async append(event: SessionEvent): Promise<void> {
    const current = this.#events.get(event.taskId) ?? [];
    current.push(event);
    this.#events.set(event.taskId, current);
  }

  async list(taskId: string): Promise<SessionEvent[]> {
    return this.#events.get(taskId) ?? [];
  }
}

class FakeCodexThread {
  readonly prompts: string[] = [];
  signal?: AbortSignal;

  constructor(private readonly events: ThreadEvent[]) {}

  async runStreamed(input: string, options?: { signal?: AbortSignal }) {
    this.prompts.push(input);
    this.signal = options?.signal;

    async function* emit(events: ThreadEvent[]) {
      for (const event of events) {
        yield event;
      }
    }

    return {
      events: emit(this.events),
    };
  }
}

class FakeCodexClient {
  readonly threads: FakeCodexThread[] = [];

  constructor(private readonly events: ThreadEvent[]) {}

  startThread(): FakeCodexThread {
    const thread = new FakeCodexThread(this.events);
    this.threads.push(thread);
    return thread;
  }
}

describe("CodexSdkBackedAgentSession", () => {
  it("maps streamed Codex events into runner events and completes successfully", async () => {
    const logStreamer = new InMemoryLogStreamer();
    const codex = new FakeCodexClient([
      {
        type: "item.updated",
        item: {
          id: "msg-1",
          type: "agent_message",
          text: "Working on it",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "cmd-1",
          type: "command_execution",
          command: "pnpm test",
          aggregated_output: "tests passed",
          status: "completed",
          exit_code: 0,
        },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 10,
          cached_input_tokens: 0,
          output_tokens: 12,
        },
      },
    ]);
    const session = new CodexSdkBackedAgentSession(codex, logStreamer);
    const exits: Array<number | null> = [];

    const managed = await session.start(
      {
        taskId: "task-1",
        repoPath: "/repo",
        prompt: "fix it",
        priority: 0,
        state: "queued",
      },
      {
        taskId: "task-1",
        repoPath: "/repo",
        branchName: "plato/task-task-1",
        worktreePath: "/repo/.plato/worktrees/task-1",
      },
      {
        onExit: async (exitCode) => {
          exits.push(exitCode);
        },
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(managed.taskId).toBe("task-1");
    expect(codex.threads).toHaveLength(1);
    expect(codex.threads[0]?.prompts).toEqual(["fix it"]);
    expect(exits).toEqual([0]);
    await expect(logStreamer.list("task-1")).resolves.toEqual([
      {
        taskId: "task-1",
        type: "session.started",
        sessionId: managed.sessionId,
        worktreePath: "/repo/.plato/worktrees/task-1",
      },
      {
        taskId: "task-1",
        type: "session.output",
        sessionId: managed.sessionId,
        worktreePath: "/repo/.plato/worktrees/task-1",
        stream: "stdout",
        message: "Working on it",
      },
      {
        taskId: "task-1",
        type: "session.output",
        sessionId: managed.sessionId,
        worktreePath: "/repo/.plato/worktrees/task-1",
        stream: "stdout",
        message: "tests passed",
      },
      {
        taskId: "task-1",
        type: "session.exited",
        sessionId: managed.sessionId,
        worktreePath: "/repo/.plato/worktrees/task-1",
        exitCode: 0,
      },
    ]);
  });

  it("aborts the active turn when interrupted", async () => {
    const logStreamer = new InMemoryLogStreamer();
    const codex = new FakeCodexClient([
      {
        type: "item.updated",
        item: {
          id: "msg-1",
          type: "agent_message",
          text: "Still running",
        },
      },
    ]);
    const session = new CodexSdkBackedAgentSession(codex, logStreamer);

    const managed = await session.start(
      {
        taskId: "task-1",
        repoPath: "/repo",
        prompt: "interrupt it",
        priority: 0,
        state: "queued",
      },
      {
        taskId: "task-1",
        repoPath: "/repo",
        branchName: "plato/task-task-1",
        worktreePath: "/repo/.plato/worktrees/task-1",
      },
    );

    await session.interrupt(managed.sessionId);

    expect(codex.threads[0]?.signal?.aborted).toBe(true);
  });
});
