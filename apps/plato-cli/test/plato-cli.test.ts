import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { runPlato } from "../src/cli.js";
import { runPlatoMcp } from "../src/mcp.js";
import { runPlatoSmoke, type PlatoSmokeSummary } from "../src/smoke.js";
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
  OrchestrationTaskDecompositionPlan,
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

  it("plans and validates task graphs without starting execution", async () => {
    const client = new FakeOrchestrationClient();
    const plan = buildTaskGraphPlan();
    const planStdout = new MemoryStream();
    const validateStdout = new MemoryStream();

    await expect(
      runPlatoCli(["graph", "plan", "--plan-json", JSON.stringify(plan)], {
        client,
        stdout: planStdout,
      }),
    ).resolves.toBe(0);
    await expect(
      runPlatoCli(["graph", "validate", "--plan-json", JSON.stringify(plan)], {
        client,
        stdout: validateStdout,
      }),
    ).resolves.toBe(0);

    expect(client.createdGraphs).toEqual([]);
    expect(JSON.parse(planStdout.text)).toMatchObject({
      plan: {
        planId: "m28-plan",
        parent: { taskId: "parent", agent: { runtimeId: "codex-local" } },
        children: [{ taskId: "child-a" }, { taskId: "child-b" }],
      },
      validation: { valid: true, issues: [] },
    });
    expect(JSON.parse(validateStdout.text)).toMatchObject({
      validation: { valid: true, issues: [] },
      graphInput: {
        parent: { taskId: "parent", agent: { runtimeId: "codex-local" } },
        children: [
          { taskId: "child-a", prompt: "Implement contracts." },
          { taskId: "child-b", prompt: "Expose CLI.", dependencyTaskIds: ["child-a"] },
        ],
      },
    });
  });

  it("creates a delegate task plan from the CLI without opening orchestration execution", async () => {
    const client = new FakeOrchestrationClient();
    const stdout = new MemoryStream();

    await expect(
      runPlatoCli(
        [
          "delegate",
          "plan",
          "--task-id",
          "m28",
          "--workspace-path",
          "/repo",
          "--prompt",
          "Break this into reviewable milestones",
          "--runtime-id",
          "codex-local",
        ],
        { client, stdout },
      ),
    ).resolves.toBe(0);

    expect(client.opened).toBe(false);
    expect(client.startedTasks).toEqual([]);
    expect(client.createdGraphs).toEqual([]);
    expect(JSON.parse(stdout.text)).toMatchObject({
      plan: {
        planId: "m28-decomposition-plan",
        parent: {
          taskId: "m28",
          workspacePath: "/repo",
          prompt: "Break this into reviewable milestones",
          agent: { runtimeId: "codex-local" },
        },
        children: [
          {
            taskId: "m28-preflight",
            allowedToolNames: expect.arrayContaining(["inspect_workspace", "read_contract", "list_tests"]),
          },
          {
            taskId: "m28-implementation",
            writeScope: { paths: ["/repo"] },
            allowedToolNames: expect.arrayContaining([
              "context7.resolve_library",
              "context7.get_docs",
              "apply_patch",
              "run_tests",
              "run_typecheck",
            ]),
          },
          {
            taskId: "m28-review",
            allowedToolNames: expect.arrayContaining(["request_review", "git.push", "github.open_pr"]),
            requiresApproval: true,
          },
        ],
      },
      validation: { valid: true, issues: [] },
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

  it("prints the read-only worker tool harness catalog without opening orchestration", async () => {
    const client = new FakeOrchestrationClient();
    const stdout = new MemoryStream();

    await expect(runPlatoCli(["tool", "catalog"], { client, stdout })).resolves.toBe(0);

    const catalog = JSON.parse(stdout.text) as Array<{
      name: string;
      mode: string;
      riskLevel: string;
      failureModes: string[];
    }>;
    expect(catalog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "context7.resolve_library",
          mode: "external",
          riskLevel: "low",
        }),
        expect.objectContaining({
          name: "apply_patch",
          mode: "write",
          riskLevel: "medium",
        }),
        expect.objectContaining({
          name: "git.push",
          mode: "external",
          riskLevel: "high",
          requiresApproval: true,
        }),
      ]),
    );
    expect(client.opened).toBe(false);
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

  it("passes runtime storage options to task CLI commands", async () => {
    const runCli = vi.fn(async () => 0);

    await expect(
      runPlato([
        "task",
        "list",
        "--db-path",
        "/tmp/plato-smoke/runner.sqlite",
        "--log-path",
        "/tmp/plato-smoke/events.json",
        "--max-concurrent-tasks",
        "2",
      ], { runCli }),
    ).resolves.toBe(0);

    expect(runCli).toHaveBeenCalledWith(["task", "list"], {
      dbPath: "/tmp/plato-smoke/runner.sqlite",
      logPath: "/tmp/plato-smoke/events.json",
      maxConcurrentTasks: 2,
      stdout: undefined,
      stderr: undefined,
    });
  });

  it("passes runtime storage options to the MCP server command", async () => {
    const runMcp = vi.fn(async () => 0);

    await expect(
      runPlato([
        "mcp",
        "--db-path",
        "/tmp/plato-smoke/runner.sqlite",
        "--log-path",
        "/tmp/plato-smoke/events.json",
      ], { runMcp }),
    ).resolves.toBe(0);

    expect(runMcp).toHaveBeenCalledWith({
      dbPath: "/tmp/plato-smoke/runner.sqlite",
      logPath: "/tmp/plato-smoke/events.json",
    });
  });

  it("dispatches plato smoke to the deterministic smoke runner", async () => {
    const runCli = vi.fn(async () => 1);
    const runSmoke = vi.fn(async () => 0);

    await expect(runPlato(["smoke"], { runCli, runSmoke })).resolves.toBe(0);

    expect(runSmoke).toHaveBeenCalledTimes(1);
    expect(runCli).not.toHaveBeenCalled();
  });

  it("rejects invalid plato smoke arguments before running smoke checks", async () => {
    const runSmoke = vi.fn(async () => {
      throw new Error("smoke should not run");
    });
    const stderr = new MemoryStream();

    await expect(runPlato(["smoke", "--bad-flag"], { runSmoke, stderr })).resolves.toBe(1);

    expect(runSmoke).not.toHaveBeenCalled();
    expect(stderr.text).toBe("usage: plato smoke\n");
  });

  it("runs a deterministic local task smoke path through CLI handlers", async () => {
    const stdout = new MemoryStream();

    await expect(runPlatoSmoke({ cwd: "/repo", stdout })).resolves.toBe(0);

    const summary = JSON.parse(stdout.text) as PlatoSmokeSummary;
    expect(summary).toMatchObject({
      taskId: "plato-smoke-task",
      workspacePath: "/repo",
      checks: {
        started: true,
        statusReadable: true,
        eventsReadable: true,
        listed: true,
      },
    });
    expect(summary.eventTypes).toEqual(["task.queued", "task.started", "task.completed"]);
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
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "plato.delegate_task_plan",
          "plato.list_tools",
          "plato.list_tasks",
          "plato.list_orchestration_tools",
          "plato.plan_task_graph",
          "plato.validate_task_graph_plan",
        ]),
      );
      expect(tools.tools.find((tool) => tool.name === "plato.list_tools")).toMatchObject({
        annotations: { readOnlyHint: true },
      });
      expect(tools.tools.find((tool) => tool.name === "plato.delegate_task_plan")).toMatchObject({
        annotations: { readOnlyHint: true },
      });

      const result = await client.callTool({
        name: "plato.list_tasks",
        arguments: {},
      });
      const content = result.content as Array<{ type: string; text?: string }>;
      expect(JSON.parse(content[0]?.type === "text" ? content[0].text ?? "null" : "null")).toEqual([]);

      const planResult = await client.callTool({
        name: "plato.plan_task_graph",
        arguments: buildTaskGraphPlan() as unknown as Record<string, unknown>,
      });
      const planContent = planResult.content as Array<{ type: string; text?: string }>;
      expect(JSON.parse(planContent[0]?.type === "text" ? planContent[0].text ?? "null" : "null"))
        .toMatchObject({
          plan: { planId: "m28-plan" },
          validation: { valid: true, issues: [] },
        });

      const delegateResult = await client.callTool({
        name: "plato.delegate_task_plan",
        arguments: {
          taskId: "m28",
          workspacePath: "/repo",
          prompt: "Break this into reviewable milestones",
          runtimeId: "codex-local",
        },
      });
      const delegateContent = delegateResult.content as Array<{ type: string; text?: string }>;
      expect(JSON.parse(
        delegateContent[0]?.type === "text" ? delegateContent[0].text ?? "null" : "null",
      )).toMatchObject({
        plan: {
          planId: "m28-decomposition-plan",
          parent: { taskId: "m28", agent: { runtimeId: "codex-local" } },
          children: [
            { taskId: "m28-preflight" },
            { taskId: "m28-implementation" },
            { taskId: "m28-review" },
          ],
        },
        validation: { valid: true, issues: [] },
      });

      const validationResult = await client.callTool({
        name: "plato.validate_task_graph_plan",
        arguments: { plan: buildTaskGraphPlan() as unknown as Record<string, unknown> },
      });
      const validationContent = validationResult.content as Array<{ type: string; text?: string }>;
      expect(JSON.parse(
        validationContent[0]?.type === "text" ? validationContent[0].text ?? "null" : "null",
      )).toMatchObject({
        validation: { valid: true, issues: [] },
        graphInput: { parent: { taskId: "parent" } },
      });

      const catalogResult = await client.callTool({
        name: "plato.list_orchestration_tools",
        arguments: {},
      });
      const catalogContent = catalogResult.content as Array<{ type: string; text?: string }>;
      expect(JSON.parse(
        catalogContent[0]?.type === "text" ? catalogContent[0].text ?? "null" : "null",
      )).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "context7.get_docs",
            mode: "external",
            riskLevel: "low",
          }),
        ]),
      );
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
    expect(stderr.text).toContain("usage: plato task|graph|delegate|tool <command>");
  });

  it("does not open the Codex runtime for local delegate planning", async () => {
    let opened = false;
    const stdout = new MemoryStream();

    await expect(
      runPlatoCliWithRuntime(
        [
          "delegate",
          "plan",
          "--task-id",
          "m28",
          "--workspace-path",
          "/repo",
          "--prompt",
          "Break this into reviewable milestones",
        ],
        {
          stdout,
          openCodexRuntime: () => {
            opened = true;
            throw new Error("runtime should not open");
          },
        },
      ),
    ).resolves.toBe(0);

    expect(opened).toBe(false);
    expect(JSON.parse(stdout.text)).toMatchObject({
      plan: { planId: "m28-decomposition-plan", parent: { taskId: "m28" } },
      validation: { valid: true, issues: [] },
    });
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
  opened = false;

  async startTask(input: StartOrchestrationTaskInput): Promise<OrchestrationTaskRecord> {
    this.opened = true;
    this.startedTasks.push(input);
    return buildTask(input.taskId, input.workspacePath, input.prompt, input.agent);
  }

  async createTaskGraph(input: CreateOrchestrationGraphInput): Promise<OrchestrationTaskGraphSnapshot> {
    this.opened = true;
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
    this.opened = true;
    return undefined;
  }

  async getTaskGraph(): Promise<OrchestrationTaskGraphSnapshot | undefined> {
    this.opened = true;
    return undefined;
  }

  async getTaskGraphResults(): Promise<OrchestrationTaskGraphResultSnapshot | undefined> {
    this.opened = true;
    return undefined;
  }

  async listTasks(): Promise<OrchestrationTaskRecord[]> {
    this.opened = true;
    return this.tasks;
  }

  async listEvents(): Promise<OrchestrationEvent[]> {
    this.opened = true;
    return [];
  }

  async interruptTask(): Promise<void> {
    this.opened = true;
  }

  async resumeTask(taskId: string): Promise<OrchestrationTaskRecord> {
    this.opened = true;
    return buildTask(taskId, "/repo", "Resume");
  }

  async approveTaskAction(taskId: string): Promise<OrchestrationTaskRecord> {
    this.opened = true;
    return buildTask(taskId, "/repo", "Approve");
  }

  async rejectTaskAction(taskId: string): Promise<OrchestrationTaskRecord> {
    this.opened = true;
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

function buildTaskGraphPlan(): OrchestrationTaskDecompositionPlan {
  return {
    planId: "m28-plan",
    summary: "Reviewable M28 task graph plan.",
    parent: {
      taskId: "parent",
      workspacePath: "/repo",
      prompt: "Coordinate M28.",
      agent: { runtimeId: "codex-local" },
    },
    documentation: [
      {
        requirementId: "context7",
        label: "Context7",
        reason: "Confirm current documentation lookup behavior.",
        sources: [
          {
            sourceId: "context7-docs",
            kind: "context7",
            label: "Context7 docs",
            uri: "context7://docs",
          },
        ],
      },
    ],
    children: [
      {
        taskId: "child-a",
        prompt: "Implement contracts.",
        objective: "Define decomposition plan contracts.",
        writeScope: { paths: ["services/orchestration"] },
        allowedToolNames: ["search_repo", "read_file", "apply_patch", "run_tests"],
        verification: {
          commands: ["pnpm --filter @plato/orchestration test"],
          acceptanceCriteria: ["Plan validation is deterministic."],
        },
        riskLevel: "medium",
      },
      {
        taskId: "child-b",
        prompt: "Expose CLI.",
        objective: "Expose read-only planning and validation commands.",
        dependencyTaskIds: ["child-a"],
        writeScope: { paths: ["apps/plato-cli"] },
        allowedToolNames: ["search_repo", "read_file", "apply_patch", "run_tests"],
        verification: {
          commands: ["pnpm --filter @plato/cli test"],
          acceptanceCriteria: ["CLI planning commands do not start execution."],
        },
        riskLevel: "medium",
      },
    ],
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
