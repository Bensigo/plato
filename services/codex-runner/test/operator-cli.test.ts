import { describe, expect, it } from "vitest";

import type { RunnerTaskRecord, RunnerTaskStatusSnapshot, SessionEvent } from "../src/contracts.js";
import type { OperatorRuntime, OperatorRuntimeOptions, RunnerOperatorClient } from "../src/cli.js";
import { runCodexRunnerCli } from "../src/cli.js";

class BufferWriter {
  value = "";

  write(chunk: string): void {
    this.value += chunk;
  }
}

function buildRuntime(
  service: RunnerOperatorClient,
  close: () => void = () => {},
): (options: OperatorRuntimeOptions) => OperatorRuntime {
  return (_options) => ({
    service,
    close,
  });
}

describe("runCodexRunnerCli", () => {
  it("starts a task and prints the created task record", async () => {
    const stdout = new BufferWriter();
    const stderr = new BufferWriter();
    const calls: Array<{ taskId: string; repoPath: string; prompt: string; priority?: number }> = [];
    const service: RunnerOperatorClient = {
      async startTask(input) {
        calls.push(input);
        return {
          ...input,
          priority: input.priority ?? 0,
          state: "queued",
        };
      },
      async createTaskGraph() {
        throw new Error("not used");
      },
      async getTask() {
        return undefined;
      },
      async getTaskGraph() {
        return undefined;
      },
      async getTaskStatus() {
        return undefined;
      },
      async listTasks() {
        return [];
      },
      async listTasksByState() {
        return [];
      },
      async listEvents() {
        return [];
      },
      async interruptTask() {},
      async resumeTask(taskId) {
        return {
          taskId,
          repoPath: "/repo",
          prompt: "resume",
          priority: 0,
          state: "running",
        };
      },
    };

    const exitCode = await runCodexRunnerCli(
      ["start", "--task-id", "task-1", "--repo-path", "/repo", "--prompt", "Ship it", "--priority", "4"],
      {
        cwd: "/workspace",
        stdout,
        stderr,
        openRuntime: buildRuntime(service),
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    expect(calls).toEqual([
      {
        taskId: "task-1",
        repoPath: "/repo",
        prompt: "Ship it",
        priority: 4,
      },
    ]);
    expect(JSON.parse(stdout.value)).toEqual({
      task: {
        taskId: "task-1",
        repoPath: "/repo",
        prompt: "Ship it",
        priority: 4,
        state: "queued",
      },
    });
  });

  it("prints a task status snapshot for status <taskId>", async () => {
    const stdout = new BufferWriter();
    const stderr = new BufferWriter();
    const snapshot: RunnerTaskStatusSnapshot = {
      task: {
        taskId: "task-1",
        repoPath: "/repo",
        prompt: "Ship it",
        priority: 0,
        state: "running",
        worktreePath: "/repo/.plato/worktrees/task-1",
        activeSessionId: "session-1",
      },
      sessions: [
        {
          sessionId: "session-1",
          taskId: "task-1",
          worktreePath: "/repo/.plato/worktrees/task-1",
          pid: 99,
          state: "running",
        },
      ],
    };
    const service: RunnerOperatorClient = {
      async startTask() {
        throw new Error("not used");
      },
      async createTaskGraph() {
        throw new Error("not used");
      },
      async getTask() {
        return snapshot.task;
      },
      async getTaskGraph() {
        return undefined;
      },
      async getTaskStatus(taskId) {
        return taskId === "task-1" ? snapshot : undefined;
      },
      async listTasks() {
        return [];
      },
      async listTasksByState() {
        return [];
      },
      async listEvents() {
        return [];
      },
      async interruptTask() {},
      async resumeTask() {
        return snapshot.task;
      },
    };

    const exitCode = await runCodexRunnerCli(["status", "task-1"], {
      stdout,
      stderr,
      openRuntime: buildRuntime(service),
    });

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    expect(JSON.parse(stdout.value)).toEqual(snapshot);
  });

  it("filters task listings by state via the indexed operator path", async () => {
    const stdout = new BufferWriter();
    const stderr = new BufferWriter();
    const tasks: RunnerTaskRecord[] = [
      {
        taskId: "task-1",
        repoPath: "/repo",
        prompt: "first",
        priority: 0,
        state: "running",
      },
      {
        taskId: "task-2",
        repoPath: "/repo",
        prompt: "second",
        priority: 0,
        state: "failed",
      },
    ];
    const service: RunnerOperatorClient = {
      async startTask() {
        throw new Error("not used");
      },
      async createTaskGraph() {
        throw new Error("not used");
      },
      async getTask() {
        return undefined;
      },
      async getTaskGraph() {
        return undefined;
      },
      async getTaskStatus() {
        return undefined;
      },
      async listTasks() {
        throw new Error("full task scan should not be used");
      },
      async listTasksByState(state) {
        return tasks.filter((task) => task.state === state);
      },
      async listEvents() {
        return [];
      },
      async interruptTask() {},
      async resumeTask() {
        return tasks[0];
      },
    };

    const exitCode = await runCodexRunnerCli(["status", "--state", "failed"], {
      stdout,
      stderr,
      openRuntime: buildRuntime(service),
    });

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    expect(JSON.parse(stdout.value)).toEqual({
      tasks: [tasks[1]],
    });
  });

  it("prints task events for events <taskId>", async () => {
    const stdout = new BufferWriter();
    const stderr = new BufferWriter();
    const events: SessionEvent[] = [
      { taskId: "task-1", type: "task.queued" },
      { taskId: "task-1", type: "task.started", sessionId: "session-1" },
    ];
    const service: RunnerOperatorClient = {
      async startTask() {
        throw new Error("not used");
      },
      async createTaskGraph() {
        throw new Error("not used");
      },
      async getTask() {
        return undefined;
      },
      async getTaskGraph() {
        return undefined;
      },
      async getTaskStatus() {
        return undefined;
      },
      async listTasks() {
        return [];
      },
      async listTasksByState() {
        return [];
      },
      async listEvents(taskId) {
        return taskId === "task-1" ? events : [];
      },
      async interruptTask() {},
      async resumeTask() {
        throw new Error("not used");
      },
    };

    const exitCode = await runCodexRunnerCli(["events", "task-1"], {
      stdout,
      stderr,
      openRuntime: buildRuntime(service),
    });

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    expect(JSON.parse(stdout.value)).toEqual({
      taskId: "task-1",
      events,
    });
  });

  it("starts a task graph and prints the created graph snapshot", async () => {
    const stdout = new BufferWriter();
    const stderr = new BufferWriter();
    const calls: unknown[] = [];
    const graph = {
      parent: {
        taskId: "task-parent",
        repoPath: "/repo",
        prompt: "Coordinate",
        priority: 0,
        state: "queued" as const,
      },
      children: [
        {
          taskId: "task-child",
          repoPath: "/repo",
          prompt: "Build API",
          priority: 3,
          state: "queued" as const,
          decomposition: {
            kind: "subtask" as const,
            parentTaskId: "task-parent",
          },
        },
      ],
      state: "queued" as const,
    };
    const service: RunnerOperatorClient = {
      async startTask() {
        throw new Error("not used");
      },
      async createTaskGraph(input) {
        calls.push(input);
        return graph;
      },
      async getTask() {
        return undefined;
      },
      async getTaskGraph() {
        return undefined;
      },
      async getTaskStatus() {
        return undefined;
      },
      async listTasks() {
        return [];
      },
      async listTasksByState() {
        return [];
      },
      async listEvents() {
        return [];
      },
      async interruptTask() {},
      async resumeTask() {
        throw new Error("not used");
      },
    };

    const exitCode = await runCodexRunnerCli(
      [
        "graph",
        "start",
        "--task-id",
        "task-parent",
        "--repo-path",
        "/repo",
        "--prompt",
        "Coordinate",
        "--child",
        "task-child:Build API:3",
      ],
      {
        stdout,
        stderr,
        openRuntime: buildRuntime(service),
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    expect(calls).toEqual([
      {
        parent: {
          taskId: "task-parent",
          repoPath: "/repo",
          prompt: "Coordinate",
          priority: undefined,
        },
        children: [
          {
            taskId: "task-child",
            prompt: "Build API",
            priority: 3,
          },
        ],
      },
    ]);
    expect(JSON.parse(stdout.value)).toEqual(graph);
  });

  it("prints a task graph snapshot for graph status <taskId>", async () => {
    const stdout = new BufferWriter();
    const stderr = new BufferWriter();
    const graph = {
      parent: {
        taskId: "task-parent",
        repoPath: "/repo",
        prompt: "Coordinate",
        priority: 0,
        state: "completed" as const,
      },
      children: [],
      state: "completed" as const,
    };
    const service: RunnerOperatorClient = {
      async startTask() {
        throw new Error("not used");
      },
      async createTaskGraph() {
        throw new Error("not used");
      },
      async getTask() {
        return graph.parent;
      },
      async getTaskGraph(taskId) {
        return taskId === "task-parent" ? graph : undefined;
      },
      async getTaskStatus() {
        return undefined;
      },
      async listTasks() {
        return [];
      },
      async listTasksByState() {
        return [];
      },
      async listEvents() {
        return [];
      },
      async interruptTask() {},
      async resumeTask() {
        throw new Error("not used");
      },
    };

    const exitCode = await runCodexRunnerCli(["graph", "status", "task-parent"], {
      stdout,
      stderr,
      openRuntime: buildRuntime(service),
    });

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    expect(JSON.parse(stdout.value)).toEqual(graph);
  });

  it("closes the runtime after an interrupt command", async () => {
    const stdout = new BufferWriter();
    const stderr = new BufferWriter();
    const interrupted: string[] = [];
    let closed = false;
    const snapshot: RunnerTaskStatusSnapshot = {
      task: {
        taskId: "task-1",
        repoPath: "/repo",
        prompt: "Ship it",
        priority: 0,
        state: "interrupted",
      },
      sessions: [],
    };
    const service: RunnerOperatorClient = {
      async startTask() {
        throw new Error("not used");
      },
      async createTaskGraph() {
        throw new Error("not used");
      },
      async getTask() {
        return snapshot.task;
      },
      async getTaskGraph() {
        return undefined;
      },
      async getTaskStatus() {
        return snapshot;
      },
      async listTasks() {
        return [];
      },
      async listTasksByState() {
        return [];
      },
      async listEvents() {
        return [];
      },
      async interruptTask(taskId) {
        interrupted.push(taskId);
      },
      async resumeTask() {
        return snapshot.task;
      },
    };

    const exitCode = await runCodexRunnerCli(["interrupt", "task-1"], {
      stdout,
      stderr,
      openRuntime: buildRuntime(service, () => {
        closed = true;
      }),
    });

    expect(exitCode).toBe(0);
    expect(interrupted).toEqual(["task-1"]);
    expect(closed).toBe(true);
    expect(stderr.value).toBe("");
    expect(JSON.parse(stdout.value)).toEqual(snapshot);
  });
});
