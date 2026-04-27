import {
  runPlatoCli,
  type OrchestrationClient,
} from "./index.js";
import type {
  AgentRuntimeSelector,
  CreateOrchestrationGraphInput,
  OrchestrationEvent,
  OrchestrationTaskGraphResultSnapshot,
  OrchestrationTaskGraphSnapshot,
  OrchestrationTaskRecord,
  StartOrchestrationTaskInput,
} from "@plato/orchestration";

type Writer = Pick<NodeJS.WritableStream, "write">;

export interface RunPlatoSmokeOptions {
  cwd?: string;
  stdout?: Writer;
  stderr?: Writer;
}

export interface PlatoSmokeSummary {
  taskId: string;
  workspacePath: string;
  checks: {
    started: boolean;
    statusReadable: boolean;
    eventsReadable: boolean;
    listed: boolean;
  };
  eventTypes: string[];
}

export async function runPlatoSmoke(options: RunPlatoSmokeOptions = {}): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const client = new SmokeOrchestrationClient();
  const taskId = "plato-smoke-task";
  const workspacePath = options.cwd ?? process.env.INIT_CWD ?? process.cwd();
  const prompt = "Run Plato deterministic smoke task";

  try {
    const started = await runSmokeCommand([
      "task",
      "start",
      "--task-id",
      taskId,
      "--workspace-path",
      workspacePath,
      "--prompt",
      prompt,
    ], client);
    const status = await runSmokeCommand(["task", "status", "--task-id", taskId], client);
    const events = await runSmokeCommand(["task", "events", "--task-id", taskId], client);
    const tasks = await runSmokeCommand(["task", "list"], client);

    const eventTypes = eventList(events).map((event) => event.type);
    const summary: PlatoSmokeSummary = {
      taskId,
      workspacePath,
      checks: {
        started: isTask(started) && started.taskId === taskId,
        statusReadable: isTask(status) && status.taskId === taskId,
        eventsReadable: eventTypes.includes("task.queued") && eventTypes.includes("task.completed"),
        listed: taskList(tasks).some((task) => task.taskId === taskId),
      },
      eventTypes,
    };

    const failedChecks = Object.entries(summary.checks)
      .filter(([, passed]) => !passed)
      .map(([name]) => name);
    if (failedChecks.length > 0) {
      throw new Error(`Smoke checks failed: ${failedChecks.join(", ")}`);
    }

    stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function runSmokeCommand(argv: string[], client: OrchestrationClient): Promise<unknown> {
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();
  const exitCode = await runPlatoCli(argv, { client, stdout, stderr });
  if (exitCode !== 0) {
    throw new Error(stderr.text.trim() || `Smoke command failed: ${argv.join(" ")}`);
  }
  return JSON.parse(stdout.text) as unknown;
}

class SmokeOrchestrationClient implements OrchestrationClient {
  readonly #tasks = new Map<string, OrchestrationTaskRecord>();
  readonly #events = new Map<string, OrchestrationEvent[]>();

  async startTask(input: StartOrchestrationTaskInput): Promise<OrchestrationTaskRecord> {
    const task: OrchestrationTaskRecord = {
      taskId: input.taskId,
      workspacePath: input.workspacePath,
      prompt: input.prompt,
      priority: input.priority ?? 0,
      state: "completed",
      execution: {
        runtimeId: input.agent?.runtimeId ?? "smoke",
        backend: "smoke",
        backendTaskId: input.taskId,
      },
    };
    this.#tasks.set(task.taskId, task);
    this.#events.set(task.taskId, [
      smokeEvent(task, "task.queued"),
      smokeEvent(task, "task.started"),
      smokeEvent(task, "task.completed"),
    ]);
    return task;
  }

  async createTaskGraph(input: CreateOrchestrationGraphInput): Promise<OrchestrationTaskGraphSnapshot> {
    const parent = await this.startTask(input.parent);
    const children = await Promise.all(input.children.map((child) =>
      this.startTask({
        taskId: child.taskId,
        workspacePath: child.workspacePath ?? input.parent.workspacePath,
        prompt: child.prompt,
        priority: child.priority,
        agent: input.parent.agent,
        contextPackage: child.contextPackage,
      })
    ));
    return { parent, children, state: "completed" };
  }

  async getTask(taskId: string): Promise<OrchestrationTaskRecord | undefined> {
    return this.#tasks.get(taskId);
  }

  async getTaskGraph(taskId: string): Promise<OrchestrationTaskGraphSnapshot | undefined> {
    const task = this.#tasks.get(taskId);
    return task ? { parent: task, children: [], state: task.state } : undefined;
  }

  async getTaskGraphResults(taskId: string): Promise<OrchestrationTaskGraphResultSnapshot | undefined> {
    return {
      parentTaskId: taskId,
      results: [],
      synthesis: {
        synthesisId: `${taskId}-smoke-synthesis`,
        parentTaskId: taskId,
        classification: "completed",
        summary: "Deterministic smoke task completed.",
        childTaskCount: 0,
        resultIds: [],
      },
    };
  }

  async listTasks(selector?: AgentRuntimeSelector): Promise<OrchestrationTaskRecord[]> {
    const tasks = [...this.#tasks.values()];
    return selector ? tasks.filter((task) => task.execution.runtimeId === selector.runtimeId) : tasks;
  }

  async listEvents(taskId: string): Promise<OrchestrationEvent[]> {
    return this.#events.get(taskId) ?? [];
  }

  async interruptTask(taskId: string): Promise<void> {
    await this.#updateTaskState(taskId, "interrupted");
  }

  async resumeTask(taskId: string): Promise<OrchestrationTaskRecord> {
    return this.#updateTaskState(taskId, "completed");
  }

  async approveTaskAction(taskId: string): Promise<OrchestrationTaskRecord> {
    return this.#requireTask(taskId);
  }

  async rejectTaskAction(taskId: string): Promise<OrchestrationTaskRecord> {
    return this.#updateTaskState(taskId, "failed");
  }

  async #updateTaskState(
    taskId: string,
    state: OrchestrationTaskRecord["state"],
  ): Promise<OrchestrationTaskRecord> {
    const task = {
      ...this.#requireTask(taskId),
      state,
    };
    this.#tasks.set(taskId, task);
    return task;
  }

  #requireTask(taskId: string): OrchestrationTaskRecord {
    const task = this.#tasks.get(taskId);
    if (!task) {
      throw new Error(`task '${taskId}' was not found`);
    }
    return task;
  }
}

class MemoryWriter {
  text = "";

  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

function smokeEvent(task: OrchestrationTaskRecord, type: string): OrchestrationEvent {
  return {
    taskId: task.taskId,
    type,
    runtimeId: task.execution.runtimeId,
    backend: task.execution.backend,
  };
}

function isTask(value: unknown): value is OrchestrationTaskRecord {
  return Boolean(value && typeof value === "object" && "taskId" in value);
}

function taskList(value: unknown): OrchestrationTaskRecord[] {
  return Array.isArray(value) ? value.filter(isTask) : [];
}

function eventList(value: unknown): OrchestrationEvent[] {
  return Array.isArray(value) ? value.filter((event): event is OrchestrationEvent =>
    Boolean(event && typeof event === "object" && "type" in event)
  ) : [];
}
