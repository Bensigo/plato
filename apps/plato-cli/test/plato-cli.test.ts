import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { runPlato } from "../src/cli.js";
import { runPlatoMcp } from "../src/mcp.js";
import { createPlatoMcpServer, runPlatoCli, type OrchestrationClient } from "../src/index.js";
import {
  createPlatoMcpServerWithRuntime,
  openPlatoRuntime,
  runPlatoCliWithRuntime,
  runPlatoMcpWithRuntime,
} from "../src/bootstrap.js";
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
    expect(handlerSource).not.toContain("@modelcontextprotocol/sdk/server/stdio.js");
  });

  it("dispatches plato mcp to the MCP server runner", async () => {
    const runCli = vi.fn(async () => 1);
    const runMcp = vi.fn(async () => 0);

    await expect(runPlato(["mcp"], { runCli, runMcp })).resolves.toBe(0);

    expect(runMcp).toHaveBeenCalledTimes(1);
    expect(runCli).not.toHaveBeenCalled();
  });

  it("rejects invalid plato mcp arguments before opening the runtime", async () => {
    const runMcp = vi.fn(async () => {
      throw new Error("runtime should not open");
    });
    const stderr = new MemoryStream();

    await expect(runPlato(["mcp", "--bad-flag"], { runMcp, stderr })).resolves.toBe(1);

    expect(runMcp).not.toHaveBeenCalled();
    expect(stderr.text).toBe("usage: plato mcp\n");
  });

  it("serves the Plato MCP tool catalog over an MCP transport", async () => {
    const client = new Client({ name: "plato-test", version: "0.1.0" });
    const server = createPlatoMcpServer(new FakeOrchestrationClient());
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        client.connect(clientTransport),
        server.connect(serverTransport),
      ]);

      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("plato.list_tasks");

      const result = await client.callTool({
        name: "plato.list_tasks",
        arguments: {},
      });
      const content = result.content as Array<{ type: string; text?: string }>;
      expect(JSON.parse(content[0]?.type === "text" ? content[0].text ?? "null" : "null")).toEqual([]);
    } finally {
      await client.close();
      await server.close();
    }
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

  it("does not open the Codex runtime for invalid CLI commands", async () => {
    let opened = false;
    const stderr = new MemoryStream();

    await expect(
      runPlatoCliWithRuntime([], {
        stderr,
        openCodexRuntime: () => {
          opened = true;
          throw new Error("runtime should not open");
        },
      }),
    ).resolves.toBe(1);

    expect(opened).toBe(false);
    expect(stderr.text).toContain("usage: plato task|graph <command>");
  });

  it("does not open the Codex runtime for commands that fail local flag validation", async () => {
    let opened = false;
    const stderr = new MemoryStream();

    await expect(
      runPlatoCliWithRuntime(["task", "start", "--prompt", "Build it"], {
        stderr,
        openCodexRuntime: () => {
          opened = true;
          throw new Error("runtime should not open");
        },
      }),
    ).resolves.toBe(1);

    expect(opened).toBe(false);
    expect(stderr.text).toContain("missing required --task-id");
  });

  it("closes the Codex runtime when orchestration bootstrap fails", async () => {
    const runner = new FakeRunnerOperatorClient();
    let closed = false;

    await expect(
      openPlatoRuntime({
        runtimeId: "codex-local",
        defaultRuntimeId: "missing-runtime",
        openCodexRuntime: () => ({
          service: runner,
          close: () => {
            closed = true;
          },
        }),
      }),
    ).rejects.toThrow("Default agent runtime 'missing-runtime' is not registered");

    expect(closed).toBe(true);
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

  it("connects the runtime-backed MCP server to an injected transport", async () => {
    const runner = new FakeRunnerOperatorClient();
    const transport = new FakeTransport();
    let connectedTransport: Transport | undefined;
    const connectServer = vi.fn(async (_server: McpServer, nextTransport: Transport) => {
      connectedTransport = nextTransport;
    });

    await expect(
      runPlatoMcpWithRuntime({
        openCodexRuntime: () => ({
          service: runner,
          close: () => {
            runner.closed = true;
          },
        }),
        createTransport: () => transport,
        connectServer,
      }),
    ).resolves.toBe(0);

    expect(connectServer).toHaveBeenCalledTimes(1);
    expect(connectedTransport).toBe(transport);
    expect(runner.closed).toBe(false);
  });

  it("exposes a dedicated plato-mcp runner without opening Codex on import", async () => {
    const runner = new FakeRunnerOperatorClient();
    let connected = false;

    await expect(
      runPlatoMcp({
        openCodexRuntime: () => ({
          service: runner,
          close: () => {
            runner.closed = true;
          },
        }),
        createTransport: () => new FakeTransport(),
        connectServer: async () => {
          connected = true;
        },
      }),
    ).resolves.toBe(0);

    expect(connected).toBe(true);
    expect(runner.closed).toBe(false);
  });

  it("closes the runtime-backed MCP server when transport connection fails", async () => {
    const runner = new FakeRunnerOperatorClient();

    await expect(
      runPlatoMcpWithRuntime({
        openCodexRuntime: () => ({
          service: runner,
          close: () => {
            runner.closed = true;
          },
        }),
        createTransport: () => new FakeTransport(),
        connectServer: async () => {
          throw new Error("connect failed");
        },
      }),
    ).rejects.toThrow("connect failed");

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

class FakeTransport implements Transport {
  async start(): Promise<void> {}

  async send(): Promise<void> {}

  async close(): Promise<void> {}
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
