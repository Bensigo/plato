import type {
  CreateOrchestrationGraphInput,
  OrchestrationDocumentationRequirement,
  OrchestrationPlanValidationIssue,
  OrchestrationPlanValidationResult,
  OrchestrationTaskDecompositionPlan,
  OrchestrationTaskPlanningInput,
  OrchestrationToolHarnessCatalog,
  OrchestrationToolHarnessDescriptor,
  PlannedOrchestrationGraphChildInput,
} from "./index.js";

export const DEFAULT_ORCHESTRATION_TOOL_HARNESS_CATALOG = [
  {
    name: "context7.resolve_library",
    title: "Resolve Context7 Library",
    description: "Resolve a package, SDK, framework, or API name to a Context7 documentation id.",
    mode: "external",
    riskLevel: "low",
    documentationRequired: false,
    failureModes: ["library_not_found", "ambiguous_library"],
  },
  {
    name: "context7.get_docs",
    title: "Fetch Context7 Docs",
    description: "Fetch current version-specific documentation from Context7 for a resolved library id.",
    mode: "external",
    riskLevel: "low",
    documentationRequired: false,
    failureModes: ["docs_unavailable", "version_not_found"],
  },
  {
    name: "inspect_workspace",
    title: "Inspect Workspace",
    description: "Read package metadata, workspace structure, and local contributor instructions.",
    mode: "read",
    riskLevel: "low",
    failureModes: ["workspace_not_found", "metadata_unavailable"],
  },
  {
    name: "search_repo",
    title: "Search Repository",
    description: "Search repository files for symbols, contracts, tests, and existing implementation patterns.",
    mode: "read",
    riskLevel: "low",
    failureModes: ["no_matches", "search_failed"],
  },
  {
    name: "read_file",
    title: "Read File",
    description: "Read a specific repository file needed for implementation context.",
    mode: "read",
    riskLevel: "low",
    failureModes: ["file_not_found", "read_failed"],
  },
  {
    name: "read_contract",
    title: "Read Contract",
    description: "Read service or product-facing contracts before changing behavior.",
    mode: "read",
    riskLevel: "low",
    failureModes: ["contract_not_found", "read_failed"],
  },
  {
    name: "list_tests",
    title: "List Tests",
    description: "Discover relevant test and typecheck commands for a workspace.",
    mode: "read",
    riskLevel: "low",
    failureModes: ["test_command_not_found"],
  },
  {
    name: "run_tests",
    title: "Run Tests",
    description: "Run targeted tests for a worker task.",
    mode: "control",
    riskLevel: "medium",
    failureModes: ["test_failed", "command_unavailable"],
  },
  {
    name: "run_typecheck",
    title: "Run Typecheck",
    description: "Run workspace type checks for a worker task.",
    mode: "control",
    riskLevel: "medium",
    failureModes: ["typecheck_failed", "command_unavailable"],
  },
  {
    name: "apply_patch",
    title: "Apply Patch",
    description: "Make scoped file edits inside the declared write boundary.",
    mode: "write",
    riskLevel: "medium",
    failureModes: ["patch_failed", "write_scope_violation"],
  },
  {
    name: "get_task_graph",
    title: "Get Task Graph",
    description: "Inspect an existing Plato task graph.",
    mode: "read",
    riskLevel: "low",
    failureModes: ["task_graph_not_found"],
  },
  {
    name: "get_task_events",
    title: "Get Task Events",
    description: "Inspect structured events for a Plato task.",
    mode: "read",
    riskLevel: "low",
    failureModes: ["task_not_found"],
  },
  {
    name: "request_review",
    title: "Request Review",
    description: "Ask for human or agent review before continuing.",
    mode: "control",
    riskLevel: "low",
    failureModes: ["review_unavailable"],
  },
  {
    name: "git.push",
    title: "Push Git Branch",
    description: "Push a milestone branch to GitHub.",
    mode: "external",
    riskLevel: "high",
    requiresApproval: true,
    failureModes: ["push_rejected", "remote_unavailable"],
  },
  {
    name: "github.open_pr",
    title: "Open Pull Request",
    description: "Open a milestone pull request for review.",
    mode: "external",
    riskLevel: "medium",
    requiresApproval: true,
    failureModes: ["pr_create_failed", "remote_unavailable"],
  },
] as const satisfies OrchestrationToolHarnessCatalog;

export function createGraphInputFromDecompositionPlan(
  plan: OrchestrationTaskDecompositionPlan,
): CreateOrchestrationGraphInput {
  return {
    parent: plan.parent,
    children: plan.children.map((child) => ({
      taskId: child.taskId,
      workspacePath: child.workspacePath,
      prompt: child.prompt,
      priority: child.priority,
      dependencyTaskIds: child.dependencyTaskIds,
      contextPackage: child.contextPackage,
    })),
  };
}

export interface ValidatedGraphInputFromDecompositionPlanResult {
  validation: OrchestrationPlanValidationResult;
  graphInput?: CreateOrchestrationGraphInput;
}

export function createValidatedGraphInputFromDecompositionPlan(
  plan: OrchestrationTaskDecompositionPlan,
  options: OrchestrationPlanValidationOptions = {},
): ValidatedGraphInputFromDecompositionPlanResult {
  const validation = validateTaskDecompositionPlan(plan, options);
  return {
    validation,
    graphInput: validation.valid ? createGraphInputFromDecompositionPlan(plan) : undefined,
  };
}

export interface CreateTaskDecompositionPlanOptions {
  toolCatalog?: OrchestrationToolHarnessCatalog;
}

type TaskDecompositionPolicyKind =
  | "cli_mcp"
  | "backend_service"
  | "docs"
  | "frontend"
  | "infrastructure";

interface TaskDecompositionPolicy {
  kind: TaskDecompositionPolicyKind;
  label: string;
  defaultWriteScopePaths: string[];
  verificationCommands: string[];
  acceptanceCriteria: string[];
}

const TASK_DECOMPOSITION_POLICIES: Record<TaskDecompositionPolicyKind, TaskDecompositionPolicy> = {
  cli_mcp: {
    kind: "cli_mcp",
    label: "CLI/MCP adapter",
    defaultWriteScopePaths: ["apps/plato-cli/src", "apps/plato-cli/test"],
    verificationCommands: [
      "pnpm --filter @plato/cli test",
      "pnpm --filter @plato/cli typecheck",
      "pnpm --filter @plato/orchestration test",
      "pnpm --filter @plato/orchestration typecheck",
    ],
    acceptanceCriteria: [
      "CLI and MCP adapter changes preserve neutral plato.* operation contracts.",
      "Planning and validation commands remain read-only until a reviewed graph is explicitly started.",
    ],
  },
  backend_service: {
    kind: "backend_service",
    label: "Backend service",
    defaultWriteScopePaths: ["services"],
    verificationCommands: [
      "pnpm --filter @plato/orchestration test",
      "pnpm --filter @plato/orchestration typecheck",
    ],
    acceptanceCriteria: [
      "Service behavior is covered by focused tests at the owning service boundary.",
      "Failure modes are explicit in contracts, validation results, or test expectations.",
    ],
  },
  docs: {
    kind: "docs",
    label: "Documentation",
    defaultWriteScopePaths: ["README.md", "docs", "services/orchestration/README.md"],
    verificationCommands: ["pnpm --filter @plato/orchestration typecheck"],
    acceptanceCriteria: [
      "Documentation names the affected user-facing or service contract accurately.",
      "Examples, commands, and workflow steps match the implemented behavior.",
    ],
  },
  frontend: {
    kind: "frontend",
    label: "Frontend application",
    defaultWriteScopePaths: ["apps/desktop/src", "apps/desktop/test"],
    verificationCommands: [
      "pnpm --filter @plato/desktop test",
      "pnpm --filter @plato/desktop typecheck",
    ],
    acceptanceCriteria: [
      "User-facing flows expose clear loading, empty, error, and success states.",
      "Interactive UI changes are checked at representative desktop and mobile viewport sizes.",
    ],
  },
  infrastructure: {
    kind: "infrastructure",
    label: "Infrastructure",
    defaultWriteScopePaths: [".github", "turbo.json", "pnpm-workspace.yaml", "package.json"],
    verificationCommands: ["pnpm typecheck", "pnpm test"],
    acceptanceCriteria: [
      "Infrastructure changes are scoped to repository configuration or deployment boundaries.",
      "Generated artifacts, secrets, and machine-local paths are excluded from the milestone branch.",
    ],
  },
};

const DEFAULT_TASK_DECOMPOSITION_POLICY = TASK_DECOMPOSITION_POLICIES.backend_service;

export function createTaskDecompositionPlan(
  input: OrchestrationTaskPlanningInput,
  options: CreateTaskDecompositionPlanOptions = {},
): OrchestrationTaskDecompositionPlan {
  const taskPolicy = selectTaskDecompositionPolicy(input);
  const defaultWriteScopePaths = defaultWriteScopePathsForPolicy(input, taskPolicy);
  const writeScopePaths = normalizeWriteScopePaths(
    input.writeScopePaths,
    input.workspacePath,
    defaultWriteScopePaths,
  );
  const verificationCommands = uniqueValues([
    ...(input.verificationCommands ?? []),
    ...taskPolicy.verificationCommands,
  ]);
  const acceptanceCriteria = uniqueValues([
    ...(input.acceptanceCriteria ?? []),
    ...taskPolicy.acceptanceCriteria,
    "The decomposition plan validates with validateTaskDecompositionPlan before graph creation.",
    "Worker prompts state write boundaries, allowed tools, dependencies, Context7 expectations, verification, review, and PR steps.",
    "The planner is read-only and does not start runtime tasks or create task graphs.",
  ]);
  const documentation = input.documentation?.length
    ? copyDocumentationRequirements(input.documentation)
    : [context7DocumentationRequirement(input.milestoneId)];
  const planId = input.planId?.trim() || `${input.taskId}-decomposition-plan`;
  const summary =
    input.summary?.trim() ||
    `Reviewable deterministic decomposition plan for ${input.milestoneId ?? input.taskId}.`;
  const childTaskIds = {
    preflight: `${input.taskId}-preflight`,
    implementation: `${input.taskId}-implementation`,
    review: `${input.taskId}-review`,
  };

  const baseContext = [
    `Top-level task: ${input.prompt}`,
    `Workspace: ${input.workspacePath}`,
    `Milestone: ${input.milestoneId ?? "unspecified"}`,
    `Task class policy: ${taskPolicy.label}`,
    `Write boundary: ${writeScopePaths.join(", ")}`,
    `Context7 requirement: resolve relevant libraries and record docs or explicit gaps before implementation.`,
    `Review requirement: keep work PR-sized, push the milestone branch, and open a pull request after verification.`,
  ].join("\n");

  const children: PlannedOrchestrationGraphChildInput[] = [
    {
      taskId: childTaskIds.preflight,
      workspacePath: input.workspacePath,
      prompt: workerPrompt({
        title: "Preflight and contract discovery",
        task: input.prompt,
        taskPolicy,
        boundaries: writeScopePaths,
        allowedTools: ["inspect_workspace", "search_repo", "read_file", "read_contract", "list_tests"],
        dependencies: [],
        context7: documentation,
        verificationCommands: [],
        acceptanceCriteria: [
          "Identify the owning workspace, contracts, tests, and local AGENTS.md instructions.",
          "Record required Context7 documentation lookups or explicit gaps before implementation starts.",
          "Do not modify files during preflight.",
        ],
        reviewSteps: ["Report scope, risks, and proposed child execution order for review."],
      }),
      objective: "Discover workspace contracts, boundaries, docs needs, and verification commands before execution.",
      writeScope: { paths: writeScopePaths, exclusive: false },
      allowedToolNames: ["inspect_workspace", "search_repo", "read_file", "read_contract", "list_tests"],
      verification: {
        commands: [],
        acceptanceCriteria: [
          "Preflight notes identify relevant contracts, workspace rules, tests, and Context7 documentation needs.",
        ],
      },
      riskLevel: "low",
      requiredDocumentation: documentation,
      contextPackage: contextPackageForChild("preflight", baseContext),
    },
    {
      taskId: childTaskIds.implementation,
      workspacePath: input.workspacePath,
      prompt: workerPrompt({
        title: "Scoped implementation",
        task: input.prompt,
        taskPolicy,
        boundaries: writeScopePaths,
        allowedTools: [
          "inspect_workspace",
          "search_repo",
          "read_file",
          "read_contract",
          "context7.resolve_library",
          "context7.get_docs",
          "apply_patch",
          "run_tests",
          "run_typecheck",
        ],
        dependencies: [childTaskIds.preflight],
        context7: documentation,
        verificationCommands,
        acceptanceCriteria,
        reviewSteps: [
          "Keep changes inside the declared write boundary.",
          "Preserve unrelated edits from other agents.",
          "Summarize changed paths and verification results for reviewer handoff.",
        ],
      }),
      objective: "Implement the task inside the declared boundaries using preflight findings and current docs.",
      dependencyTaskIds: [childTaskIds.preflight],
      writeScope: { paths: writeScopePaths, exclusive: true },
      allowedToolNames: [
        "inspect_workspace",
        "search_repo",
        "read_file",
        "read_contract",
        "context7.resolve_library",
        "context7.get_docs",
        "apply_patch",
        "run_tests",
        "run_typecheck",
      ],
      verification: {
        commands: verificationCommands,
        acceptanceCriteria,
      },
      riskLevel: "medium",
      requiredDocumentation: documentation,
      contextPackage: contextPackageForChild("implementation", baseContext),
    },
    {
      taskId: childTaskIds.review,
      workspacePath: input.workspacePath,
      prompt: workerPrompt({
        title: "Verification, review, and PR handoff",
        task: input.prompt,
        taskPolicy,
        boundaries: writeScopePaths,
        allowedTools: [
          "search_repo",
          "read_file",
          "run_tests",
          "run_typecheck",
          "request_review",
          "git.push",
          "github.open_pr",
        ],
        dependencies: [childTaskIds.implementation],
        context7: documentation,
        verificationCommands,
        acceptanceCriteria,
        reviewSteps: [
          "Run targeted tests, typecheck, and lint when available.",
          "Request review before publishing if verification is incomplete or risky.",
          "Push the milestone branch and open a pull request with test notes.",
        ],
      }),
      objective: "Verify implementation results, prepare reviewer context, and publish the milestone PR.",
      dependencyTaskIds: [childTaskIds.implementation],
      writeScope: { paths: writeScopePaths, exclusive: false },
      allowedToolNames: [
        "search_repo",
        "read_file",
        "run_tests",
        "run_typecheck",
        "request_review",
        "git.push",
        "github.open_pr",
      ],
      verification: {
        commands: verificationCommands,
        acceptanceCriteria: [
          ...acceptanceCriteria,
          "Milestone branch is pushed and a pull request is opened for review.",
        ],
      },
      riskLevel: "high",
      requiresApproval: true,
      requiredDocumentation: documentation,
      contextPackage: contextPackageForChild("review", baseContext),
    },
  ];

  const plan: OrchestrationTaskDecompositionPlan = {
    planId,
    summary,
    parent: {
      taskId: input.taskId,
      workspacePath: input.workspacePath,
      prompt: input.prompt,
      priority: input.priority,
      agent: input.agent,
      contextPackage: input.contextPackage,
    },
    children,
    documentation,
  };
  const validation = validateTaskDecompositionPlan(plan, { toolCatalog: options.toolCatalog });
  if (!validation.valid) {
    return {
      ...plan,
      summary: `${summary} Generated plan has validation errors and must be reviewed before execution.`,
    };
  }
  return plan;
}

export interface OrchestrationPlanValidationOptions {
  toolCatalog?: OrchestrationToolHarnessCatalog;
}

export function validateTaskDecompositionPlan(
  plan: OrchestrationTaskDecompositionPlan,
  options: OrchestrationPlanValidationOptions = {
    toolCatalog: DEFAULT_ORCHESTRATION_TOOL_HARNESS_CATALOG,
  },
): OrchestrationPlanValidationResult {
  const issues: OrchestrationPlanValidationIssue[] = [];
  const childTaskIds = plan.children.map((child) => child.taskId);
  const toolCatalog = options.toolCatalog ?? DEFAULT_ORCHESTRATION_TOOL_HARNESS_CATALOG;
  const toolsByName = new Map(toolCatalog.map((tool) => [tool.name, tool]));

  pushIfBlank(issues, plan.planId, "PLAN_ID_REQUIRED", "Plan id is required");
  pushIfBlank(issues, plan.summary, "PLAN_SUMMARY_REQUIRED", "Plan summary is required");
  pushIfBlank(issues, plan.parent.taskId, "PARENT_TASK_ID_REQUIRED", "Parent task id is required");
  pushIfBlank(issues, plan.parent.workspacePath, "PARENT_WORKSPACE_REQUIRED", "Parent workspace path is required");
  pushIfBlank(issues, plan.parent.prompt, "PARENT_PROMPT_REQUIRED", "Parent prompt is required");

  if (plan.children.length === 0) {
    issues.push({
      severity: "error",
      code: "PLAN_CHILDREN_REQUIRED",
      message: "Plan requires at least one child task",
    });
  }

  const duplicateTaskId = findDuplicate([plan.parent.taskId, ...childTaskIds].filter(Boolean));
  if (duplicateTaskId) {
    issues.push({
      severity: "error",
      code: "DUPLICATE_TASK_ID",
      message: `Plan contains duplicate task id ${duplicateTaskId}`,
      taskId: duplicateTaskId,
    });
  }

  const childTaskIdSet = new Set(childTaskIds);
  for (const child of plan.children) {
    validatePlannedChild(plan.parent.taskId, child, childTaskIdSet, issues, toolsByName);
  }

  const cycle = findChildDependencyCycle(plan.children);
  if (cycle) {
    issues.push({
      severity: "error",
      code: "DEPENDENCY_CYCLE",
      message: `Plan child dependencies contain a cycle: ${cycle.join(" -> ")}`,
      taskId: cycle[0],
    });
  }

  for (const requirement of plan.documentation ?? []) {
    validateDocumentationRequirement(requirement, issues);
  }

  return {
    valid: !issues.some((issue) => issue.severity === "error"),
    issues,
  };
}

function validatePlannedChild(
  parentTaskId: string,
  child: PlannedOrchestrationGraphChildInput,
  childTaskIds: Set<string>,
  issues: OrchestrationPlanValidationIssue[],
  toolsByName: Map<string, OrchestrationToolHarnessDescriptor>,
): void {
  pushIfBlank(issues, child.taskId, "CHILD_TASK_ID_REQUIRED", "Child task id is required", child.taskId);
  pushIfBlank(issues, child.prompt, "CHILD_PROMPT_REQUIRED", "Child prompt is required", child.taskId);
  pushIfBlank(issues, child.objective, "CHILD_OBJECTIVE_REQUIRED", "Child objective is required", child.taskId);

  if (child.taskId === parentTaskId) {
    issues.push({
      severity: "error",
      code: "CHILD_PARENT_ID_COLLISION",
      message: `Child task ${child.taskId} cannot reuse the parent task id`,
      taskId: child.taskId,
    });
  }

  if (child.writeScope.paths.length === 0) {
    issues.push({
      severity: "error",
      code: "WRITE_SCOPE_REQUIRED",
      message: `Child task ${child.taskId} must declare at least one writable path`,
      taskId: child.taskId,
    });
  }
  for (const path of child.writeScope.paths) {
    if (!path.trim()) {
      issues.push({
        severity: "error",
        code: "WRITE_SCOPE_PATH_REQUIRED",
        message: `Child task ${child.taskId} contains a blank writable path`,
        taskId: child.taskId,
      });
    }
  }

  if (child.allowedToolNames.length === 0) {
    issues.push({
      severity: "error",
      code: "ALLOWED_TOOLS_REQUIRED",
      message: `Child task ${child.taskId} must declare allowed tools`,
      taskId: child.taskId,
    });
  }
  const duplicateToolName = findDuplicate(child.allowedToolNames);
  if (duplicateToolName) {
    issues.push({
      severity: "error",
      code: "DUPLICATE_ALLOWED_TOOL",
      message: `Child task ${child.taskId} contains duplicate allowed tool ${duplicateToolName}`,
      taskId: child.taskId,
      toolName: duplicateToolName,
    });
  }
  for (const toolName of child.allowedToolNames) {
    if (!toolName.trim()) {
      issues.push({
        severity: "error",
        code: "ALLOWED_TOOL_NAME_REQUIRED",
        message: `Child task ${child.taskId} contains a blank allowed tool name`,
        taskId: child.taskId,
      });
      continue;
    }
    const tool = toolsByName.get(toolName);
    if (!tool) {
      issues.push({
        severity: "error",
        code: "UNKNOWN_ALLOWED_TOOL",
        message: `Child task ${child.taskId} allows unknown tool ${toolName}`,
        taskId: child.taskId,
        toolName,
      });
      continue;
    }
    if (tool.requiresApproval && !child.requiresApproval) {
      issues.push({
        severity: "error",
        code: "TOOL_APPROVAL_REQUIRED",
        message: `Child task ${child.taskId} allows approval-required tool ${toolName}`,
        taskId: child.taskId,
        toolName,
      });
    }
    if (isPublishingTool(toolName) && !child.requiresApproval) {
      issues.push({
        severity: "error",
        code: "PUBLISHING_TOOL_APPROVAL_REQUIRED",
        message: `Child task ${child.taskId} allows publishing tool ${toolName} without approval`,
        taskId: child.taskId,
        toolName,
      });
    }
    if (tool.documentationRequired && (child.requiredDocumentation?.length ?? 0) === 0) {
      issues.push({
        severity: "error",
        code: "TOOL_DOCUMENTATION_REQUIRED",
        message: `Child task ${child.taskId} allows documentation-sensitive tool ${toolName} without required documentation`,
        taskId: child.taskId,
        toolName,
      });
    }
    if (tool.mode === "write" && child.writeScope.paths.length === 0) {
      issues.push({
        severity: "error",
        code: "WRITE_TOOL_SCOPE_REQUIRED",
        message: `Child task ${child.taskId} allows write tool ${toolName} without a writable path`,
        taskId: child.taskId,
        toolName,
      });
    }
    if (tool.mode === "write" && child.riskLevel === "low") {
      issues.push({
        severity: "error",
        code: "WRITE_TOOL_RISK_TOO_LOW",
        message: `Child task ${child.taskId} is low risk but allows write tool ${toolName}`,
        taskId: child.taskId,
        toolName,
      });
    }
    if (riskRank(tool.riskLevel) > riskRank(child.riskLevel)) {
      issues.push({
        severity: "warning",
        code: "TOOL_RISK_EXCEEDS_TASK_RISK",
        message: `Child task ${child.taskId} is ${child.riskLevel} risk but allows ${tool.riskLevel} risk tool ${toolName}`,
        taskId: child.taskId,
        toolName,
      });
    }
  }

  if (child.verification.commands.length === 0 && child.verification.acceptanceCriteria.length === 0) {
    issues.push({
      severity: "error",
      code: "VERIFICATION_REQUIRED",
      message: `Child task ${child.taskId} must declare commands or acceptance criteria`,
      taskId: child.taskId,
    });
  }
  for (const command of child.verification.commands) {
    if (!command.trim()) {
      issues.push({
        severity: "error",
        code: "VERIFICATION_COMMAND_REQUIRED",
        message: `Child task ${child.taskId} contains a blank verification command`,
        taskId: child.taskId,
      });
    }
  }
  for (const criterion of child.verification.acceptanceCriteria) {
    if (!criterion.trim()) {
      issues.push({
        severity: "error",
        code: "ACCEPTANCE_CRITERION_REQUIRED",
        message: `Child task ${child.taskId} contains a blank acceptance criterion`,
        taskId: child.taskId,
      });
    }
  }

  const duplicateDependencyTaskId = findDuplicate(child.dependencyTaskIds ?? []);
  if (duplicateDependencyTaskId) {
    issues.push({
      severity: "error",
      code: "DUPLICATE_DEPENDENCY",
      message: `Child task ${child.taskId} contains duplicate dependency ${duplicateDependencyTaskId}`,
      taskId: child.taskId,
    });
  }

  for (const dependencyTaskId of child.dependencyTaskIds ?? []) {
    if (dependencyTaskId === child.taskId) {
      issues.push({
        severity: "error",
        code: "SELF_DEPENDENCY",
        message: `Child task ${child.taskId} cannot depend on itself`,
        taskId: child.taskId,
      });
      continue;
    }
    if (!childTaskIds.has(dependencyTaskId)) {
      issues.push({
        severity: "error",
        code: "MISSING_DEPENDENCY",
        message: `Child task ${child.taskId} depends on missing child task ${dependencyTaskId}`,
        taskId: child.taskId,
      });
    }
  }

  for (const requirement of child.requiredDocumentation ?? []) {
    validateDocumentationRequirement(requirement, issues, child.taskId);
  }
}

function validateDocumentationRequirement(
  requirement: OrchestrationDocumentationRequirement,
  issues: OrchestrationPlanValidationIssue[],
  taskId?: string,
): void {
  pushIfBlank(
    issues,
    requirement.requirementId,
    "DOCUMENTATION_REQUIREMENT_ID_REQUIRED",
    "Documentation requirement id is required",
    taskId,
  );
  pushIfBlank(
    issues,
    requirement.label,
    "DOCUMENTATION_LABEL_REQUIRED",
    "Documentation requirement label is required",
    taskId,
  );
  pushIfBlank(
    issues,
    requirement.reason,
    "DOCUMENTATION_REASON_REQUIRED",
    "Documentation requirement reason is required",
    taskId,
  );

  if (requirement.sources.length === 0 && (requirement.gaps?.length ?? 0) === 0) {
    issues.push({
      severity: "error",
      code: "DOCUMENTATION_EVIDENCE_REQUIRED",
      message: `Documentation requirement ${requirement.requirementId} must include sources or explicit gaps`,
      taskId,
    });
  }

  if (requirement.sources.length > 0 && !requirement.sources.some((source) => source.kind === "context7")) {
    issues.push({
      severity: "warning",
      code: "CONTEXT7_SOURCE_RECOMMENDED",
      message: `Documentation requirement ${requirement.requirementId} has sources but no Context7 source`,
      taskId,
    });
  }

  const hasUsefulContext7Source = requirement.sources.some(
    (source) =>
      source.kind === "context7" &&
      Boolean(source.summary?.trim()) &&
      Boolean(source.version?.trim() || source.checkedAt?.trim()),
  );
  const hasContext7Gap = (requirement.gaps ?? []).some(
    (gap) => gap.trim().length > 0 && /context7/i.test(gap),
  );
  if (!hasUsefulContext7Source && !hasContext7Gap) {
    issues.push({
      severity: "error",
      code: "CONTEXT7_EVIDENCE_REQUIRED",
      message: `Documentation requirement ${requirement.requirementId} must include useful Context7 evidence or an explicit Context7 gap`,
      taskId,
    });
  }

  for (const source of requirement.sources) {
    pushIfBlank(
      issues,
      source.sourceId,
      "DOCUMENTATION_SOURCE_ID_REQUIRED",
      "Documentation source id is required",
      taskId,
    );
    pushIfBlank(
      issues,
      source.label,
      "DOCUMENTATION_SOURCE_LABEL_REQUIRED",
      "Documentation source label is required",
      taskId,
    );
    pushIfBlank(
      issues,
      source.uri,
      "DOCUMENTATION_SOURCE_URI_REQUIRED",
      "Documentation source uri is required",
      taskId,
    );
    if (source.kind === "context7") {
      pushIfBlank(
        issues,
        source.summary,
        "CONTEXT7_SOURCE_SUMMARY_REQUIRED",
        "Context7 documentation source summary is required",
        taskId,
      );
      if (!source.version?.trim() && !source.checkedAt?.trim()) {
        issues.push({
          severity: "error",
          code: "CONTEXT7_SOURCE_FRESHNESS_REQUIRED",
          message: `Context7 documentation source ${source.sourceId} requires version or checkedAt evidence`,
          taskId,
        });
      }
    }
  }
  for (const gap of requirement.gaps ?? []) {
    if (!gap.trim()) {
      issues.push({
        severity: "error",
        code: "DOCUMENTATION_GAP_REQUIRED",
        message: `Documentation requirement ${requirement.requirementId} contains a blank gap`,
        taskId,
      });
    }
  }
}

function pushIfBlank(
  issues: OrchestrationPlanValidationIssue[],
  value: string | undefined,
  code: string,
  message: string,
  taskId?: string,
): void {
  if (!value?.trim()) {
    issues.push({
      severity: "error",
      code,
      message,
      taskId,
    });
  }
}

function findDuplicate(values: string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      return value;
    }
    seen.add(value);
  }
  return undefined;
}

function riskRank(riskLevel: "low" | "medium" | "high"): number {
  switch (riskLevel) {
    case "low":
      return 1;
    case "medium":
      return 2;
    case "high":
      return 3;
  }
}

function isPublishingTool(toolName: string): boolean {
  return toolName === "git.push" || toolName === "github.open_pr";
}

function findChildDependencyCycle(
  children: Array<Pick<PlannedOrchestrationGraphChildInput, "taskId" | "dependencyTaskIds">>,
): string[] | undefined {
  const byTaskId = new Map(children.map((child) => [child.taskId, child]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];

  const visit = (taskId: string): string[] | undefined => {
    if (visiting.has(taskId)) {
      return [...path.slice(path.indexOf(taskId)), taskId];
    }
    if (visited.has(taskId)) {
      return undefined;
    }

    const child = byTaskId.get(taskId);
    if (!child) {
      return undefined;
    }

    visiting.add(taskId);
    path.push(taskId);
    for (const dependencyTaskId of child.dependencyTaskIds ?? []) {
      const cycle = visit(dependencyTaskId);
      if (cycle) {
        return cycle;
      }
    }
    path.pop();
    visiting.delete(taskId);
    visited.add(taskId);
    return undefined;
  };

  for (const child of children) {
    const cycle = visit(child.taskId);
    if (cycle) {
      return cycle;
    }
  }

  return undefined;
}

function selectTaskDecompositionPolicy(input: OrchestrationTaskPlanningInput): TaskDecompositionPolicy {
  const promptHaystack = [input.prompt, input.summary, input.milestoneId]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const writeScopeHaystack = (input.writeScopePaths ?? []).join(" ").toLowerCase();
  const haystack = [promptHaystack, writeScopeHaystack].join(" ");
  const writeScopePaths = input.writeScopePaths ?? [];

  if (
    hasAnyPolicySignal(promptHaystack, ["readme", "documentation", "docs", "markdown"]) ||
    (writeScopePaths.length > 0 &&
      writeScopePaths.every((path) => /(^|\/)(docs|readme)|\.md$/i.test(path.trim())))
  ) {
    return TASK_DECOMPOSITION_POLICIES.docs;
  }
  if (hasAnyPolicySignal(haystack, ["mcp", "cli", "command", "plato-cli", "apps/plato-cli"])) {
    return TASK_DECOMPOSITION_POLICIES.cli_mcp;
  }
  if (hasAnyPolicySignal(haystack, ["frontend", "ui", "ux", "desktop", "react", "view", "screen", "apps/desktop"])) {
    return TASK_DECOMPOSITION_POLICIES.frontend;
  }
  if (
    hasAnyPolicySignal(haystack, [
      ".github",
      "ci",
      "deploy",
      "deployment",
      "docker",
      "infra",
      "infrastructure",
      "package.json",
      "pnpm-workspace",
      "turbo",
      "workflow",
    ])
  ) {
    return TASK_DECOMPOSITION_POLICIES.infrastructure;
  }
  if (hasAnyPolicySignal(haystack, ["service", "services/", "backend", "contract", "orchestration", "runner"])) {
    return TASK_DECOMPOSITION_POLICIES.backend_service;
  }
  return DEFAULT_TASK_DECOMPOSITION_POLICY;
}

function defaultWriteScopePathsForPolicy(
  input: OrchestrationTaskPlanningInput,
  policy: TaskDecompositionPolicy,
): string[] {
  if (policy.kind !== "backend_service") {
    return policy.defaultWriteScopePaths;
  }

  const haystack = [
    input.prompt,
    input.summary,
    input.milestoneId,
    ...(input.writeScopePaths ?? []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (hasAnyPolicySignal(haystack, ["codex-runner", "runner"])) {
    return ["services/codex-runner/src", "services/codex-runner/test"];
  }
  if (hasAnyPolicySignal(haystack, ["orchestration", "planner", "plan validation"])) {
    return ["services/orchestration/src", "services/orchestration/test"];
  }
  if (hasAnyPolicySignal(haystack, ["config", "auth status"])) {
    return ["services/config/src", "services/config/test"];
  }
  if (hasAnyPolicySignal(haystack, ["database", "sqlite", "migration", "db"])) {
    return ["services/db"];
  }
  if (hasAnyPolicySignal(haystack, ["github-server", "github server"])) {
    return ["services/github-server"];
  }

  return policy.defaultWriteScopePaths;
}

function hasAnyPolicySignal(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

function normalizeWriteScopePaths(
  paths: string[] | undefined,
  workspacePath: string,
  defaultPaths: string[],
): string[] {
  const normalized = uniqueValues(paths?.map((path) => path.trim()).filter(Boolean) ?? []);
  if (normalized.length > 0) {
    return normalized;
  }
  const defaultScope = uniqueValues(defaultPaths);
  return defaultScope.length > 0 ? defaultScope : [workspacePath];
}

function uniqueValues(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function copyDocumentationRequirements(
  requirements: OrchestrationDocumentationRequirement[],
): OrchestrationDocumentationRequirement[] {
  return requirements.map((requirement) => ({
    ...requirement,
    sources: requirement.sources.map((source) => ({ ...source })),
    gaps: requirement.gaps ? [...requirement.gaps] : undefined,
  }));
}

function context7DocumentationRequirement(milestoneId: string | undefined): OrchestrationDocumentationRequirement {
  return {
    requirementId: "context7-preflight",
    label: "Context7 documentation preflight",
    reason: "Workers must resolve current library and framework documentation before implementation changes.",
    sources: [],
    gaps: [
      `Context7 evidence gap: Resolve Context7 docs during preflight for libraries touched by ${milestoneId ?? "this task"}.`,
    ],
  };
}

function contextPackageForChild(role: string, summary: string) {
  return {
    summary,
    sources: [
      {
        sourceId: `${role}-task-brief`,
        kind: "task_brief" as const,
        label: "Planner-generated worker brief",
        uri: `plato://orchestration/plans/${role}`,
        summary: "Deterministic planner context for a read-only decomposition plan.",
      },
    ],
    artifacts: [
      {
        artifactId: `${role}-boundaries`,
        kind: "summary" as const,
        label: "Worker boundaries and handoff expectations",
        mimeType: "text/plain",
        content: summary,
        summary: "Workspace, write boundary, documentation, verification, and PR expectations.",
      },
    ],
  };
}

function workerPrompt(input: {
  title: string;
  task: string;
  taskPolicy: TaskDecompositionPolicy;
  boundaries: string[];
  allowedTools: string[];
  dependencies: string[];
  context7: OrchestrationDocumentationRequirement[];
  verificationCommands: string[];
  acceptanceCriteria: string[];
  reviewSteps: string[];
}): string {
  return [
    input.title,
    "",
    `Task: ${input.task}`,
    `Task class policy: ${input.taskPolicy.label}`,
    `Dependencies: ${input.dependencies.length > 0 ? input.dependencies.join(", ") : "none"}`,
    `Write boundaries: ${input.boundaries.join(", ")}`,
    `Allowed tools: ${input.allowedTools.join(", ")}`,
    `Context7 requirements: ${input.context7.map((requirement) => requirement.label).join(", ")}`,
    `Verification commands: ${input.verificationCommands.length > 0 ? input.verificationCommands.join(" && ") : "none"}`,
    `Acceptance criteria: ${input.acceptanceCriteria.join("; ")}`,
    `Review and PR steps: ${input.reviewSteps.join("; ")}`,
  ].join("\n");
}
