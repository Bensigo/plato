import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type {
  AgentRuntimeSelector,
  CreateOrchestrationGraphInput,
  OrchestrationEvent,
  OrchestrationContextPackageInput,
  OrchestrationPlanValidationResult,
  OrchestrationSurfaceToolDescriptor,
  OrchestrationTaskDecompositionPlan,
  OrchestrationTaskGraphResultSnapshot,
  OrchestrationTaskGraphSnapshot,
  OrchestrationTaskPlanningInput,
  OrchestrationTaskRecord,
  OrchestrationTaskState,
  OrchestrationToolHarnessDescriptor,
  StartOrchestrationTaskInput,
} from "@plato/orchestration";
import {
  DEFAULT_ORCHESTRATION_TOOL_HARNESS_CATALOG,
  ORCHESTRATION_SURFACE_TOOLS,
  buildOrchestrationGraphReviewSnapshot,
  buildOrchestrationPlanReviewSnapshot,
  createTaskDecompositionPlan,
  createValidatedGraphInputFromDecompositionPlan,
  validateTaskDecompositionPlan,
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

const documentationSourceSchema = z.object({
  sourceId: z.string().min(1),
  kind: z.enum(["context7", "url", "other"]),
  label: z.string().min(1),
  uri: z.string().min(1),
  version: z.string().min(1).optional(),
  checkedAt: z.string().min(1).optional(),
  summary: z.string().min(1).optional(),
});

const documentationRequirementSchema = z.object({
  requirementId: z.string().min(1),
  label: z.string().min(1),
  reason: z.string().min(1),
  sources: z.array(documentationSourceSchema),
  gaps: z.array(z.string().min(1)).optional(),
});

const writeScopeSchema = z.object({
  paths: z.array(z.string().min(1)),
  exclusive: z.boolean().optional(),
});

const verificationPlanSchema = z.object({
  commands: z.array(z.string().min(1)),
  acceptanceCriteria: z.array(z.string().min(1)),
});

const startTaskSchema = z.object({
  taskId: taskIdSchema,
  workspacePath: workspacePathSchema,
  prompt: promptSchema,
  priority: z.number().int().optional(),
  runtimeId: runtimeIdSchema,
  contextPackage: contextPackageSchema,
});

const taskPlanningSchema = startTaskSchema.extend({
  planId: z.string().min(1).optional(),
  summary: z.string().min(1).optional(),
  milestoneId: z.string().min(1).optional(),
  documentation: z.array(documentationRequirementSchema).optional(),
  writeScopePaths: z.array(z.string().min(1)).optional(),
  verificationCommands: z.array(z.string().min(1)).optional(),
  acceptanceCriteria: z.array(z.string().min(1)).optional(),
});

const delegateTaskPlanSchema = taskPlanningSchema;

const planParentSchema = startTaskSchema.extend({
  agent: z.object({ runtimeId: z.string().min(1) }).optional(),
});

const graphChildSchema = z.object({
  taskId: taskIdSchema,
  workspacePath: workspacePathSchema.optional(),
  prompt: promptSchema,
  priority: z.number().int().optional(),
  dependencyTaskIds: z.array(taskIdSchema).optional(),
  contextPackage: contextPackageSchema,
});

const plannedGraphChildSchema = graphChildSchema.extend({
  objective: z.string().min(1),
  writeScope: writeScopeSchema,
  allowedToolNames: z.array(z.string().min(1)),
  verification: verificationPlanSchema,
  riskLevel: z.enum(["low", "medium", "high"]),
  requiresApproval: z.boolean().optional(),
  requiredDocumentation: z.array(documentationRequirementSchema).optional(),
});

const createGraphSchema = z.object({
  parent: startTaskSchema,
  children: z.array(graphChildSchema).min(1),
});

const taskGraphPlanSchema = z.object({
  planId: z.string().min(1),
  summary: z.string().min(1),
  parent: planParentSchema,
  children: z.array(plannedGraphChildSchema).min(1),
  documentation: z.array(documentationRequirementSchema).optional(),
});

const planTaskGraphInputSchema = z.union([taskGraphPlanSchema, taskPlanningSchema]);

const validateTaskGraphPlanSchema = z.object({
  plan: taskGraphPlanSchema,
});

const taskLookupSchema = z.object({
  taskId: taskIdSchema,
  runtimeId: runtimeIdSchema,
});

const reviewTaskGraphPlanSchema = validateTaskGraphPlanSchema;

const listTasksSchema = z.object({
  runtimeId: runtimeIdSchema,
  state: taskStateSchema,
});

const rejectSchema = taskLookupSchema.extend({
  reason: z.string().min(1),
});

type PlatoToolDescriptor =
  | OrchestrationSurfaceToolDescriptor
  | {
      name: "plato.delegate_task_plan";
      operation: "delegate_task_plan";
      description: string;
      readOnly: true;
    }
  | {
      name: "plato.list_tools";
      operation: "list_tools";
      description: string;
      readOnly: true;
    }
  | {
      name: "plato.review_task_graph_plan";
      operation: "review_task_graph_plan";
      description: string;
      readOnly: true;
    }
  | {
      name: "plato.review_task_graph";
      operation: "review_task_graph";
      description: string;
      readOnly: true;
    }
  | {
      name: "plato.list_pending_approvals";
      operation: "list_pending_approvals";
      description: string;
      readOnly: true;
    };

const PLATO_TOOL_CATALOG: readonly PlatoToolDescriptor[] = [
  {
    name: "plato.delegate_task_plan",
    operation: "delegate_task_plan",
    description: "Create and validate a reviewable decomposition plan for a top-level task without execution.",
    readOnly: true,
  },
  ...ORCHESTRATION_SURFACE_TOOLS,
  {
    name: "plato.list_tools",
    operation: "list_tools",
    description: "List Plato MCP tool descriptors.",
    readOnly: true,
  },
  {
    name: "plato.review_task_graph_plan",
    operation: "review_task_graph_plan",
    description: "Summarize a task graph plan for operator review without starting execution.",
    readOnly: true,
  },
  {
    name: "plato.review_task_graph",
    operation: "review_task_graph",
    description: "Summarize worker status and final synthesis readiness for a task graph.",
    readOnly: true,
  },
  {
    name: "plato.list_pending_approvals",
    operation: "list_pending_approvals",
    description: "List tasks waiting for approval.",
    readOnly: true,
  },
];

const PLATO_ORCHESTRATION_TOOL_CATALOG: readonly OrchestrationToolHarnessDescriptor[] =
  DEFAULT_ORCHESTRATION_TOOL_HARNESS_CATALOG;

export function createPlatoMcpServer(client: OrchestrationClient): McpServer {
  const server = new McpServer({
    name: "plato",
    version: "0.1.0",
  });

  registerTool(server, "plato.start_task", startTaskSchema, (input) =>
    client.startTask(startTaskInputFromSurfaceInput(input)),
  );
  registerTool(server, "plato.delegate_task_plan", delegateTaskPlanSchema, (input) =>
    delegateTaskPlan(client, delegateTaskPlanInputFromSurfaceInput(input)),
  );
  registerTool(server, "plato.delegate_task", delegateTaskPlanSchema, (input) =>
    delegateTask(client, delegateTaskPlanInputFromSurfaceInput(input)),
  );
  registerTool(server, "plato.plan_task_graph", planTaskGraphInputSchema, (input) => {
    const plan = planTaskGraphFromSurfaceInput(input);
    return {
      plan,
      validation: validateTaskDecompositionPlan(plan),
    };
  });
  registerTool(server, "plato.validate_task_graph_plan", validateTaskGraphPlanSchema, (input) => {
    const plan = taskGraphPlanFromSurfaceInput(input.plan);
    return createValidatedGraphInputFromDecompositionPlan(plan);
  });
  registerTool(server, "plato.create_task_graph_from_plan", validateTaskGraphPlanSchema, async (input) => {
    const plan = taskGraphPlanFromSurfaceInput(input.plan);
    const { validation, graphInput } = createValidatedGraphInputFromDecompositionPlan(plan);
    if (!graphInput) {
      return { validation };
    }
    return {
      validation,
      graph: await client.createTaskGraph(graphInput),
    };
  });
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
  registerTool(server, "plato.review_task_graph_plan", reviewTaskGraphPlanSchema, (input) => {
    const plan = taskGraphPlanFromSurfaceInput(input.plan);
    return buildOrchestrationPlanReviewSnapshot(plan, validateTaskDecompositionPlan(plan));
  });
  registerTool(server, "plato.review_task_graph", taskLookupSchema, async (input) => {
    const selector = selectorFrom(input);
    const graph = requireFound(await client.getTaskGraph(input.taskId, selector), input.taskId);
    const graphResults = await client.getTaskGraphResults(input.taskId, selector);
    return buildOrchestrationGraphReviewSnapshot(graph, graphResults);
  });
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
  registerTool(server, "plato.list_pending_approvals", listTasksSchema, async (input) =>
    filterTasksByState(await client.listTasks(selectorFrom(input)), "awaiting_approval"),
  );
  registerTool(server, "plato.list_tools", z.object({}), () => listToolCatalog());
  registerTool(server, "plato.list_orchestration_tools", z.object({}), () => listOrchestrationToolCatalog());

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
    "review-approvals",
    "plato://reviews/approvals",
    { title: "Plato review approval queue", mimeType: "application/json" },
    async () =>
      jsonResource(
        "plato://reviews/approvals",
        filterTasksByState(await client.listTasks(), "awaiting_approval"),
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
  server.registerResource(
    "graph-review",
    new ResourceTemplate("plato://reviews/graphs/{taskId}", { list: undefined }),
    { title: "Plato task graph review", mimeType: "application/json" },
    async (uri, variables) => {
      const taskId = templateValue(variables.taskId);
      const graph = requireFound(await client.getTaskGraph(taskId), taskId);
      const graphResults = await client.getTaskGraphResults(taskId);
      return jsonResource(uri.href, buildOrchestrationGraphReviewSnapshot(graph, graphResults));
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
  if (domain === "delegate") {
    return runDelegateCommand(command, rest, client);
  }
  if (domain === "review") {
    return runReviewCommand(command, rest, client);
  }
  if (domain === "tool") {
    return runToolCommand(command, rest);
  }
  throw new Error("usage: plato task|graph|delegate|review|tool <command>");
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

async function runDelegateCommand(
  command: string | undefined,
  argv: string[],
  client: OrchestrationClient,
): Promise<unknown> {
  const flags = parseFlags(argv);
  const selector = selectorFrom({ runtimeId: flags["runtime-id"] });
  switch (command) {
    case "plan":
      return delegateTaskPlan(client, {
        taskId: requireFlag(flags, "task-id"),
        workspacePath: requireFlag(flags, "workspace-path"),
        prompt: requireFlag(flags, "prompt"),
        priority: optionalInteger(flags.priority, "priority"),
        agent: selector,
        contextPackage: parseOptionalContextPackage(flags["context-json"]),
        planId: flags["plan-id"],
        milestoneId: flags["milestone-id"],
        writeScopePaths: parseOptionalCsv(flags["write-scope"]),
        verificationCommands: parseOptionalCsv(flags["verification-command"]),
      });
    case "start":
      return delegateTask(client, {
        taskId: requireFlag(flags, "task-id"),
        workspacePath: requireFlag(flags, "workspace-path"),
        prompt: requireFlag(flags, "prompt"),
        priority: optionalInteger(flags.priority, "priority"),
        agent: selector,
        contextPackage: parseOptionalContextPackage(flags["context-json"]),
        planId: flags["plan-id"],
        milestoneId: flags["milestone-id"],
        writeScopePaths: parseOptionalCsv(flags["write-scope"]),
        verificationCommands: parseOptionalCsv(flags["verification-command"]),
      });
    default:
      throw new Error("usage: plato delegate plan|start");
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
    case "plan": {
      const plan = parseTaskGraphPlan(requireFlag(flags, "plan-json"), selector);
      return {
        plan,
        validation: validateTaskDecompositionPlan(plan),
      };
    }
    case "validate": {
      const plan = parseTaskGraphPlan(requireFlag(flags, "plan-json"), selector);
      return createValidatedGraphInputFromDecompositionPlan(plan);
    }
    case "start-plan": {
      const plan = parseTaskGraphPlan(requireFlag(flags, "plan-json"), selector);
      const { validation, graphInput } = createValidatedGraphInputFromDecompositionPlan(plan);
      if (!graphInput) {
        return { validation };
      }
      return {
        validation,
        graph: await client.createTaskGraph(graphInput),
      };
    }
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
      throw new Error("usage: plato graph plan|validate|start-plan|start|status|results|synthesis");
  }
}

async function runReviewCommand(
  command: string | undefined,
  argv: string[],
  client: OrchestrationClient,
): Promise<unknown> {
  const flags = parseFlags(argv);
  const selector = selectorFrom({ runtimeId: flags["runtime-id"] });
  switch (command) {
    case "plan": {
      const plan = parseTaskGraphPlan(requireFlag(flags, "plan-json"), selector);
      return buildOrchestrationPlanReviewSnapshot(plan, validateTaskDecompositionPlan(plan));
    }
    case "graph": {
      const taskId = requireFlag(flags, "task-id");
      const graph = requireFound(await client.getTaskGraph(taskId, selector), taskId);
      const graphResults = await client.getTaskGraphResults(taskId, selector);
      return buildOrchestrationGraphReviewSnapshot(graph, graphResults);
    }
    case "approvals":
      return filterTasksByState(await client.listTasks(selector), "awaiting_approval");
    default:
      throw new Error("usage: plato review plan|graph|approvals");
  }
}

async function runToolCommand(command: string | undefined, argv: string[]): Promise<unknown> {
  if (argv.length > 0) {
    throw new Error("usage: plato tool catalog");
  }
  switch (command) {
    case "catalog":
      return listOrchestrationToolCatalog();
    default:
      throw new Error("usage: plato tool catalog");
  }
}

function listToolCatalog(): PlatoToolDescriptor[] {
  return PLATO_TOOL_CATALOG.map((tool) => ({ ...tool }));
}

function listOrchestrationToolCatalog(): OrchestrationToolHarnessDescriptor[] {
  return PLATO_ORCHESTRATION_TOOL_CATALOG.map((tool) => ({
    ...tool,
    failureModes: [...tool.failureModes],
  }));
}

function parseTaskGraphPlan(
  raw: string,
  selector?: AgentRuntimeSelector,
): OrchestrationTaskDecompositionPlan {
  const plan = taskGraphPlanFromSurfaceInput(taskGraphPlanSchema.parse(JSON.parse(raw) as unknown));
  return selector
    ? {
        ...plan,
        parent: {
          ...plan.parent,
          agent: selector,
        },
      }
    : plan;
}

interface DelegateTaskPlanResponse {
  plan: OrchestrationTaskDecompositionPlan;
  validation: OrchestrationPlanValidationResult;
}

interface DelegateTaskResponse extends DelegateTaskPlanResponse {
  graph?: OrchestrationTaskGraphSnapshot;
}

async function delegateTaskPlan(
  _client: OrchestrationClient,
  input: OrchestrationTaskPlanningInput,
): Promise<DelegateTaskPlanResponse> {
  const plan = createTaskDecompositionPlan(input);
  return {
    plan,
    validation: validateTaskDecompositionPlan(plan),
  };
}

async function delegateTask(
  client: OrchestrationClient,
  input: OrchestrationTaskPlanningInput,
): Promise<DelegateTaskResponse> {
  const plan = createTaskDecompositionPlan(input);
  const { validation, graphInput } = createValidatedGraphInputFromDecompositionPlan(plan);
  if (!graphInput) {
    return { plan, validation };
  }
  return {
    plan,
    validation,
    graph: await client.createTaskGraph(graphInput),
  };
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
  const descriptor = PLATO_TOOL_CATALOG.find((tool) => tool.name === name);
  (server.registerTool as unknown as (
    toolName: string,
    config: {
      description?: string;
      inputSchema: T;
      annotations?: { readOnlyHint: boolean };
    },
    cb: (input: z.infer<T>) => Promise<CallToolResult>,
  ) => void)(
    name,
    {
      description: descriptor?.description,
      inputSchema: schema,
      annotations: descriptor ? { readOnlyHint: descriptor.readOnly } : undefined,
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

function parseOptionalJson(value: string | undefined, label: string): unknown {
  if (value === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} must be valid JSON: ${detail}`);
  }
}

function parseOptionalCsv(value: string | undefined): string[] | undefined {
  return value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseOptionalContextPackage(value: string | undefined): OrchestrationContextPackageInput | undefined {
  return contextPackageSchema.parse(parseOptionalJson(value, "context-json")) as
    | OrchestrationContextPackageInput
    | undefined;
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

function delegateTaskPlanInputFromSurfaceInput(
  input: z.infer<typeof delegateTaskPlanSchema>,
): OrchestrationTaskPlanningInput {
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

function taskGraphPlanFromSurfaceInput(
  input: z.infer<typeof taskGraphPlanSchema>,
): OrchestrationTaskDecompositionPlan {
  const { runtimeId, agent, ...parent } = input.parent;
  return {
    ...input,
    parent: {
      ...parent,
      agent: selectorFrom({ runtimeId: runtimeId ?? agent?.runtimeId }),
    },
  };
}

function planTaskGraphFromSurfaceInput(
  input: z.infer<typeof planTaskGraphInputSchema>,
): OrchestrationTaskDecompositionPlan {
  return "children" in input
    ? taskGraphPlanFromSurfaceInput(input)
    : createTaskDecompositionPlan(delegateTaskPlanInputFromSurfaceInput(input));
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
