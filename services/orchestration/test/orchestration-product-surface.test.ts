import { describe, expect, it } from "vitest";

import {
  OrchestrationProductSurface,
  TaskOrchestrationService,
  type AgentRuntime,
  type CreateOrchestrationGraphInput,
  type OrchestrationEvent,
  type OrchestrationTaskGraphResultSnapshot,
  type OrchestrationTaskGraphSnapshot,
  type OrchestrationTaskRecord,
  type StartOrchestrationTaskInput,
} from "../src/index.js";

describe("OrchestrationProductSurface", () => {
  it("exposes stable MCP/CLI tool descriptors without backend-specific names", () => {
    const surface = new OrchestrationProductSurface(
      new TaskOrchestrationService({
        defaultRuntimeId: "test",
        runtimes: [new SurfaceFakeRuntime("test", "test-agent")],
      }),
    );

    expect(surface.listTools()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "plato.start_task",
          operation: "start_task",
          readOnly: false,
        }),
        expect.objectContaining({
          name: "plato.get_task_graph_results",
          operation: "get_task_graph_results",
          readOnly: true,
        }),
        expect.objectContaining({
          name: "plato.reject_task_action",
          operation: "reject_task_action",
          readOnly: false,
        }),
      ]),
    );
    expect(surface.listTools().map((tool) => tool.name)).not.toContain("codex.start_task");
  });

  it("starts tasks and graphs through runtime selectors using product-level workspace paths", async () => {
    const codex = new SurfaceFakeRuntime("codex-local", "codex");
    const hermes = new SurfaceFakeRuntime("hermes-local", "hermes");
    const surface = new OrchestrationProductSurface(
      new TaskOrchestrationService({
        defaultRuntimeId: codex.runtimeId,
        runtimes: [codex, hermes],
      }),
    );

    await expect(
      surface.startTask({
        taskId: "task-1",
        workspacePath: "/repo",
        prompt: "Build a thing",
        runtimeId: "hermes-local",
      }),
    ).resolves.toMatchObject({
      task: {
        taskId: "task-1",
        workspacePath: "/repo",
        execution: { runtimeId: "hermes-local", backend: "hermes" },
      },
    });

    await expect(
      surface.createTaskGraph({
        parent: {
          taskId: "parent",
          workspacePath: "/repo",
          prompt: "Coordinate",
          runtimeId: "hermes-local",
        },
        children: [{ taskId: "child", prompt: "Do child work" }],
      }),
    ).resolves.toMatchObject({
      graph: {
        parent: { taskId: "parent", execution: { runtimeId: "hermes-local" } },
        children: [{ taskId: "child", workspacePath: "/repo" }],
      },
    });

    expect(hermes.startedTaskIds).toEqual(["task-1"]);
    expect(hermes.createdGraphParentIds).toEqual(["parent"]);
    expect(codex.startedTaskIds).toEqual([]);
    expect(codex.createdGraphParentIds).toEqual([]);
  });

  it("inspects tasks, graphs, events, and results with JSON-friendly response envelopes", async () => {
    const runtime = new SurfaceFakeRuntime("default-agent", "test-agent");
    runtime.graphResults = {
      parentTaskId: "parent",
      results: [
        {
          resultId: "result-1",
          taskId: "child",
          parentTaskId: "parent",
          classification: "completed",
          summary: "Done",
        },
      ],
    };
    const surface = new OrchestrationProductSurface(
      new TaskOrchestrationService({
        defaultRuntimeId: runtime.runtimeId,
        runtimes: [runtime],
      }),
    );

    await surface.createTaskGraph({
      parent: {
        taskId: "parent",
        workspacePath: "/repo",
        prompt: "Coordinate",
      },
      children: [{ taskId: "child", prompt: "Do child work" }],
    });

    await expect(surface.getTask({ taskId: "child" })).resolves.toMatchObject({
      task: { taskId: "child" },
    });
    await expect(surface.getTaskGraph({ taskId: "parent" })).resolves.toMatchObject({
      graph: { parent: { taskId: "parent" }, children: [{ taskId: "child" }] },
    });
    await expect(surface.getTaskGraphResults({ taskId: "parent" })).resolves.toEqual({
      graphResults: runtime.graphResults,
    });
    await expect(surface.listTaskEvents({ taskId: "parent" })).resolves.toEqual({
      taskId: "parent",
      events: [
        expect.objectContaining({
          taskId: "parent",
          type: "task.graph.created",
          runtimeId: "default-agent",
          backend: "test-agent",
        }),
      ],
    });
  });

  it("filters task lists by orchestration state and routes execution controls", async () => {
    const runtime = new SurfaceFakeRuntime("default-agent", "test-agent");
    const surface = new OrchestrationProductSurface(
      new TaskOrchestrationService({
        defaultRuntimeId: runtime.runtimeId,
        runtimes: [runtime],
      }),
    );
    runtime.tasks.set(
      "running-task",
      runtime.buildTask({
        taskId: "running-task",
        workspacePath: "/repo",
        prompt: "Run",
        state: "running",
      }),
    );
    runtime.tasks.set(
      "failed-task",
      runtime.buildTask({
        taskId: "failed-task",
        workspacePath: "/repo",
        prompt: "Fail",
        state: "failed",
      }),
    );

    await expect(surface.listTasks({ state: "running" })).resolves.toMatchObject({
      tasks: [{ taskId: "running-task" }],
    });
    await expect(surface.interruptTask({ taskId: "running-task" })).resolves.toEqual({
      taskId: "running-task",
      state: "accepted",
    });
    await expect(surface.resumeTask({ taskId: "running-task" })).resolves.toMatchObject({
      task: { taskId: "running-task", state: "running" },
    });
    await expect(surface.approveTaskAction({ taskId: "running-task" })).resolves.toMatchObject({
      task: { taskId: "running-task", state: "running" },
    });
    await expect(
      surface.rejectTaskAction({ taskId: "running-task", reason: "No thanks" }),
    ).resolves.toMatchObject({
      task: { taskId: "running-task", state: "failed" },
    });

    expect(runtime.interruptedTaskIds).toEqual(["running-task"]);
    expect(runtime.resumedTaskIds).toEqual(["running-task"]);
    expect(runtime.approvedTaskIds).toEqual(["running-task"]);
    expect(runtime.rejectedTaskInputs).toEqual([{ taskId: "running-task", reason: "No thanks" }]);
  });

  it("dispatches operation requests for MCP and CLI adapters", async () => {
    const runtime = new SurfaceFakeRuntime("default-agent", "test-agent");
    const surface = new OrchestrationProductSurface(
      new TaskOrchestrationService({
        defaultRuntimeId: runtime.runtimeId,
        runtimes: [runtime],
      }),
    );

    await expect(
      surface.execute({
        operation: "start_task",
        input: {
          taskId: "task-1",
          workspacePath: "/repo",
          prompt: "Ship it",
        },
      }),
    ).resolves.toMatchObject({
      operation: "start_task",
      task: { taskId: "task-1" },
    });

    await expect(
      surface.execute({
        operation: "list_task_events",
        input: { taskId: "task-1" },
      }),
    ).resolves.toEqual({
      operation: "list_task_events",
      taskId: "task-1",
      events: [
        expect.objectContaining({
          taskId: "task-1",
          type: "task.queued",
        }),
      ],
    });
  });
});

class SurfaceFakeRuntime implements AgentRuntime {
  readonly startedTaskIds: string[] = [];
  readonly createdGraphParentIds: string[] = [];
  readonly interruptedTaskIds: string[] = [];
  readonly resumedTaskIds: string[] = [];
  readonly approvedTaskIds: string[] = [];
  readonly rejectedTaskInputs: Array<{ taskId: string; reason: string }> = [];
  readonly tasks = new Map<string, OrchestrationTaskRecord>();
  readonly graphs = new Map<string, OrchestrationTaskGraphSnapshot>();
  readonly events = new Map<string, OrchestrationEvent[]>();
  graphResults?: OrchestrationTaskGraphResultSnapshot;

  constructor(
    readonly runtimeId: string,
    readonly backend: string,
  ) {}

  async startTask(input: StartOrchestrationTaskInput): Promise<OrchestrationTaskRecord> {
    this.startedTaskIds.push(input.taskId);
    const task = this.buildTask(input);
    this.tasks.set(task.taskId, task);
    this.addEvent(task.taskId, "task.queued");
    return task;
  }

  async createTaskGraph(input: CreateOrchestrationGraphInput): Promise<OrchestrationTaskGraphSnapshot> {
    this.createdGraphParentIds.push(input.parent.taskId);
    const parent = this.buildTask(input.parent);
    const children = input.children.map((child) =>
      this.buildTask({
        taskId: child.taskId,
        workspacePath: child.workspacePath ?? input.parent.workspacePath,
        prompt: child.prompt,
        priority: child.priority,
      }),
    );
    const graph = {
      parent,
      children,
      state: "queued" as const,
    };
    this.tasks.set(parent.taskId, parent);
    for (const child of children) {
      this.tasks.set(child.taskId, child);
    }
    this.graphs.set(parent.taskId, graph);
    this.addEvent(parent.taskId, "task.graph.created");
    return graph;
  }

  async getTask(taskId: string): Promise<OrchestrationTaskRecord | undefined> {
    return this.tasks.get(taskId);
  }

  async getTaskGraph(taskId: string): Promise<OrchestrationTaskGraphSnapshot | undefined> {
    return this.graphs.get(taskId);
  }

  async getTaskGraphResults(): Promise<OrchestrationTaskGraphResultSnapshot | undefined> {
    return this.graphResults;
  }

  async listTasks(): Promise<OrchestrationTaskRecord[]> {
    return [...this.tasks.values()];
  }

  async listEvents(taskId: string): Promise<OrchestrationEvent[]> {
    return this.events.get(taskId) ?? [];
  }

  async interruptTask(taskId: string): Promise<void> {
    this.interruptedTaskIds.push(taskId);
  }

  async resumeTask(taskId: string): Promise<OrchestrationTaskRecord> {
    this.resumedTaskIds.push(taskId);
    const existing = this.tasks.get(taskId);
    const task = existing ? { ...existing, state: "running" as const } : this.buildTask({ taskId });
    this.tasks.set(task.taskId, task);
    return task;
  }

  async approveTaskAction(taskId: string): Promise<OrchestrationTaskRecord> {
    this.approvedTaskIds.push(taskId);
    const existing = this.tasks.get(taskId);
    const task = existing ? { ...existing, state: "running" as const } : this.buildTask({ taskId });
    this.tasks.set(task.taskId, task);
    return task;
  }

  async rejectTaskAction(taskId: string, reason: string): Promise<OrchestrationTaskRecord> {
    this.rejectedTaskInputs.push({ taskId, reason });
    const existing = this.tasks.get(taskId);
    const task = existing ? { ...existing, state: "failed" as const } : this.buildTask({ taskId });
    this.tasks.set(task.taskId, task);
    return task;
  }

  buildTask(
    input: Partial<StartOrchestrationTaskInput> & {
      taskId: string;
      state?: OrchestrationTaskRecord["state"];
    },
  ): OrchestrationTaskRecord {
    return {
      taskId: input.taskId,
      workspacePath: input.workspacePath ?? "/repo",
      prompt: input.prompt ?? "Run task",
      priority: input.priority ?? 0,
      state: input.state ?? "queued",
      execution: {
        runtimeId: this.runtimeId,
        backend: this.backend,
        backendTaskId: input.taskId,
      },
    };
  }

  private addEvent(taskId: string, type: string): void {
    this.events.set(taskId, [
      ...(this.events.get(taskId) ?? []),
      {
        taskId,
        type,
        runtimeId: this.runtimeId,
        backend: this.backend,
      },
    ]);
  }
}
