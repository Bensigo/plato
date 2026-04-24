import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createPlatoMcpServer, runPlatoCli, type OrchestrationClient } from "../src/index.js";
import { createPlatoMcpServerWithRuntime, openPlatoRuntime, runPlatoCliWithRuntime } from "../src/bootstrap.js";
import type {
  AgentRuntimeSelector,
  CreateOrchestrationGraphInput,
  OrchestrationEvent,
  OrchestrationTaskGraphResultSnapshot,
  OrchestrationTaskGraphSnapshot,
  OrchestrationTaskRecord,
  StartOrchestrationTaskInput,
} from "@plato/orchestration";
import type {
  CreateTaskGraphInput,
  CodexRunnerAgentRuntimeService,
  RunnerTaskGraphResultSnapshot,
  RunnerTaskGraphSnapshot,
  RunnerTaskRecord,
  SessionEvent,
} from "@plato/codex-runner";

describe("plato product surface", () => {
  it("routes CLI task starts through neutral orchestration inputs", async () => {
    const client = new FakeOrchestrationClient();
    const stdout = new MemoryStream();

    await expect(
      runPlatoCli(
        [
          "task",
          "start",
          "--task-id",
          "task-1",
          "--workspace-path",
          "/repo",
          "--prompt",
          "Build it",
          "--runtime-id",
          "hermes-local",
        ],
        { client, stdout },
      ),
    ).resolves.toBe(0);

    expect(client.startedTasks).toEqual([
      {
        taskId: "task-1",
        workspacePath: "/repo",
        prompt: "Build it",
        priority: undefined,
        agent: { runtimeId: "hermes-local" },
      },
    ]);
    expect(JSON.parse(stdout.text)).toMatchObject({
      taskId: "task-1",
      workspacePath: "/repo",
      execution: { runtimeId: "hermes-local", backend: "fake" },
    });
  });

  it("routes CLI graph starts through neutral graph inputs", async () => {
    const client = new FakeOrchestrationClient();
    const stdout = new MemoryStream();

    await expect(
      runPlatoCli(
        [
          "graph",
          "start",
          "--task-id",
          "parent",
          "--workspace-path",
          "/repo",
          "--prompt",
          "Coordinate",
          "--children-json",
          JSON.stringify([{ taskId: "child", prompt: "Do work" }]),
        ],
        { client, stdout },
      ),
    ).resolves.toBe(0);

    expect(client.createdGraphs[0]).toMatchObject({
      parent: {
        taskId: "parent",
        workspacePath: "/repo",
        prompt: "Coordinate",
      },
      children: [{ taskId: "child", prompt: "Do work" }],
    });
    expect(JSON.parse(stdout.text)).toMatchObject({
      parent: { taskId: "parent" },
      children: [{ taskId: "child" }],
    });
  });

  it("filters CLI task lists by orchestration state", async () => {
    const client = new FakeOrchestrationClient();
    client.tasks = [
      buildTask("running-task", "/repo", "Run", undefined, "running"),
      buildTask("failed-task", "/repo", "Fail", undefined, "failed"),
    ];
    const stdout = new MemoryStream();

    await expect(
      runPlatoCli(["task", "list", "--state", "running"], { client, stdout }),
    ).resolves.toBe(0);

    expect(JSON.parse(stdout.text)).toMatchObject([
      { taskId: "running-task", state: "running" },
    ]);
  });

  it("creates an MCP server without depending on Codex runner internals", () => {
    const server = createPlatoMcpServer(new FakeOrchestrationClient());

    expect(server).toBeDefined();
    expect(server.isConnected()).toBe(false);
  });

  it("keeps CLI and MCP handlers free of Codex runner imports", async () => {
    const handlerSource = await readFile(resolve(import.meta.dirname, "../src/index.ts"), "utf8");

    expect(handlerSource).not.toContain("@plato/codex-runner");
  });

  it("bootstraps the CLI surface with a real Codex-backed orchestration runtime", async () => {
    const runner = new FakeRunnerOperatorClient();
    const stdout = new MemoryStream();

    await expect(
      runPlatoCliWithRuntime(
        [
          "task",
          "start",
          "--task-id",
          "task-1",
          "--workspace-path",
          "/repo",
          "--prompt",
          "Build it",
        ],
        {
          stdout,
          openCodexRuntime: () => ({
            service: runner,
            close: () => {
              runner.closed = true;
            },
          }),
        },
      ),
    ).resolves.toBe(0);

    expect(runner.startedTasks).toEqual([
      {
        taskId: "task-1",
        repoPath: "/repo",
        prompt: "Build it",
        priority: undefined,
        contextPackage: undefined,
      },
    ]);
    expect(JSON.parse(stdout.text)).toMatchObject({
      taskId: "task-1",
      workspacePath: "/repo",
      execution: { runtimeId: "codex", backend: "codex", backendTaskId: "task-1" },
    });
    expect(runner.closed).toBe(true);
  });

  it("bootstraps MCP with an injected Codex-backed orchestration runtime", async () => {
    const runner = new FakeRunnerOperatorClient();

    const runtime = await createPlatoMcpServerWithRuntime({
      runtimeId: "codex-local",
      openCodexRuntime: () => ({
        service: runner,
        close: () => {
          runner.closed = true;
        },
      }),
    });

    expect(runtime.server).toBeDefined();
    expect(runtime.server.isConnected()).toBe(false);

    runtime.close();
    expect(runner.closed).toBe(true);
  });

  it("opens a closeable orchestration client with the selected runtime id", async () => {
    const runner = new FakeRunnerOperatorClient();
    const runtime = await openPlatoRuntime({
      runtimeId: "codex-local",
      openCodexRuntime: () => ({
        service: runner,
        close: () => {
          runner.closed = true;
        },
      }),
    });

    const task = await runtime.client.startTask({
      taskId: "task-1",
      workspacePath: "/repo",
      prompt: "Build it",
    });

    expect(task.execution).toMatchObject({ runtimeId: "codex-local", backend: "codex" });

    runtime.close();
    expect(runner.closed).toBe(true);
  });
});

class MemoryStream {
  text = "";

  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

class FakeOrchestrationClient implements OrchestrationClient {
  readonly startedTasks: StartOrchestrationTaskInput[] = [];
  readonly createdGraphs: CreateOrchestrationGraphInput[] = [];
  tasks: OrchestrationTaskRecord[] = [];

  async startTask(input: StartOrchestrationTaskInput): Promise<OrchestrationTaskRecord> {
    this.startedTasks.push(input);
    return buildTask(input.taskId, input.workspacePath, input.prompt, input.agent);
  }

  async createTaskGraph(input: CreateOrchestrationGraphInput): Promise<OrchestrationTaskGraphSnapshot> {
    this.createdGraphs.push(input);
    return {
      parent: buildTask(input.parent.taskId, input.parent.workspacePath, input.parent.prompt, input.parent.agent),
      children: input.children.map((child) =>
        buildTask(child.taskId, child.workspacePath ?? input.parent.workspacePath, child.prompt, input.parent.agent),
      ),
      state: "queued",
    };
  }

  async getTask(): Promise<OrchestrationTaskRecord | undefined> {
    return undefined;
  }

  async getTaskGraph(): Promise<OrchestrationTaskGraphSnapshot | undefined> {
    return undefined;
  }

  async getTaskGraphResults(): Promise<OrchestrationTaskGraphResultSnapshot | undefined> {
    return undefined;
  }

  async listTasks(): Promise<OrchestrationTaskRecord[]> {
    return this.tasks;
  }

  async listEvents(): Promise<OrchestrationEvent[]> {
    return [];
  }

  async interruptTask(): Promise<void> {}

  async resumeTask(taskId: string): Promise<OrchestrationTaskRecord> {
    return buildTask(taskId, "/repo", "Resume");
  }

  async approveTaskAction(taskId: string): Promise<OrchestrationTaskRecord> {
    return buildTask(taskId, "/repo", "Approve");
  }

  async rejectTaskAction(taskId: string): Promise<OrchestrationTaskRecord> {
    return buildTask(taskId, "/repo", "Reject");
  }
}

function buildTask(
  taskId: string,
  workspacePath: string,
  prompt: string,
  selector?: AgentRuntimeSelector,
  state: OrchestrationTaskRecord["state"] = "queued",
): OrchestrationTaskRecord {
  return {
    taskId,
    workspacePath,
    prompt,
    priority: 0,
    state,
    execution: {
      runtimeId: selector?.runtimeId ?? "default",
      backend: "fake",
      backendTaskId: taskId,
    },
  };
}

class FakeRunnerOperatorClient implements CodexRunnerAgentRuntimeService {
  readonly startedTasks: Array<{
    taskId: string;
    repoPath: string;
    prompt: string;
    priority?: number;
    contextPackage?: unknown;
  }> = [];
  readonly tasks = new Map<string, RunnerTaskRecord>();
  closed = false;

  async startTask(input: {
    taskId: string;
    repoPath: string;
    prompt: string;
    priority?: number;
    contextPackage?: unknown;
  }): Promise<RunnerTaskRecord> {
    this.startedTasks.push(input);
    const task = buildRunnerTask(input.taskId, input.repoPath, input.prompt, input.priority);
    this.tasks.set(task.taskId, task);
    return task;
  }

  async createTaskGraph(input: CreateTaskGraphInput): Promise<RunnerTaskGraphSnapshot> {
    const parent = buildRunnerTask(input.parent.taskId, input.parent.repoPath, input.parent.prompt);
    const children = input.children.map((child) =>
      buildRunnerTask(child.taskId, child.repoPath ?? input.parent.repoPath, child.prompt),
    );
    this.tasks.set(parent.taskId, parent);
    for (const child of children) {
      this.tasks.set(child.taskId, child);
    }
    return { parent, children, state: "queued" };
  }

  async getTask(taskId: string): Promise<RunnerTaskRecord | undefined> {
    return this.tasks.get(taskId);
  }

  async getTaskGraph(): Promise<RunnerTaskGraphSnapshot | undefined> {
    return undefined;
  }

  async getTaskGraphResults(): Promise<RunnerTaskGraphResultSnapshot | undefined> {
    return undefined;
  }

  async listTasks(): Promise<RunnerTaskRecord[]> {
    return [...this.tasks.values()];
  }

  async listEvents(): Promise<SessionEvent[]> {
    return [];
  }

  async interruptTask(): Promise<void> {}

  async resumeTask(taskId: string): Promise<RunnerTaskRecord> {
    return this.requireTask(taskId);
  }

  async approveTaskAction(taskId: string): Promise<RunnerTaskRecord> {
    return this.requireTask(taskId);
  }

  async rejectTaskAction(taskId: string): Promise<RunnerTaskRecord> {
    return this.requireTask(taskId);
  }

  private requireTask(taskId: string): RunnerTaskRecord {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} was not found`);
    }
    return task;
  }
}

function buildRunnerTask(
  taskId: string,
  repoPath: string,
  prompt: string,
  priority = 0,
): RunnerTaskRecord {
  return {
    taskId,
    repoPath,
    prompt,
    priority,
    state: "queued",
  };
}
