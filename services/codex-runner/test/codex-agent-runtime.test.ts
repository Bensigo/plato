import { describe, expect, it } from "vitest";

import { CodexRunnerAgentRuntime, type CodexRunnerAgentRuntimeService } from "../src/index.js";
import type {
  CreateTaskGraphInput,
  RunnerTaskGraphResultSnapshot,
  RunnerTaskGraphSnapshot,
  RunnerTaskRecord,
  SessionEvent,
  StartTaskInput,
} from "../src/contracts.js";

describe("CodexRunnerAgentRuntime", () => {
  it("adapts orchestration task starts to codex-runner without leaking repoPath", async () => {
    const service = new FakeCodexRunnerService();
    const runtime = new CodexRunnerAgentRuntime({
      runtimeId: "codex-local",
      service,
    });

    const task = await runtime.startTask({
      taskId: "task-1",
      workspacePath: "/repo",
      prompt: "Build it",
      priority: 3,
    });

    expect(service.started).toEqual([
      {
        taskId: "task-1",
        repoPath: "/repo",
        prompt: "Build it",
        priority: 3,
      },
    ]);
    expect(task).toMatchObject({
      taskId: "task-1",
      workspacePath: "/repo",
      execution: {
        runtimeId: "codex-local",
        backend: "codex",
        backendTaskId: "task-1",
      },
    });
    expect("repoPath" in task).toBe(false);
  });

  it("adapts graph creation and dependency metadata to orchestration records", async () => {
    const service = new FakeCodexRunnerService();
    const runtime = new CodexRunnerAgentRuntime({ service });

    const graph = await runtime.createTaskGraph({
      parent: {
        taskId: "parent",
        workspacePath: "/repo",
        prompt: "Parent",
      },
      children: [
        {
          taskId: "child",
          prompt: "Child",
          dependencyTaskIds: ["setup"],
        },
      ],
    });

    expect(service.createdGraphs[0]).toEqual({
      parent: {
        taskId: "parent",
        repoPath: "/repo",
        prompt: "Parent",
        priority: undefined,
        contextPackage: undefined,
      },
      children: [
        {
          taskId: "child",
          repoPath: undefined,
          prompt: "Child",
          priority: undefined,
          dependencyTaskIds: ["setup"],
          contextPackage: undefined,
        },
      ],
    });
    expect(graph.children[0]?.decomposition).toEqual({
      kind: "subtask",
      parentTaskId: "parent",
      dependencyTaskIds: ["setup"],
    });
    expect(graph.children[0]?.execution.backend).toBe("codex");
  });

  it("adds runtime identity to codex-runner events", async () => {
    const service = new FakeCodexRunnerService();
    service.events = [
      {
        taskId: "task-1",
        type: "task.graph.completed",
        graphState: "completed",
        resultClassification: "completed",
        pid: 1234,
        verificationId: "verification-1",
        verificationStatus: "passed",
        recoveredState: "completed",
      },
    ];
    const runtime = new CodexRunnerAgentRuntime({
      runtimeId: "codex-local",
      service,
    });

    await expect(runtime.listEvents("task-1")).resolves.toEqual([
      {
        taskId: "task-1",
        type: "task.graph.completed",
        runtimeId: "codex-local",
        backend: "codex",
        graphState: "completed",
        resultClassification: "completed",
        pid: 1234,
        verificationId: "verification-1",
        verificationStatus: "passed",
        recoveredState: "completed",
      },
    ]);
  });
});

class FakeCodexRunnerService implements CodexRunnerAgentRuntimeService {
  readonly started: StartTaskInput[] = [];
  readonly createdGraphs: CreateTaskGraphInput[] = [];
  events: SessionEvent[] = [];

  async startTask(input: StartTaskInput): Promise<RunnerTaskRecord> {
    this.started.push(input);
    return buildTask(input.taskId, input.repoPath, input.prompt, {
      priority: input.priority,
    });
  }

  async createTaskGraph(input: CreateTaskGraphInput): Promise<RunnerTaskGraphSnapshot> {
    this.createdGraphs.push(input);
    return {
      parent: buildTask(input.parent.taskId, input.parent.repoPath, input.parent.prompt),
      children: input.children.map((child) =>
        buildTask(child.taskId, child.repoPath ?? input.parent.repoPath, child.prompt, {
          decomposition: {
            kind: "subtask",
            parentTaskId: input.parent.taskId,
            dependencyTaskIds: child.dependencyTaskIds,
          },
        }),
      ),
      state: "queued",
    };
  }

  async getTask(): Promise<RunnerTaskRecord | undefined> {
    return undefined;
  }

  async getTaskGraph(): Promise<RunnerTaskGraphSnapshot | undefined> {
    return undefined;
  }

  async getTaskGraphResults(): Promise<RunnerTaskGraphResultSnapshot | undefined> {
    return undefined;
  }

  async listTasks(): Promise<RunnerTaskRecord[]> {
    return [];
  }

  async listEvents(): Promise<SessionEvent[]> {
    return this.events;
  }

  async interruptTask(): Promise<void> {}

  async resumeTask(taskId: string): Promise<RunnerTaskRecord> {
    return buildTask(taskId, "/repo", "Resume");
  }

  async approveTaskAction(taskId: string): Promise<RunnerTaskRecord> {
    return buildTask(taskId, "/repo", "Approve");
  }

  async rejectTaskAction(taskId: string): Promise<RunnerTaskRecord> {
    return buildTask(taskId, "/repo", "Reject", { state: "failed" });
  }
}

function buildTask(
  taskId: string,
  repoPath: string,
  prompt: string,
  options: Partial<RunnerTaskRecord> = {},
): RunnerTaskRecord {
  return {
    taskId,
    repoPath,
    prompt,
    priority: options.priority ?? 0,
    state: options.state ?? "queued",
    worktreePath: options.worktreePath,
    activeSessionId: options.activeSessionId,
    decomposition: options.decomposition,
    pendingApproval: options.pendingApproval,
  };
}
