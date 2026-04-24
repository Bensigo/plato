import { describe, expect, it } from "vitest";

import {
  TaskOrchestrationService,
  type AgentRuntime,
  type CreateOrchestrationGraphInput,
  type OrchestrationEvent,
  type OrchestrationTaskGraphSnapshot,
  type OrchestrationTaskRecord,
  type StartOrchestrationTaskInput,
} from "../src/index.js";

describe("TaskOrchestrationService", () => {
  it("routes task starts to the selected agent runtime without backend-specific contracts", async () => {
    const codex = new FakeAgentRuntime("codex-local", "codex");
    const hermes = new FakeAgentRuntime("hermes-local", "hermes");
    const orchestration = new TaskOrchestrationService({
      defaultRuntimeId: codex.runtimeId,
      runtimes: [codex, hermes],
    });

    const task = await orchestration.startTask({
      taskId: "task-1",
      workspacePath: "/repo",
      prompt: "Implement the thing",
      agent: { runtimeId: hermes.runtimeId },
    });

    expect(task.execution).toEqual({
      runtimeId: "hermes-local",
      backend: "hermes",
      backendTaskId: "task-1",
    });
    expect(hermes.startedTaskIds).toEqual(["task-1"]);
    expect(codex.startedTaskIds).toEqual([]);
  });

  it("resolves follow-up task operations through the runtime that created the task", async () => {
    const codex = new FakeAgentRuntime("codex-local", "codex");
    const hermes = new FakeAgentRuntime("hermes-local", "hermes");
    const orchestration = new TaskOrchestrationService({
      defaultRuntimeId: codex.runtimeId,
      runtimes: [codex, hermes],
    });

    await orchestration.startTask({
      taskId: "task-1",
      workspacePath: "/repo",
      prompt: "Implement the thing",
      agent: { runtimeId: hermes.runtimeId },
    });

    await expect(orchestration.getTask("task-1")).resolves.toMatchObject({
      execution: { runtimeId: "hermes-local" },
    });
    await orchestration.interruptTask("task-1");
    await orchestration.listEvents("task-1");

    expect(hermes.interruptedTaskIds).toEqual(["task-1"]);
    expect(hermes.listedEventTaskIds).toEqual(["task-1"]);
    expect(codex.interruptedTaskIds).toEqual([]);
    expect(codex.listedEventTaskIds).toEqual([]);
  });

  it("discovers existing tasks across registered runtimes when no selector is provided", async () => {
    const codex = new FakeAgentRuntime("codex-local", "codex");
    const hermes = new FakeAgentRuntime("hermes-local", "hermes");
    hermes.tasks.set(
      "existing-task",
      hermes.buildTask({
        taskId: "existing-task",
        workspacePath: "/repo",
        prompt: "Already running",
      }),
    );
    const orchestration = new TaskOrchestrationService({
      defaultRuntimeId: codex.runtimeId,
      runtimes: [codex, hermes],
    });

    await expect(orchestration.getTask("existing-task")).resolves.toMatchObject({
      execution: { runtimeId: "hermes-local" },
    });
    await orchestration.resumeTask("existing-task");

    expect(hermes.resumedTaskIds).toEqual(["existing-task"]);
    expect(codex.resumedTaskIds).toEqual([]);
  });

  it("lists tasks across all registered runtimes when no selector is provided", async () => {
    const codex = new FakeAgentRuntime("codex-local", "codex");
    const hermes = new FakeAgentRuntime("hermes-local", "hermes");
    codex.tasks.set(
      "codex-task",
      codex.buildTask({
        taskId: "codex-task",
        workspacePath: "/repo",
        prompt: "Codex work",
      }),
    );
    hermes.tasks.set(
      "hermes-task",
      hermes.buildTask({
        taskId: "hermes-task",
        workspacePath: "/repo",
        prompt: "Hermes work",
      }),
    );
    const orchestration = new TaskOrchestrationService({
      defaultRuntimeId: codex.runtimeId,
      runtimes: [codex, hermes],
    });

    await expect(orchestration.listTasks()).resolves.toMatchObject([
      { taskId: "codex-task", execution: { runtimeId: "codex-local" } },
      { taskId: "hermes-task", execution: { runtimeId: "hermes-local" } },
    ]);
  });

  it("preserves same task ids from different runtimes in aggregated task lists", async () => {
    const codex = new FakeAgentRuntime("codex-local", "codex");
    const hermes = new FakeAgentRuntime("hermes-local", "hermes");
    codex.tasks.set(
      "shared-task",
      codex.buildTask({
        taskId: "shared-task",
        workspacePath: "/repo",
        prompt: "Codex work",
      }),
    );
    hermes.tasks.set(
      "shared-task",
      hermes.buildTask({
        taskId: "shared-task",
        workspacePath: "/repo",
        prompt: "Hermes work",
      }),
    );
    const orchestration = new TaskOrchestrationService({
      defaultRuntimeId: codex.runtimeId,
      runtimes: [codex, hermes],
    });

    await expect(orchestration.listTasks()).resolves.toMatchObject([
      { taskId: "shared-task", execution: { runtimeId: "codex-local" } },
      { taskId: "shared-task", execution: { runtimeId: "hermes-local" } },
    ]);
  });

  it("uses the default runtime when no agent selector is provided", async () => {
    const runtime = new FakeAgentRuntime("default-agent", "test-agent");
    const orchestration = new TaskOrchestrationService({
      defaultRuntimeId: runtime.runtimeId,
      runtimes: [runtime],
    });

    await orchestration.startTask({
      taskId: "task-1",
      workspacePath: "/repo",
      prompt: "Run default",
    });

    expect(runtime.startedTaskIds).toEqual(["task-1"]);
  });

  it("routes graph creation through the parent task agent selector", async () => {
    const codex = new FakeAgentRuntime("codex-local", "codex");
    const other = new FakeAgentRuntime("other-local", "other");
    const orchestration = new TaskOrchestrationService({
      defaultRuntimeId: codex.runtimeId,
      runtimes: [codex, other],
    });

    const graph = await orchestration.createTaskGraph({
      parent: {
        taskId: "parent",
        workspacePath: "/repo",
        prompt: "Parent",
        agent: { runtimeId: other.runtimeId },
      },
      children: [
        {
          taskId: "child",
          prompt: "Child",
        },
      ],
    });

    expect(graph.parent.execution.runtimeId).toBe("other-local");
    expect(other.createdGraphParentIds).toEqual(["parent"]);
    expect(codex.createdGraphParentIds).toEqual([]);
  });

  it("fails explicitly when a requested runtime is not registered", async () => {
    const runtime = new FakeAgentRuntime("default-agent", "test-agent");
    const orchestration = new TaskOrchestrationService({
      defaultRuntimeId: runtime.runtimeId,
      runtimes: [runtime],
    });

    await expect(
      orchestration.startTask({
        taskId: "task-1",
        workspacePath: "/repo",
        prompt: "Run elsewhere",
        agent: { runtimeId: "missing-agent" },
      }),
    ).rejects.toThrow("Agent runtime 'missing-agent' is not registered");
  });
});

class FakeAgentRuntime implements AgentRuntime {
  readonly startedTaskIds: string[] = [];
  readonly createdGraphParentIds: string[] = [];
  readonly interruptedTaskIds: string[] = [];
  readonly listedEventTaskIds: string[] = [];
  readonly resumedTaskIds: string[] = [];
  readonly tasks = new Map<string, OrchestrationTaskRecord>();

  constructor(
    readonly runtimeId: string,
    readonly backend: string,
  ) {}

  async startTask(input: StartOrchestrationTaskInput): Promise<OrchestrationTaskRecord> {
    this.startedTaskIds.push(input.taskId);
    const task = this.buildTask(input);
    this.tasks.set(task.taskId, task);
    return task;
  }

  async createTaskGraph(input: CreateOrchestrationGraphInput): Promise<OrchestrationTaskGraphSnapshot> {
    this.createdGraphParentIds.push(input.parent.taskId);
    const parent = this.buildTask(input.parent);
    this.tasks.set(parent.taskId, parent);
    const children = input.children.map((child) =>
      this.buildTask({
        taskId: child.taskId,
        workspacePath: child.workspacePath ?? input.parent.workspacePath,
        prompt: child.prompt,
        priority: child.priority,
      }),
    );
    for (const child of children) {
      this.tasks.set(child.taskId, child);
    }
    return {
      parent,
      children,
      state: "queued",
    };
  }

  async getTask(taskId: string): Promise<OrchestrationTaskRecord | undefined> {
    return this.tasks.get(taskId);
  }

  async getTaskGraph(): Promise<OrchestrationTaskGraphSnapshot | undefined> {
    return undefined;
  }

  async listTasks(): Promise<OrchestrationTaskRecord[]> {
    return [...this.tasks.values()];
  }

  async listEvents(taskId: string): Promise<OrchestrationEvent[]> {
    this.listedEventTaskIds.push(taskId);
    return [];
  }

  async interruptTask(taskId: string): Promise<void> {
    this.interruptedTaskIds.push(taskId);
  }

  async resumeTask(taskId: string): Promise<OrchestrationTaskRecord> {
    this.resumedTaskIds.push(taskId);
    const task = this.buildTask({
      taskId,
      workspacePath: "/repo",
      prompt: "Resume",
    });
    this.tasks.set(task.taskId, task);
    return task;
  }

  buildTask(input: StartOrchestrationTaskInput): OrchestrationTaskRecord {
    return {
      taskId: input.taskId,
      workspacePath: input.workspacePath,
      prompt: input.prompt,
      priority: input.priority ?? 0,
      state: "queued",
      execution: {
        runtimeId: this.runtimeId,
        backend: this.backend,
        backendTaskId: input.taskId,
      },
    };
  }
}
