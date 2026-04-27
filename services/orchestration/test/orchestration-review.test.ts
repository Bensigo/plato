import { describe, expect, it } from "vitest";

import {
  buildOrchestrationGraphReviewSnapshot,
  buildOrchestrationPlanReviewSnapshot,
  validateTaskDecompositionPlan,
  type OrchestrationTaskDecompositionPlan,
  type OrchestrationTaskGraphResultSnapshot,
  type OrchestrationTaskGraphSnapshot,
  type OrchestrationTaskRecord,
} from "../src/index.js";

describe("orchestration review snapshots", () => {
  it("summarizes plan validation failures, worker boundaries, and approval-gated steps", () => {
    const plan = buildReviewPlan({
      children: [
        {
          ...buildReviewPlan().children[0]!,
          allowedToolNames: [],
          verification: { commands: [], acceptanceCriteria: [] },
        },
        buildReviewPlan().children[1]!,
      ],
    });
    const validation = validateTaskDecompositionPlan(plan);

    expect(buildOrchestrationPlanReviewSnapshot(plan, validation)).toEqual({
      kind: "plan_review",
      planId: "review-plan",
      summary: "Review the worker graph before execution.",
      parentTaskId: "parent",
      validation: {
        valid: false,
        failureCount: 2,
        warningCount: 0,
        failures: expect.arrayContaining([
          expect.objectContaining({ code: "ALLOWED_TOOLS_REQUIRED", taskId: "worker-a" }),
          expect.objectContaining({ code: "VERIFICATION_REQUIRED", taskId: "worker-a" }),
        ]),
        warnings: [],
      },
      workerBoundaries: [
        {
          taskId: "worker-a",
          objective: "Implement the review snapshot contract.",
          riskLevel: "medium",
          dependencyTaskIds: [],
          writeScopePaths: ["services/orchestration/src/review.ts"],
          exclusiveWriteScope: true,
          allowedToolNames: [],
          verificationCommands: [],
          acceptanceCriteriaCount: 0,
          requiredDocumentationCount: 0,
        },
        {
          taskId: "worker-b",
          objective: "Verify, push, and open the milestone PR.",
          riskLevel: "high",
          dependencyTaskIds: ["worker-a"],
          writeScopePaths: ["services/orchestration/test/orchestration-review.test.ts"],
          exclusiveWriteScope: false,
          allowedToolNames: ["run_tests", "request_review", "git.push", "github.open_pr"],
          verificationCommands: ["pnpm --filter @plato/orchestration test"],
          acceptanceCriteriaCount: 1,
          requiredDocumentationCount: 0,
        },
      ],
      approvalGates: [
        {
          taskId: "worker-b",
          riskLevel: "high",
          allowedToolNames: ["run_tests", "request_review", "git.push", "github.open_pr"],
          dependencyTaskIds: ["worker-a"],
        },
      ],
    });
  });

  it("summarizes graph worker status and not-ready synthesis state from neutral records", () => {
    const graph = buildReviewGraph();
    const graphResults: OrchestrationTaskGraphResultSnapshot = {
      parentTaskId: "parent",
      results: [
        {
          resultId: "result-worker-a",
          taskId: "worker-a",
          parentTaskId: "parent",
          classification: "completed",
          summary: "Worker A finished.",
        },
      ],
    };

    expect(buildOrchestrationGraphReviewSnapshot(graph, graphResults)).toEqual({
      kind: "graph_review",
      parentTaskId: "parent",
      state: "running",
      workerStatuses: [
        {
          taskId: "worker-a",
          state: "completed",
          runtimeId: "codex",
          backend: "codex",
          dependencyTaskIds: [],
          resultClassification: "completed",
          resultId: "result-worker-a",
        },
        {
          taskId: "worker-b",
          state: "running",
          runtimeId: "codex",
          backend: "codex",
          dependencyTaskIds: ["worker-a"],
          resultClassification: undefined,
          resultId: undefined,
        },
      ],
      finalSynthesis: {
        readiness: "not_ready",
        expectedResultTaskIds: ["worker-a", "worker-b"],
        collectedResultTaskIds: ["worker-a"],
        missingResultTaskIds: ["worker-b"],
        synthesisId: undefined,
        classification: undefined,
        summary: undefined,
      },
    });
  });

  it("marks final synthesis ready when a parent synthesis record exists", () => {
    const graphResults: OrchestrationTaskGraphResultSnapshot = {
      parentTaskId: "parent",
      results: [
        {
          resultId: "result-worker-a",
          taskId: "worker-a",
          parentTaskId: "parent",
          classification: "completed",
          summary: "Worker A finished.",
        },
        {
          resultId: "result-worker-b",
          taskId: "worker-b",
          parentTaskId: "parent",
          classification: "partial",
          summary: "Worker B needs follow-up.",
        },
      ],
      synthesis: {
        synthesisId: "synthesis-parent",
        parentTaskId: "parent",
        classification: "partial",
        summary: "Graph is ready for review with one follow-up.",
        childTaskCount: 2,
        resultIds: ["result-worker-a", "result-worker-b"],
      },
    };

    expect(buildOrchestrationGraphReviewSnapshot(buildReviewGraph(), graphResults).finalSynthesis).toEqual({
      readiness: "ready",
      expectedResultTaskIds: ["worker-a", "worker-b"],
      collectedResultTaskIds: ["worker-a", "worker-b"],
      missingResultTaskIds: [],
      synthesisId: "synthesis-parent",
      classification: "partial",
      summary: "Graph is ready for review with one follow-up.",
    });
  });
});

function buildReviewPlan(
  overrides: Partial<OrchestrationTaskDecompositionPlan> = {},
): OrchestrationTaskDecompositionPlan {
  return {
    planId: "review-plan",
    summary: "Review the worker graph before execution.",
    parent: {
      taskId: "parent",
      workspacePath: "/repo",
      prompt: "Coordinate review snapshots.",
    },
    children: [
      {
        taskId: "worker-a",
        prompt: "Implement review snapshots.",
        objective: "Implement the review snapshot contract.",
        writeScope: { paths: ["services/orchestration/src/review.ts"], exclusive: true },
        allowedToolNames: ["search_repo", "read_file", "apply_patch", "run_tests"],
        verification: {
          commands: ["pnpm --filter @plato/orchestration test"],
          acceptanceCriteria: ["Review snapshots are pure functions."],
        },
        riskLevel: "medium",
      },
      {
        taskId: "worker-b",
        prompt: "Verify and publish review snapshots.",
        objective: "Verify, push, and open the milestone PR.",
        dependencyTaskIds: ["worker-a"],
        writeScope: {
          paths: ["services/orchestration/test/orchestration-review.test.ts"],
          exclusive: false,
        },
        allowedToolNames: ["run_tests", "request_review", "git.push", "github.open_pr"],
        verification: {
          commands: ["pnpm --filter @plato/orchestration test"],
          acceptanceCriteria: ["Milestone branch is ready for review."],
        },
        riskLevel: "high",
        requiresApproval: true,
      },
    ],
    ...overrides,
  };
}

function buildReviewGraph(): OrchestrationTaskGraphSnapshot {
  return {
    parent: buildTask({ taskId: "parent", state: "running" }),
    children: [
      buildTask({
        taskId: "worker-a",
        state: "completed",
        decomposition: {
          kind: "subtask",
          parentTaskId: "parent",
        },
      }),
      buildTask({
        taskId: "worker-b",
        state: "running",
        decomposition: {
          kind: "subtask",
          parentTaskId: "parent",
          dependencyTaskIds: ["worker-a"],
        },
      }),
    ],
    state: "running",
  };
}

function buildTask(
  overrides: Partial<OrchestrationTaskRecord> & Pick<OrchestrationTaskRecord, "taskId">,
): OrchestrationTaskRecord {
  const { taskId, ...rest } = overrides;
  return {
    taskId,
    workspacePath: "/repo",
    prompt: `Run ${taskId}`,
    priority: 0,
    state: "queued",
    execution: {
      runtimeId: "codex",
      backend: "codex",
      backendTaskId: taskId,
    },
    ...rest,
  };
}
