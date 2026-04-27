import type {
  AgentRuntimeSelector,
  CreateOrchestrationGraphChildInput,
  CreateOrchestrationGraphInput,
  OrchestrationPlanValidationResult,
  OrchestrationEvent,
  OrchestrationGraphState,
  OrchestrationResultClassification,
  OrchestrationTaskDecompositionPlan,
  OrchestrationTaskPlanningInput,
  OrchestrationTaskGraphResultSnapshot,
  OrchestrationTaskGraphSnapshot,
  OrchestrationTaskRecord,
  OrchestrationTaskState,
  OrchestrationToolHarnessCatalog,
  OrchestrationToolHarnessDescriptor,
  StartOrchestrationTaskInput,
} from "./index.js";
import {
  DEFAULT_ORCHESTRATION_TOOL_HARNESS_CATALOG,
  createTaskDecompositionPlan,
  createGraphInputFromDecompositionPlan,
  validateTaskDecompositionPlan,
} from "./plan.js";

export const ORCHESTRATION_SURFACE_OPERATION_NAMES = [
  "start_task",
  "plan_task_graph",
  "validate_task_graph_plan",
  "list_orchestration_tools",
  "create_task_graph",
  "get_task",
  "get_task_graph",
  "get_task_graph_results",
  "list_tasks",
  "list_task_events",
  "interrupt_task",
  "resume_task",
  "approve_task_action",
  "reject_task_action",
] as const;

export type OrchestrationSurfaceOperationName =
  (typeof ORCHESTRATION_SURFACE_OPERATION_NAMES)[number];

export interface OrchestrationSurfaceToolDescriptor {
  name: `plato.${OrchestrationSurfaceOperationName}`;
  operation: OrchestrationSurfaceOperationName;
  description: string;
  readOnly: boolean;
}

export const ORCHESTRATION_SURFACE_TOOLS: readonly OrchestrationSurfaceToolDescriptor[] = [
  {
    name: "plato.start_task",
    operation: "start_task",
    description: "Start a single orchestration task on the selected agent runtime.",
    readOnly: false,
  },
  {
    name: "plato.plan_task_graph",
    operation: "plan_task_graph",
    description: "Return a reviewable task graph plan without starting execution.",
    readOnly: true,
  },
  {
    name: "plato.validate_task_graph_plan",
    operation: "validate_task_graph_plan",
    description: "Validate a task graph plan before execution.",
    readOnly: true,
  },
  {
    name: "plato.list_orchestration_tools",
    operation: "list_orchestration_tools",
    description: "List worker tool harness descriptors that task plans may allow.",
    readOnly: true,
  },
  {
    name: "plato.create_task_graph",
    operation: "create_task_graph",
    description: "Start a parent task and child task graph on the selected agent runtime.",
    readOnly: false,
  },
  {
    name: "plato.get_task",
    operation: "get_task",
    description: "Inspect one orchestration task.",
    readOnly: true,
  },
  {
    name: "plato.get_task_graph",
    operation: "get_task_graph",
    description: "Inspect one orchestration task graph.",
    readOnly: true,
  },
  {
    name: "plato.get_task_graph_results",
    operation: "get_task_graph_results",
    description: "Inspect collected worker results and parent synthesis for a graph.",
    readOnly: true,
  },
  {
    name: "plato.list_tasks",
    operation: "list_tasks",
    description: "List orchestration tasks, optionally filtered by runtime or state.",
    readOnly: true,
  },
  {
    name: "plato.list_task_events",
    operation: "list_task_events",
    description: "List events for one orchestration task.",
    readOnly: true,
  },
  {
    name: "plato.interrupt_task",
    operation: "interrupt_task",
    description: "Interrupt one orchestration task.",
    readOnly: false,
  },
  {
    name: "plato.resume_task",
    operation: "resume_task",
    description: "Resume one interrupted orchestration task.",
    readOnly: false,
  },
  {
    name: "plato.approve_task_action",
    operation: "approve_task_action",
    description: "Approve a pending task action.",
    readOnly: false,
  },
  {
    name: "plato.reject_task_action",
    operation: "reject_task_action",
    description: "Reject a pending task action with a reason.",
    readOnly: false,
  },
];

export interface OrchestrationSurfaceStartTaskInput
  extends Omit<StartOrchestrationTaskInput, "agent"> {
  runtimeId?: string;
}

export interface OrchestrationSurfaceCreateTaskGraphParentInput
  extends Omit<StartOrchestrationTaskInput, "agent"> {
  runtimeId?: string;
}

export type OrchestrationSurfaceCreateTaskGraphChildInput =
  CreateOrchestrationGraphChildInput;

export interface OrchestrationSurfaceCreateTaskGraphInput {
  parent: OrchestrationSurfaceCreateTaskGraphParentInput;
  children: OrchestrationSurfaceCreateTaskGraphChildInput[];
}

export type OrchestrationSurfaceTaskGraphPlanInput =
  | OrchestrationTaskPlanningInput
  | OrchestrationTaskDecompositionPlan;

export interface OrchestrationSurfaceValidateTaskGraphPlanInput {
  plan: OrchestrationTaskDecompositionPlan;
}

export interface OrchestrationSurfaceTaskLookupInput {
  taskId: string;
  runtimeId?: string;
}

export interface OrchestrationSurfaceTaskListInput {
  runtimeId?: string;
  state?: OrchestrationTaskState;
}

export interface OrchestrationSurfaceRejectTaskActionInput
  extends OrchestrationSurfaceTaskLookupInput {
  reason: string;
}

export interface OrchestrationSurfaceTaskResponse {
  task: OrchestrationTaskRecord;
}

export interface OrchestrationSurfaceOptionalTaskResponse {
  task?: OrchestrationTaskRecord;
}

export interface OrchestrationSurfaceTaskGraphResponse {
  graph: OrchestrationTaskGraphSnapshot;
}

export interface OrchestrationSurfaceTaskGraphPlanResponse {
  plan: OrchestrationTaskDecompositionPlan;
  validation: OrchestrationPlanValidationResult;
}

export interface OrchestrationSurfaceTaskGraphPlanValidationResponse {
  validation: OrchestrationPlanValidationResult;
  graphInput?: CreateOrchestrationGraphInput;
}

export interface OrchestrationSurfaceToolHarnessCatalogResponse {
  tools: OrchestrationToolHarnessDescriptor[];
}

export interface OrchestrationSurfaceOptionalTaskGraphResponse {
  graph?: OrchestrationTaskGraphSnapshot;
}

export interface OrchestrationSurfaceTaskGraphResultsResponse {
  graphResults?: OrchestrationTaskGraphResultSnapshot;
}

export interface OrchestrationSurfaceTaskListResponse {
  tasks: OrchestrationTaskRecord[];
}

export interface OrchestrationSurfaceTaskEventListResponse {
  taskId: string;
  events: OrchestrationEvent[];
}

export interface OrchestrationSurfaceControlResponse {
  taskId: string;
  state: "accepted";
}

export type OrchestrationSurfaceOperationRequest =
  | { operation: "start_task"; input: OrchestrationSurfaceStartTaskInput }
  | { operation: "plan_task_graph"; input: OrchestrationSurfaceTaskGraphPlanInput }
  | { operation: "validate_task_graph_plan"; input: OrchestrationSurfaceValidateTaskGraphPlanInput }
  | { operation: "list_orchestration_tools"; input?: Record<string, never> }
  | { operation: "create_task_graph"; input: OrchestrationSurfaceCreateTaskGraphInput }
  | { operation: "get_task"; input: OrchestrationSurfaceTaskLookupInput }
  | { operation: "get_task_graph"; input: OrchestrationSurfaceTaskLookupInput }
  | { operation: "get_task_graph_results"; input: OrchestrationSurfaceTaskLookupInput }
  | { operation: "list_tasks"; input?: OrchestrationSurfaceTaskListInput }
  | { operation: "list_task_events"; input: OrchestrationSurfaceTaskLookupInput }
  | { operation: "interrupt_task"; input: OrchestrationSurfaceTaskLookupInput }
  | { operation: "resume_task"; input: OrchestrationSurfaceTaskLookupInput }
  | { operation: "approve_task_action"; input: OrchestrationSurfaceTaskLookupInput }
  | { operation: "reject_task_action"; input: OrchestrationSurfaceRejectTaskActionInput };

export type OrchestrationSurfaceOperationResponse =
  | ({ operation: "start_task" } & OrchestrationSurfaceTaskResponse)
  | ({ operation: "plan_task_graph" } & OrchestrationSurfaceTaskGraphPlanResponse)
  | ({ operation: "validate_task_graph_plan" } & OrchestrationSurfaceTaskGraphPlanValidationResponse)
  | ({ operation: "list_orchestration_tools" } & OrchestrationSurfaceToolHarnessCatalogResponse)
  | ({ operation: "create_task_graph" } & OrchestrationSurfaceTaskGraphResponse)
  | ({ operation: "get_task" } & OrchestrationSurfaceOptionalTaskResponse)
  | ({ operation: "get_task_graph" } & OrchestrationSurfaceOptionalTaskGraphResponse)
  | ({ operation: "get_task_graph_results" } & OrchestrationSurfaceTaskGraphResultsResponse)
  | ({ operation: "list_tasks" } & OrchestrationSurfaceTaskListResponse)
  | ({ operation: "list_task_events" } & OrchestrationSurfaceTaskEventListResponse)
  | ({ operation: "interrupt_task" } & OrchestrationSurfaceControlResponse)
  | ({ operation: "resume_task" } & OrchestrationSurfaceTaskResponse)
  | ({ operation: "approve_task_action" } & OrchestrationSurfaceTaskResponse)
  | ({ operation: "reject_task_action" } & OrchestrationSurfaceTaskResponse);

export interface OrchestrationSurfaceService {
  startTask(input: StartOrchestrationTaskInput): Promise<OrchestrationTaskRecord>;
  createTaskGraph(input: CreateOrchestrationGraphInput): Promise<OrchestrationTaskGraphSnapshot>;
  getTask(
    taskId: string,
    selector?: AgentRuntimeSelector,
  ): Promise<OrchestrationTaskRecord | undefined>;
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
  approveTaskAction(
    taskId: string,
    selector?: AgentRuntimeSelector,
  ): Promise<OrchestrationTaskRecord>;
  rejectTaskAction(
    taskId: string,
    reason: string,
    selector?: AgentRuntimeSelector,
  ): Promise<OrchestrationTaskRecord>;
}

export interface OrchestrationProductSurfaceOptions {
  toolCatalog?: OrchestrationToolHarnessCatalog;
}

export class OrchestrationProductSurface {
  readonly #service: OrchestrationSurfaceService;
  readonly #toolCatalog?: OrchestrationToolHarnessCatalog;

  constructor(service: OrchestrationSurfaceService, options: OrchestrationProductSurfaceOptions = {}) {
    this.#service = service;
    this.#toolCatalog = options.toolCatalog;
  }

  listTools(): OrchestrationSurfaceToolDescriptor[] {
    return ORCHESTRATION_SURFACE_TOOLS.map((tool) => ({ ...tool }));
  }

  listToolCatalog(): OrchestrationToolHarnessDescriptor[] {
    return (this.#toolCatalog ?? DEFAULT_ORCHESTRATION_TOOL_HARNESS_CATALOG).map(copyToolDescriptor);
  }

  async execute(
    request: OrchestrationSurfaceOperationRequest,
  ): Promise<OrchestrationSurfaceOperationResponse> {
    switch (request.operation) {
      case "start_task":
        return { operation: request.operation, ...(await this.startTask(request.input)) };
      case "plan_task_graph":
        return { operation: request.operation, ...(await this.planTaskGraph(request.input)) };
      case "validate_task_graph_plan":
        return { operation: request.operation, ...(await this.validateTaskGraphPlan(request.input)) };
      case "list_orchestration_tools":
        return { operation: request.operation, tools: this.listToolCatalog() };
      case "create_task_graph":
        return { operation: request.operation, ...(await this.createTaskGraph(request.input)) };
      case "get_task":
        return { operation: request.operation, ...(await this.getTask(request.input)) };
      case "get_task_graph":
        return { operation: request.operation, ...(await this.getTaskGraph(request.input)) };
      case "get_task_graph_results":
        return {
          operation: request.operation,
          ...(await this.getTaskGraphResults(request.input)),
        };
      case "list_tasks":
        return { operation: request.operation, ...(await this.listTasks(request.input)) };
      case "list_task_events":
        return { operation: request.operation, ...(await this.listTaskEvents(request.input)) };
      case "interrupt_task":
        return { operation: request.operation, ...(await this.interruptTask(request.input)) };
      case "resume_task":
        return { operation: request.operation, ...(await this.resumeTask(request.input)) };
      case "approve_task_action":
        return {
          operation: request.operation,
          ...(await this.approveTaskAction(request.input)),
        };
      case "reject_task_action":
        return {
          operation: request.operation,
          ...(await this.rejectTaskAction(request.input)),
        };
    }
  }

  async startTask(input: OrchestrationSurfaceStartTaskInput): Promise<OrchestrationSurfaceTaskResponse> {
    const task = await this.#service.startTask({
      ...input,
      agent: selectorForRuntime(input.runtimeId),
    });
    return { task };
  }

  async planTaskGraph(
    input: OrchestrationSurfaceTaskGraphPlanInput,
  ): Promise<OrchestrationSurfaceTaskGraphPlanResponse> {
    const plan = isTaskDecompositionPlan(input)
      ? input
      : createTaskDecompositionPlan(input, { toolCatalog: this.#toolCatalog });
    return {
      plan,
      validation: validateTaskDecompositionPlan(plan, { toolCatalog: this.#toolCatalog }),
    };
  }

  async validateTaskGraphPlan(
    input: OrchestrationSurfaceValidateTaskGraphPlanInput,
  ): Promise<OrchestrationSurfaceTaskGraphPlanValidationResponse> {
    const validation = validateTaskDecompositionPlan(input.plan, { toolCatalog: this.#toolCatalog });
    return {
      validation,
      graphInput: validation.valid ? createGraphInputFromDecompositionPlan(input.plan) : undefined,
    };
  }

  async createTaskGraph(
    input: OrchestrationSurfaceCreateTaskGraphInput,
  ): Promise<OrchestrationSurfaceTaskGraphResponse> {
    const graph = await this.#service.createTaskGraph({
      parent: {
        ...input.parent,
        agent: selectorForRuntime(input.parent.runtimeId),
      },
      children: input.children,
    });
    return { graph };
  }

  async getTask(
    input: OrchestrationSurfaceTaskLookupInput,
  ): Promise<OrchestrationSurfaceOptionalTaskResponse> {
    const task = await this.#service.getTask(input.taskId, selectorForRuntime(input.runtimeId));
    return { task };
  }

  async getTaskGraph(
    input: OrchestrationSurfaceTaskLookupInput,
  ): Promise<OrchestrationSurfaceOptionalTaskGraphResponse> {
    const graph = await this.#service.getTaskGraph(input.taskId, selectorForRuntime(input.runtimeId));
    return { graph };
  }

  async getTaskGraphResults(
    input: OrchestrationSurfaceTaskLookupInput,
  ): Promise<OrchestrationSurfaceTaskGraphResultsResponse> {
    const graphResults = await this.#service.getTaskGraphResults(
      input.taskId,
      selectorForRuntime(input.runtimeId),
    );
    return { graphResults };
  }

  async listTasks(input: OrchestrationSurfaceTaskListInput = {}): Promise<OrchestrationSurfaceTaskListResponse> {
    const tasks = await this.#service.listTasks(selectorForRuntime(input.runtimeId));
    return {
      tasks: input.state ? tasks.filter((task) => task.state === input.state) : tasks,
    };
  }

  async listTaskEvents(
    input: OrchestrationSurfaceTaskLookupInput,
  ): Promise<OrchestrationSurfaceTaskEventListResponse> {
    const events = await this.#service.listEvents(input.taskId, selectorForRuntime(input.runtimeId));
    return {
      taskId: input.taskId,
      events,
    };
  }

  async interruptTask(
    input: OrchestrationSurfaceTaskLookupInput,
  ): Promise<OrchestrationSurfaceControlResponse> {
    await this.#service.interruptTask(input.taskId, selectorForRuntime(input.runtimeId));
    return {
      taskId: input.taskId,
      state: "accepted",
    };
  }

  async resumeTask(input: OrchestrationSurfaceTaskLookupInput): Promise<OrchestrationSurfaceTaskResponse> {
    const task = await this.#service.resumeTask(input.taskId, selectorForRuntime(input.runtimeId));
    return { task };
  }

  async approveTaskAction(
    input: OrchestrationSurfaceTaskLookupInput,
  ): Promise<OrchestrationSurfaceTaskResponse> {
    const task = await this.#service.approveTaskAction(
      input.taskId,
      selectorForRuntime(input.runtimeId),
    );
    return { task };
  }

  async rejectTaskAction(
    input: OrchestrationSurfaceRejectTaskActionInput,
  ): Promise<OrchestrationSurfaceTaskResponse> {
    const task = await this.#service.rejectTaskAction(
      input.taskId,
      input.reason,
      selectorForRuntime(input.runtimeId),
    );
    return { task };
  }
}

export function createOrchestrationProductSurface(
  service: OrchestrationSurfaceService,
  options?: OrchestrationProductSurfaceOptions,
): OrchestrationProductSurface {
  return new OrchestrationProductSurface(service, options);
}

export function selectorForRuntime(runtimeId?: string): AgentRuntimeSelector | undefined {
  return runtimeId ? { runtimeId } : undefined;
}

export type OrchestrationSurfaceSnapshotState =
  | OrchestrationTaskState
  | OrchestrationGraphState
  | OrchestrationResultClassification;

function copyToolDescriptor(tool: OrchestrationToolHarnessDescriptor): OrchestrationToolHarnessDescriptor {
  return {
    ...tool,
    failureModes: [...tool.failureModes],
  };
}

function isTaskDecompositionPlan(
  input: OrchestrationSurfaceTaskGraphPlanInput,
): input is OrchestrationTaskDecompositionPlan {
  return "planId" in input && "children" in input && Array.isArray(input.children);
}
