import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type {
  AgentRuntimeSelector,
  CreateOrchestrationGraphInput,
  OrchestrationEvent,
  OrchestrationTaskGraphResultSnapshot,
  OrchestrationTaskGraphSnapshot,
  OrchestrationTaskRecord,
  OrchestrationTaskState,
  StartOrchestrationTaskInput,
} from "@plato/orchestration";

export interface OrchestrationClient {
  startTask(input: StartOrchestrationTaskInput): Promise<OrchestrationTaskRecord>;
  createTaskGraph(input: CreateOrchestrationGraphInput): Promise<OrchestrationTaskGraphSnapshot>;
  getTask(taskId: string, selector?: AgentRuntimeSelector): Promise<OrchestrationTaskRecord | undefined>;
  getTaskGraph(
    taskId: string,
    selector?: AgentRuntimeSelector,
  ): Promise<OrchestrationTaskGraphSnapshot | undefined>;
  getTaskGraphResults(
    taskId: string,
    selector?: AgentRuntimeSelector,
  ): Promise<OrchestrationTaskGraphResultSnapshot | undefined>;
  listTasks(selector?: AgentRuntimeSelector): Promise<OrchestrationTaskRecord[]>;
  listEvents(taskId: string, selector?: AgentRuntimeSelector): Promise<OrchestrationEvent[]>;
  interruptTask(taskId: string, selector?: AgentRuntimeSelector): Promise<void>;
  resumeTask(taskId: string, selector?: AgentRuntimeSelector): Promise<OrchestrationTaskRecord>;
  approveTaskAction(taskId: string, selector?: AgentRuntimeSelector): Promise<OrchestrationTaskRecord>;
  rejectTaskAction(
    taskId: string,
    reason: string,
    selector?: AgentRuntimeSelector,
  ): Promise<OrchestrationTaskRecord>;
}

export interface PlatoCliOptions {
  client: OrchestrationClient;
  stdout?: Pick<NodeJS.WritableStream, "write">;
  stderr?: Pick<NodeJS.WritableStream, "write">;
}

const runtimeIdSchema = z.string().min(1).optional();
const taskStateSchema = z
  .enum(["queued", "running", "awaiting_approval", "interrupted", "completed", "failed"])
  .optional();
const taskIdSchema = z.string().min(1);
const workspacePathSchema = z.string().min(1);
const promptSchema = z.string().min(1);

const contextPackageSchema = z.any().optional();

const startTaskSchema = z.object({
  taskId: taskIdSchema,
  workspacePath: workspacePathSchema,
  prompt: promptSchema,
  priority: z.number().int().optional(),
  runtimeId: runtimeIdSchema,
  contextPackage: contextPackageSchema,
});

const graphChildSchema = z.object({
  taskId: taskIdSchema,
  workspacePath: workspacePathSchema.optional(),
  prompt: promptSchema,
  priority: z.number().int().optional(),
  dependencyTaskIds: z.array(taskIdSchema).optional(),
  contextPackage: contextPackageSchema,
});

const createGraphSchema = z.object({
  parent: startTaskSchema,
  children: z.array(graphChildSchema).min(1),
});

const taskLookupSchema = z.object({
  taskId: taskIdSchema,
  runtimeId: runtimeIdSchema,
});

const listTasksSchema = z.object({
  runtimeId: runtimeIdSchema,
  state: taskStateSchema,
});

const rejectSchema = taskLookupSchema.extend({
  reason: z.string().min(1),
});

export function createPlatoMcpServer(client: OrchestrationClient): McpServer {
  const server = new McpServer({
    name: "plato",
    version: "0.1.0",
  });

  registerTool(server, "plato.start_task", startTaskSchema, (input) =>
    client.startTask(startTaskInputFromSurfaceInput(input)),
  );
  registerTool(server, "plato.create_task_graph", createGraphSchema, (input) =>
    client.createTaskGraph(graphInputFromSurfaceInput(input)),
  );
  registerTool(server, "plato.get_task", taskLookupSchema, async (input) =>
    requireFound(await client.getTask(input.taskId, selectorFrom(input)), input.taskId),
  );
  registerTool(server, "plato.list_tasks", listTasksSchema, async (input) =>
    filterTasksByState(await client.listTasks(selectorFrom(input)), input.state),
  );
  registerTool(server, "plato.get_task_graph", taskLookupSchema, async (input) =>
    requireFound(await client.getTaskGraph(input.taskId, selectorFrom(input)), input.taskId),
  );
  registerTool(server, "plato.get_task_graph_results", taskLookupSchema, async (input) =>
    requireFound(await client.getTaskGraphResults(input.taskId, selectorFrom(input)), input.taskId),
  );
  registerTool(server, "plato.list_task_events", taskLookupSchema, (input) =>
    client.listEvents(input.taskId, selectorFrom(input)),
  );
  registerTool(server, "plato.interrupt_task", taskLookupSchema, async (input) => {
    await client.interruptTask(input.taskId, selectorFrom(input));
    return { taskId: input.taskId, interrupted: true };
  });
  registerTool(server, "plato.resume_task", taskLookupSchema, (input) =>
    client.resumeTask(input.taskId, selectorFrom(input)),
  );
  registerTool(server, "plato.approve_task_action", taskLookupSchema, (input) =>
    client.approveTaskAction(input.taskId, selectorFrom(input)),
  );
  registerTool(server, "plato.reject_task_action", rejectSchema, (input) =>
    client.rejectTaskAction(input.taskId, input.reason, selectorFrom(input)),
  );

  server.registerResource(
    "tasks",
    "plato://tasks",
    { title: "Plato tasks", mimeType: "application/json" },
    async () => jsonResource("plato://tasks", await client.listTasks()),
  );
  server.registerResource(
    "approvals",
    "plato://approvals",
    { title: "Plato approval queue", mimeType: "application/json" },
    async () =>
      jsonResource(
        "plato://approvals",
        (await client.listTasks()).filter((task) => task.state === "awaiting_approval"),
      ),
  );
  server.registerResource(
    "task",
    new ResourceTemplate("plato://tasks/{taskId}", { list: undefined }),
    { title: "Plato task", mimeType: "application/json" },
    async (uri, variables) => {
      const taskId = templateValue(variables.taskId);
      return jsonResource(uri.href, requireFound(await client.getTask(taskId), taskId));
    },
  );
  server.registerResource(
    "task-events",
    new ResourceTemplate("plato://tasks/{taskId}/events", { list: undefined }),
    { title: "Plato task events", mimeType: "application/json" },
    async (uri, variables) => jsonResource(uri.href, await client.listEvents(templateValue(variables.taskId))),
  );
  server.registerResource(
    "graph",
    new ResourceTemplate("plato://graphs/{taskId}", { list: undefined }),
    { title: "Plato task graph", mimeType: "application/json" },
    async (uri, variables) => {
      const taskId = templateValue(variables.taskId);
      return jsonResource(uri.href, requireFound(await client.getTaskGraph(taskId), taskId));
    },
  );
  server.registerResource(
    "graph-results",
    new ResourceTemplate("plato://graphs/{taskId}/results", { list: undefined }),
    { title: "Plato graph results", mimeType: "application/json" },
    async (uri, variables) => {
      const taskId = templateValue(variables.taskId);
      return jsonResource(uri.href, requireFound(await client.getTaskGraphResults(taskId), taskId));
    },
  );

  return server;
}

export async function runPlatoCli(argv: string[], options: PlatoCliOptions): Promise<number> {
  try {
    const result = await runCommand(argv, options.client);
    writeJson(options.stdout ?? process.stdout, result);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    (options.stderr ?? process.stderr).write(`${message}\n`);
    return 1;
  }
}

async function runCommand(argv: string[], client: OrchestrationClient): Promise<unknown> {
  const [domain, command, ...rest] = argv;
  if (domain === "task") {
    return runTaskCommand(command, rest, client);
  }
  if (domain === "graph") {
    return runGraphCommand(command, rest, client);
  }
  throw new Error("usage: plato task|graph <command>");
}

async function runTaskCommand(
  command: string | undefined,
  argv: string[],
  client: OrchestrationClient,
): Promise<unknown> {
  const flags = parseFlags(argv);
  const selector = selectorFrom({ runtimeId: flags["runtime-id"] });
  switch (command) {
    case "start":
      return client.startTask({
        taskId: requireFlag(flags, "task-id"),
        workspacePath: requireFlag(flags, "workspace-path"),
        prompt: requireFlag(flags, "prompt"),
        priority: optionalInteger(flags.priority, "priority"),
        agent: selector,
      });
    case "status":
      return requireFound(await client.getTask(requireFlag(flags, "task-id"), selector), flags["task-id"]);
    case "list":
      return filterTasksByState(await client.listTasks(selector), parseOptionalTaskState(flags.state));
    case "events":
      return client.listEvents(requireFlag(flags, "task-id"), selector);
    case "interrupt":
      await client.interruptTask(requireFlag(flags, "task-id"), selector);
      return { taskId: flags["task-id"], interrupted: true };
    case "resume":
      return client.resumeTask(requireFlag(flags, "task-id"), selector);
    case "approve":
      return client.approveTaskAction(requireFlag(flags, "task-id"), selector);
    case "reject":
      return client.rejectTaskAction(requireFlag(flags, "task-id"), requireFlag(flags, "reason"), selector);
    default:
      throw new Error("usage: plato task start|status|list|events|interrupt|resume|approve|reject");
  }
}

async function runGraphCommand(
  command: string | undefined,
  argv: string[],
  client: OrchestrationClient,
): Promise<unknown> {
  const flags = parseFlags(argv);
  const selector = selectorFrom({ runtimeId: flags["runtime-id"] });
  switch (command) {
    case "start":
      return client.createTaskGraph(parseGraphInput(flags, selector));
    case "status":
      return requireFound(await client.getTaskGraph(requireFlag(flags, "task-id"), selector), flags["task-id"]);
    case "results":
    case "synthesis":
      return requireFound(
        await client.getTaskGraphResults(requireFlag(flags, "task-id"), selector),
        flags["task-id"],
      );
    default:
      throw new Error("usage: plato graph start|status|results|synthesis");
  }
}

function parseGraphInput(
  flags: Record<string, string>,
  selector: AgentRuntimeSelector | undefined,
): CreateOrchestrationGraphInput {
  const childrenRaw = requireFlag(flags, "children-json");
  const children = JSON.parse(childrenRaw) as unknown;
  return graphInputFromSurfaceInput(createGraphSchema.parse({
    parent: {
      taskId: requireFlag(flags, "task-id"),
      workspacePath: requireFlag(flags, "workspace-path"),
      prompt: requireFlag(flags, "prompt"),
      priority: optionalInteger(flags.priority, "priority"),
      runtimeId: selector?.runtimeId,
    },
    children,
  }));
}

function registerTool<T extends z.ZodType>(
  server: McpServer,
  name: string,
  schema: T,
  handler: (input: z.infer<T>) => Promise<unknown> | unknown,
): void {
  (server.registerTool as unknown as (
    toolName: string,
    config: { inputSchema: T },
    cb: (input: z.infer<T>) => Promise<CallToolResult>,
  ) => void)(
    name,
    {
      inputSchema: schema,
    },
    async (input) => toolResult(await handler(input as z.infer<T>)),
  );
}

function toolResult(value: unknown): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value),
      },
    ],
    structuredContent: isRecord(value) ? value : { result: value },
  };
}

function jsonResource(uri: string, value: unknown): ReadResourceResult {
  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(value),
      },
    ],
  };
}

function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) {
      throw new Error(`unexpected argument: ${token}`);
    }
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`missing value for --${key}`);
    }
    flags[key] = value;
    index += 1;
  }
  return flags;
}

function requireFlag(flags: Record<string, string>, name: string): string {
  const value = flags[name]?.trim();
  if (!value) {
    throw new Error(`missing required --${name}`);
  }
  return value;
}

function optionalInteger(value: string | undefined, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || `${parsed}` !== value) {
    throw new Error(`${label} must be an integer`);
  }
  return parsed;
}

function selectorFrom(input: { runtimeId?: string }): AgentRuntimeSelector | undefined {
  return input.runtimeId ? { runtimeId: input.runtimeId } : undefined;
}

function filterTasksByState(
  tasks: OrchestrationTaskRecord[],
  state: OrchestrationTaskState | undefined,
): OrchestrationTaskRecord[] {
  return state ? tasks.filter((task) => task.state === state) : tasks;
}

function parseOptionalTaskState(value: string | undefined): OrchestrationTaskState | undefined {
  if (value === undefined) {
    return undefined;
  }
  return taskStateSchema.unwrap().parse(value);
}

function startTaskInputFromSurfaceInput(input: z.infer<typeof startTaskSchema>): StartOrchestrationTaskInput {
  const { runtimeId, ...taskInput } = input;
  return {
    ...taskInput,
    agent: selectorFrom({ runtimeId }),
  };
}

function graphInputFromSurfaceInput(input: z.infer<typeof createGraphSchema>): CreateOrchestrationGraphInput {
  const { runtimeId, ...parent } = input.parent;
  return {
    parent: {
      ...parent,
      agent: selectorFrom({ runtimeId }),
    },
    children: input.children,
  };
}

function requireFound<T>(value: T | undefined, taskId: string): T {
  if (!value) {
    throw new Error(`task '${taskId}' was not found`);
  }
  return value;
}

function templateValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  if (!value) {
    throw new Error("resource URI is missing taskId");
  }
  return value;
}

function writeJson(stream: Pick<NodeJS.WritableStream, "write">, value: unknown): void {
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
