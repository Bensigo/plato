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
  graphTaskId: string;
  workspacePath: string;
  checks: {
    started: boolean;
    statusReadable: boolean;
    eventsReadable: boolean;
    listed: boolean;
    graphStarted: boolean;
    graphStatusReadable: boolean;
    graphResultsReadable: boolean;
    graphEventsReadable: boolean;
    interrupted: boolean;
    resumed: boolean;
    interruptResumeEventsReadable: boolean;
  };
  eventTypes: string[];
  graphEventTypes: string[];
}

export async function runPlatoSmoke(options: RunPlatoSmokeOptions = {}): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const client = new SmokeOrchestrationClient();
  const taskId = "plato-smoke-task";
  const graphTaskId = "plato-smoke-graph";
  const workspacePath = options.cwd ?? process.env.INIT_CWD ?? process.cwd();
  const prompt = "Run Plato deterministic smoke task";
  const children = [
    {
      taskId: "plato-smoke-graph-child-a",
      prompt: "Inspect deterministic graph child A",
      contextPackage: { summary: "smoke child a" },
    },
    {
      taskId: "plato-smoke-graph-child-b",
      prompt: "Inspect deterministic graph child B",
      dependencyTaskIds: ["plato-smoke-graph-child-a"],
      contextPackage: { summary: "smoke child b" },
    },
  ];

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
    const graphStarted = await runSmokeCommand([
      "graph",
      "start",
      "--task-id",
      graphTaskId,
      "--workspace-path",
      workspacePath,
      "--prompt",
      "Run Plato deterministic smoke graph",
      "--children-json",
      JSON.stringify(children),
    ], client);
    const graphStatus = await runSmokeCommand(["graph", "status", "--task-id", graphTaskId], client);
    const graphResults = await runSmokeCommand(["graph", "results", "--task-id", graphTaskId], client);
    const graphEvents = await runSmokeCommand(["task", "events", "--task-id", graphTaskId], client);
    const interrupted = await runSmokeCommand(["task", "interrupt", "--task-id", taskId], client);
    const resumed = await runSmokeCommand(["task", "resume", "--task-id", taskId], client);
    const controlEvents = await runSmokeCommand(["task", "events", "--task-id", taskId], client);

    const eventTypes = eventList(events).map((event) => event.type);
    const graphEventTypes = eventList(graphEvents).map((event) => event.type);
    const controlEventTypes = eventList(controlEvents).map((event) => event.type);
    const resultSnapshot = graphResultSnapshot(graphResults);
    const summary: PlatoSmokeSummary = {
      taskId,
      graphTaskId,
      workspacePath,
      checks: {
        started: isTask(started) && started.taskId === taskId,
        statusReadable: isTask(status) && status.taskId === taskId,
        eventsReadable: eventTypes.includes("task.queued") && eventTypes.includes("task.completed"),
        listed: taskList(tasks).some((task) => task.taskId === taskId),
        graphStarted: isGraph(graphStarted)
          && graphStarted.parent.taskId === graphTaskId
          && graphStarted.children.length === children.length,
        graphStatusReadable: isGraph(graphStatus) && graphStatus.parent.taskId === graphTaskId,
        graphResultsReadable: resultSnapshot !== undefined
          && resultSnapshot.results.length === children.length
          && resultSnapshot.synthesis?.classification === "completed",
        graphEventsReadable: graphEventTypes.includes("task.graph.created")
          && graphEventTypes.includes("task.graph.result.collected")
          && graphEventTypes.includes("task.graph.synthesized")
          && graphEventTypes.includes("task.graph.completed"),
        interrupted: isInterruptResult(interrupted) && interrupted.taskId === taskId,
        resumed: isTask(resumed) && resumed.taskId === taskId && resumed.state === "running",
        interruptResumeEventsReadable: controlEventTypes.includes("task.interrupted")
          && controlEventTypes.includes("task.resumed"),
      },
      eventTypes,
      graphEventTypes,
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
  readonly #graphs = new Map<string, OrchestrationTaskGraphSnapshot>();
  readonly #graphResults = new Map<string, OrchestrationTaskGraphResultSnapshot>();

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
    const graph = { parent, children, state: "completed" as const };
    this.#graphs.set(parent.taskId, graph);
    this.#graphResults.set(parent.taskId, {
      parentTaskId: parent.taskId,
      results: children.map((child) => ({
        resultId: `${child.taskId}-smoke-result`,
        taskId: child.taskId,
        parentTaskId: parent.taskId,
        classification: "completed",
        summary: `Deterministic smoke result for ${child.taskId}.`,
        metadata: {
          dependencyTaskIds: input.children.find((candidate) =>
            candidate.taskId === child.taskId
          )?.dependencyTaskIds ?? [],
        },
      })),
      synthesis: {
        synthesisId: `${parent.taskId}-smoke-synthesis`,
        parentTaskId: parent.taskId,
        classification: "completed",
        summary: `Synthesized ${children.length} deterministic smoke results.`,
        childTaskCount: children.length,
        resultIds: children.map((child) => `${child.taskId}-smoke-result`),
      },
    });
    this.#appendEvents(parent.taskId, [
      smokeEvent(parent, "task.graph.created", {
        graphState: "queued",
        message: `Created task graph with ${children.length} child tasks`,
      }),
      ...children.map((child) => smokeEvent(parent, "task.graph.result.collected", {
        childTaskId: child.taskId,
        graphState: "running",
        resultId: `${child.taskId}-smoke-result`,
        resultClassification: "completed",
      })),
      smokeEvent(parent, "task.graph.synthesized", {
        graphState: "completed",
        synthesisId: `${parent.taskId}-smoke-synthesis`,
        resultClassification: "completed",
      }),
      smokeEvent(parent, "task.graph.completed", {
        graphState: "completed",
        resultClassification: "completed",
      }),
    ]);
    return graph;
  }

  async getTask(taskId: string): Promise<OrchestrationTaskRecord | undefined> {
    return this.#tasks.get(taskId);
  }

  async getTaskGraph(taskId: string): Promise<OrchestrationTaskGraphSnapshot | undefined> {
    const graph = this.#graphs.get(taskId);
    if (graph) {
      return {
        ...graph,
        parent: this.#requireTask(graph.parent.taskId),
        children: graph.children.map((child) => this.#requireTask(child.taskId)),
      };
    }
    const task = this.#tasks.get(taskId);
    return task ? { parent: task, children: [], state: task.state } : undefined;
  }

  async getTaskGraphResults(taskId: string): Promise<OrchestrationTaskGraphResultSnapshot | undefined> {
    const results = this.#graphResults.get(taskId);
    if (results) {
      return results;
    }
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
    const task = await this.#updateTaskState(taskId, "interrupted");
    this.#appendEvents(taskId, [smokeEvent(task, "task.interrupted")]);
  }

  async resumeTask(taskId: string): Promise<OrchestrationTaskRecord> {
    const task = await this.#updateTaskState(taskId, "running");
    this.#appendEvents(taskId, [smokeEvent(task, "task.resumed")]);
    return task;
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

  #appendEvents(taskId: string, events: OrchestrationEvent[]): void {
    this.#events.set(taskId, [...(this.#events.get(taskId) ?? []), ...events]);
  }
}

class MemoryWriter {
  text = "";

  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

function smokeEvent(
  task: OrchestrationTaskRecord,
  type: string,
  extra: Partial<OrchestrationEvent> = {},
): OrchestrationEvent {
  return {
    taskId: task.taskId,
    type,
    runtimeId: task.execution.runtimeId,
    backend: task.execution.backend,
    ...extra,
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

function isGraph(value: unknown): value is OrchestrationTaskGraphSnapshot {
  return Boolean(
    value
    && typeof value === "object"
    && "parent" in value
    && "children" in value
    && Array.isArray((value as { children?: unknown }).children),
  );
}

function graphResultSnapshot(value: unknown): OrchestrationTaskGraphResultSnapshot | undefined {
  return Boolean(value && typeof value === "object" && "results" in value)
    ? value as OrchestrationTaskGraphResultSnapshot
    : undefined;
}

function isInterruptResult(value: unknown): value is { taskId: string; interrupted: boolean } {
  return Boolean(value && typeof value === "object" && "interrupted" in value);
}
