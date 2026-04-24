import { describe, expect, it } from "vitest";

import { createPlatoMcpServer, runPlatoCli, type OrchestrationClient } from "../src/index.js";
import type {
  AgentRuntimeSelector,
  CreateOrchestrationGraphInput,
  OrchestrationEvent,
  OrchestrationTaskGraphResultSnapshot,
  OrchestrationTaskGraphSnapshot,
  OrchestrationTaskRecord,
  StartOrchestrationTaskInput,
} from "@plato/orchestration";

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
