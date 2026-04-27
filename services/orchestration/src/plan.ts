import type {
  CreateOrchestrationGraphInput,
  OrchestrationDocumentationRequirement,
  OrchestrationPlanValidationIssue,
  OrchestrationPlanValidationResult,
  OrchestrationTaskDecompositionPlan,
  PlannedOrchestrationGraphChildInput,
} from "./index.js";

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

export function validateTaskDecompositionPlan(
  plan: OrchestrationTaskDecompositionPlan,
): OrchestrationPlanValidationResult {
  const issues: OrchestrationPlanValidationIssue[] = [];
  const childTaskIds = plan.children.map((child) => child.taskId);

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
    validatePlannedChild(plan.parent.taskId, child, childTaskIdSet, issues);
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
  for (const toolName of child.allowedToolNames) {
    if (!toolName.trim()) {
      issues.push({
        severity: "error",
        code: "ALLOWED_TOOL_NAME_REQUIRED",
        message: `Child task ${child.taskId} contains a blank allowed tool name`,
        taskId: child.taskId,
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
