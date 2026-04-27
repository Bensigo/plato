import type {
  OrchestrationGraphState,
  OrchestrationPlanRiskLevel,
  OrchestrationPlanValidationIssue,
  OrchestrationPlanValidationResult,
  OrchestrationResultClassification,
  OrchestrationTaskDecompositionPlan,
  OrchestrationTaskGraphResultSnapshot,
  OrchestrationTaskGraphSnapshot,
  OrchestrationTaskState,
} from "./index.js";

export interface OrchestrationPlanReviewValidationSnapshot {
  valid: boolean;
  failureCount: number;
  warningCount: number;
  failures: OrchestrationPlanValidationIssue[];
  warnings: OrchestrationPlanValidationIssue[];
}

export interface OrchestrationPlanReviewWorkerBoundarySnapshot {
  taskId: string;
  objective: string;
  riskLevel: OrchestrationPlanRiskLevel;
  dependencyTaskIds: string[];
  writeScopePaths: string[];
  exclusiveWriteScope: boolean;
  allowedToolNames: string[];
  verificationCommands: string[];
  acceptanceCriteriaCount: number;
  requiredDocumentationCount: number;
}

export interface OrchestrationPlanReviewApprovalGateSnapshot {
  taskId: string;
  riskLevel: OrchestrationPlanRiskLevel;
  allowedToolNames: string[];
  dependencyTaskIds: string[];
}

export interface OrchestrationPlanReviewSnapshot {
  kind: "plan_review";
  planId: string;
  summary: string;
  parentTaskId: string;
  validation: OrchestrationPlanReviewValidationSnapshot;
  workerBoundaries: OrchestrationPlanReviewWorkerBoundarySnapshot[];
  approvalGates: OrchestrationPlanReviewApprovalGateSnapshot[];
}

export type OrchestrationFinalSynthesisReadiness = "ready" | "not_ready";

export interface OrchestrationGraphReviewWorkerStatusSnapshot {
  taskId: string;
  state: OrchestrationTaskState;
  runtimeId: string;
  backend: string;
  dependencyTaskIds: string[];
  resultClassification?: OrchestrationResultClassification;
  resultId?: string;
}

export interface OrchestrationGraphReviewSynthesisSnapshot {
  readiness: OrchestrationFinalSynthesisReadiness;
  expectedResultTaskIds: string[];
  collectedResultTaskIds: string[];
  missingResultTaskIds: string[];
  synthesisId?: string;
  classification?: OrchestrationResultClassification;
  summary?: string;
}

export interface OrchestrationGraphReviewSnapshot {
  kind: "graph_review";
  parentTaskId: string;
  state: OrchestrationGraphState;
  workerStatuses: OrchestrationGraphReviewWorkerStatusSnapshot[];
  finalSynthesis: OrchestrationGraphReviewSynthesisSnapshot;
}

export function buildOrchestrationPlanReviewSnapshot(
  plan: OrchestrationTaskDecompositionPlan,
  validation: OrchestrationPlanValidationResult,
): OrchestrationPlanReviewSnapshot {
  const failures = validation.issues.filter((issue) => issue.severity === "error");
  const warnings = validation.issues.filter((issue) => issue.severity === "warning");
  const approvalGates = plan.children
    .filter((child) => child.requiresApproval)
    .map((child) => ({
      taskId: child.taskId,
      riskLevel: child.riskLevel,
      allowedToolNames: [...child.allowedToolNames],
      dependencyTaskIds: [...(child.dependencyTaskIds ?? [])],
    }));

  return {
    kind: "plan_review",
    planId: plan.planId,
    summary: plan.summary,
    parentTaskId: plan.parent.taskId,
    validation: {
      valid: validation.valid,
      failureCount: failures.length,
      warningCount: warnings.length,
      failures,
      warnings,
    },
    workerBoundaries: plan.children.map((child) => ({
      taskId: child.taskId,
      objective: child.objective,
      riskLevel: child.riskLevel,
      dependencyTaskIds: [...(child.dependencyTaskIds ?? [])],
      writeScopePaths: [...child.writeScope.paths],
      exclusiveWriteScope: child.writeScope.exclusive ?? false,
      allowedToolNames: [...child.allowedToolNames],
      verificationCommands: [...child.verification.commands],
      acceptanceCriteriaCount: child.verification.acceptanceCriteria.length,
      requiredDocumentationCount: child.requiredDocumentation?.length ?? 0,
    })),
    approvalGates,
  };
}

export function buildOrchestrationGraphReviewSnapshot(
  graph: OrchestrationTaskGraphSnapshot,
  graphResults?: OrchestrationTaskGraphResultSnapshot,
): OrchestrationGraphReviewSnapshot {
  const resultsByTaskId = new Map(graphResults?.results.map((result) => [result.taskId, result]) ?? []);
  const collectedResultTaskIds = [...resultsByTaskId.keys()].filter((taskId) =>
    graph.children.some((child) => child.taskId === taskId),
  );
  const expectedResultTaskIds = graph.children.map((child) => child.taskId);
  const missingResultTaskIds = expectedResultTaskIds.filter((taskId) => !resultsByTaskId.has(taskId));

  return {
    kind: "graph_review",
    parentTaskId: graph.parent.taskId,
    state: graph.state,
    workerStatuses: graph.children.map((child) => {
      const result = resultsByTaskId.get(child.taskId);
      return {
        taskId: child.taskId,
        state: child.state,
        runtimeId: child.execution.runtimeId,
        backend: child.execution.backend,
        dependencyTaskIds: [...(child.decomposition?.dependencyTaskIds ?? [])],
        resultClassification: result?.classification,
        resultId: result?.resultId,
      };
    }),
    finalSynthesis: {
      readiness: graphResults?.synthesis ? "ready" : "not_ready",
      expectedResultTaskIds,
      collectedResultTaskIds,
      missingResultTaskIds,
      synthesisId: graphResults?.synthesis?.synthesisId,
      classification: graphResults?.synthesis?.classification,
      summary: graphResults?.synthesis?.summary,
    },
  };
}
