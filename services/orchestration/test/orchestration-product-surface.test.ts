import { describe, expect, it } from "vitest";

import {
  OrchestrationProductSurface,
  TaskOrchestrationService,
  createValidatedGraphInputFromDecompositionPlan,
  validateTaskDecompositionPlan,
  type AgentRuntime,
  type CreateOrchestrationGraphInput,
  type OrchestrationEvent,
  type OrchestrationTaskDecompositionPlan,
  type OrchestrationTaskGraphResultSnapshot,
  type OrchestrationTaskGraphSnapshot,
  type OrchestrationTaskRecord,
  type OrchestrationToolHarnessCatalog,
  type StartOrchestrationTaskInput,
} from "../src/index.js";

describe("OrchestrationProductSurface", () => {
  it("exposes stable MCP/CLI tool descriptors without backend-specific names", () => {
    const surface = new OrchestrationProductSurface(
      new TaskOrchestrationService({
        defaultRuntimeId: "test",
        runtimes: [new SurfaceFakeRuntime("test", "test-agent")],
      }),
    );

    expect(surface.listTools()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "plato.start_task",
          operation: "start_task",
          readOnly: false,
        }),
        expect.objectContaining({
          name: "plato.delegate_task",
          operation: "delegate_task",
          readOnly: false,
        }),
        expect.objectContaining({
          name: "plato.get_task_graph_results",
          operation: "get_task_graph_results",
          readOnly: true,
        }),
        expect.objectContaining({
          name: "plato.plan_task_graph",
          operation: "plan_task_graph",
          readOnly: true,
        }),
        expect.objectContaining({
          name: "plato.validate_task_graph_plan",
          operation: "validate_task_graph_plan",
          readOnly: true,
        }),
        expect.objectContaining({
          name: "plato.list_orchestration_tools",
          operation: "list_orchestration_tools",
          readOnly: true,
        }),
        expect.objectContaining({
          name: "plato.reject_task_action",
          operation: "reject_task_action",
          readOnly: false,
        }),
      ]),
    );
    expect(surface.listTools().map((tool) => tool.name)).not.toContain("codex.start_task");
  });

  it("exposes neutral worker tool harness descriptors", () => {
    const surface = new OrchestrationProductSurface(
      new TaskOrchestrationService({
        defaultRuntimeId: "test",
        runtimes: [new SurfaceFakeRuntime("test", "test-agent")],
      }),
      {
        toolCatalog: [
          {
            name: "search_repo",
            title: "Search Repo",
            description: "Search repository text and filenames.",
            mode: "read",
            riskLevel: "low",
            failureModes: ["search_failed"],
          },
          {
            name: "apply_patch",
            title: "Apply Patch",
            description: "Apply a scoped source patch.",
            mode: "write",
            riskLevel: "medium",
            failureModes: ["patch_failed"],
          },
        ],
      },
    );

    expect(surface.listToolCatalog()).toEqual([
      {
        name: "search_repo",
        title: "Search Repo",
        description: "Search repository text and filenames.",
        mode: "read",
        riskLevel: "low",
        failureModes: ["search_failed"],
      },
      {
        name: "apply_patch",
        title: "Apply Patch",
        description: "Apply a scoped source patch.",
        mode: "write",
        riskLevel: "medium",
        failureModes: ["patch_failed"],
      },
    ]);
    expect(surface.listToolCatalog().map((tool) => tool.name)).not.toContain("codex.apply_patch");
  });

  it("starts tasks and graphs through runtime selectors using product-level workspace paths", async () => {
    const codex = new SurfaceFakeRuntime("codex-local", "codex");
    const hermes = new SurfaceFakeRuntime("hermes-local", "hermes");
    const surface = new OrchestrationProductSurface(
      new TaskOrchestrationService({
        defaultRuntimeId: codex.runtimeId,
        runtimes: [codex, hermes],
      }),
    );

    await expect(
      surface.startTask({
        taskId: "task-1",
        workspacePath: "/repo",
        prompt: "Build a thing",
        runtimeId: "hermes-local",
      }),
    ).resolves.toMatchObject({
      task: {
        taskId: "task-1",
        workspacePath: "/repo",
        execution: { runtimeId: "hermes-local", backend: "hermes" },
      },
    });

    await expect(
      surface.createTaskGraph({
        parent: {
          taskId: "parent",
          workspacePath: "/repo",
          prompt: "Coordinate",
          runtimeId: "hermes-local",
        },
        children: [{ taskId: "child", prompt: "Do child work" }],
      }),
    ).resolves.toMatchObject({
      graph: {
        parent: { taskId: "parent", execution: { runtimeId: "hermes-local" } },
        children: [{ taskId: "child", workspacePath: "/repo" }],
      },
    });

    expect(hermes.startedTaskIds).toEqual(["task-1"]);
    expect(hermes.createdGraphParentIds).toEqual(["parent"]);
    expect(codex.startedTaskIds).toEqual([]);
    expect(codex.createdGraphParentIds).toEqual([]);
  });

  it("inspects tasks, graphs, events, and results with JSON-friendly response envelopes", async () => {
    const runtime = new SurfaceFakeRuntime("default-agent", "test-agent");
    runtime.graphResults = {
      parentTaskId: "parent",
      results: [
        {
          resultId: "result-1",
          taskId: "child",
          parentTaskId: "parent",
          classification: "completed",
          summary: "Done",
        },
      ],
    };
    const surface = new OrchestrationProductSurface(
      new TaskOrchestrationService({
        defaultRuntimeId: runtime.runtimeId,
        runtimes: [runtime],
      }),
    );

    await surface.createTaskGraph({
      parent: {
        taskId: "parent",
        workspacePath: "/repo",
        prompt: "Coordinate",
      },
      children: [{ taskId: "child", prompt: "Do child work" }],
    });

    await expect(surface.getTask({ taskId: "child" })).resolves.toMatchObject({
      task: { taskId: "child" },
    });
    await expect(surface.getTaskGraph({ taskId: "parent" })).resolves.toMatchObject({
      graph: { parent: { taskId: "parent" }, children: [{ taskId: "child" }] },
    });
    await expect(surface.getTaskGraphResults({ taskId: "parent" })).resolves.toEqual({
      graphResults: runtime.graphResults,
    });
    await expect(surface.listTaskEvents({ taskId: "parent" })).resolves.toEqual({
      taskId: "parent",
      events: [
        expect.objectContaining({
          taskId: "parent",
          type: "task.graph.created",
          runtimeId: "default-agent",
          backend: "test-agent",
        }),
      ],
    });
  });

  it("filters task lists by orchestration state and routes execution controls", async () => {
    const runtime = new SurfaceFakeRuntime("default-agent", "test-agent");
    const surface = new OrchestrationProductSurface(
      new TaskOrchestrationService({
        defaultRuntimeId: runtime.runtimeId,
        runtimes: [runtime],
      }),
    );
    runtime.tasks.set(
      "running-task",
      runtime.buildTask({
        taskId: "running-task",
        workspacePath: "/repo",
        prompt: "Run",
        state: "running",
      }),
    );
    runtime.tasks.set(
      "failed-task",
      runtime.buildTask({
        taskId: "failed-task",
        workspacePath: "/repo",
        prompt: "Fail",
        state: "failed",
      }),
    );

    await expect(surface.listTasks({ state: "running" })).resolves.toMatchObject({
      tasks: [{ taskId: "running-task" }],
    });
    await expect(surface.interruptTask({ taskId: "running-task" })).resolves.toEqual({
      taskId: "running-task",
      state: "accepted",
    });
    await expect(surface.resumeTask({ taskId: "running-task" })).resolves.toMatchObject({
      task: { taskId: "running-task", state: "running" },
    });
    await expect(surface.approveTaskAction({ taskId: "running-task" })).resolves.toMatchObject({
      task: { taskId: "running-task", state: "running" },
    });
    await expect(
      surface.rejectTaskAction({ taskId: "running-task", reason: "No thanks" }),
    ).resolves.toMatchObject({
      task: { taskId: "running-task", state: "failed" },
    });

    expect(runtime.interruptedTaskIds).toEqual(["running-task"]);
    expect(runtime.resumedTaskIds).toEqual(["running-task"]);
    expect(runtime.approvedTaskIds).toEqual(["running-task"]);
    expect(runtime.rejectedTaskInputs).toEqual([{ taskId: "running-task", reason: "No thanks" }]);
  });

  it("dispatches operation requests for MCP and CLI adapters", async () => {
    const runtime = new SurfaceFakeRuntime("default-agent", "test-agent");
    const surface = new OrchestrationProductSurface(
      new TaskOrchestrationService({
        defaultRuntimeId: runtime.runtimeId,
        runtimes: [runtime],
      }),
    );

    await expect(
      surface.execute({
        operation: "start_task",
        input: {
          taskId: "task-1",
          workspacePath: "/repo",
          prompt: "Ship it",
        },
      }),
    ).resolves.toMatchObject({
      operation: "start_task",
      task: { taskId: "task-1" },
    });

    await expect(
      surface.execute({
        operation: "list_task_events",
        input: { taskId: "task-1" },
      }),
    ).resolves.toEqual({
      operation: "list_task_events",
      taskId: "task-1",
      events: [
        expect.objectContaining({
          taskId: "task-1",
          type: "task.queued",
        }),
      ],
    });
    await expect(
      surface.execute({
        operation: "list_orchestration_tools",
      }),
    ).resolves.toMatchObject({
      operation: "list_orchestration_tools",
      tools: expect.arrayContaining([
        expect.objectContaining({
          name: "context7.get_docs",
          mode: "external",
          riskLevel: "low",
        }),
      ]),
    });
  });

  it("returns and validates reviewable task graph plans without starting execution", async () => {
    const runtime = new SurfaceFakeRuntime("default-agent", "test-agent");
    const surface = new OrchestrationProductSurface(
      new TaskOrchestrationService({
        defaultRuntimeId: runtime.runtimeId,
        runtimes: [runtime],
      }),
    );
    const plan = buildPlan();

    await expect(surface.planTaskGraph(plan)).resolves.toEqual({
      plan,
      validation: { valid: true, issues: [] },
    });
    await expect(surface.validateTaskGraphPlan({ plan })).resolves.toEqual({
      validation: { valid: true, issues: [] },
      graphInput: {
        parent: plan.parent,
        children: [
          {
            taskId: "child-a",
            workspacePath: undefined,
            prompt: "Implement the neutral planning contract and validation tests.",
            priority: undefined,
            dependencyTaskIds: undefined,
            contextPackage: undefined,
          },
          {
            taskId: "child-b",
            workspacePath: undefined,
            prompt: "Expose the planning surface through CLI and MCP handlers.",
            priority: undefined,
            dependencyTaskIds: ["child-a"],
            contextPackage: undefined,
          },
        ],
      },
    });

    expect(runtime.startedTaskIds).toEqual([]);
    expect(runtime.createdGraphParentIds).toEqual([]);
  });

  it("does not convert invalid decomposition plans into executable graph input", async () => {
    const runtime = new SurfaceFakeRuntime("default-agent", "test-agent");
    const surface = new OrchestrationProductSurface(
      new TaskOrchestrationService({
        defaultRuntimeId: runtime.runtimeId,
        runtimes: [runtime],
      }),
    );
    const plan = buildPlan({
      children: [
        {
          ...buildPlan().children[0]!,
          allowedToolNames: [],
          verification: { commands: [], acceptanceCriteria: [] },
        },
      ],
    });

    expect(createValidatedGraphInputFromDecompositionPlan(plan)).toMatchObject({
      validation: {
        valid: false,
        issues: expect.arrayContaining([
          expect.objectContaining({ code: "ALLOWED_TOOLS_REQUIRED", taskId: "child-a" }),
          expect.objectContaining({ code: "VERIFICATION_REQUIRED", taskId: "child-a" }),
        ]),
      },
      graphInput: undefined,
    });
    await expect(surface.validateTaskGraphPlan({ plan })).resolves.toMatchObject({
      validation: { valid: false },
      graphInput: undefined,
    });
    await expect(surface.createTaskGraphFromPlan({ plan })).resolves.toMatchObject({
      validation: { valid: false },
    });
    expect(runtime.startedTaskIds).toEqual([]);
    expect(runtime.createdGraphParentIds).toEqual([]);
  });

  it("starts execution from a valid decomposition plan through the validated plan gate", async () => {
    const runtime = new SurfaceFakeRuntime("default-agent", "test-agent");
    const surface = new OrchestrationProductSurface(
      new TaskOrchestrationService({
        defaultRuntimeId: runtime.runtimeId,
        runtimes: [runtime],
      }),
    );
    const plan = buildPlan();

    await expect(surface.createTaskGraphFromPlan({ plan })).resolves.toMatchObject({
      validation: { valid: true, issues: [] },
      graph: {
        parent: { taskId: "parent" },
        children: [{ taskId: "child-a" }, { taskId: "child-b" }],
      },
    });
    expect(runtime.createdGraphParentIds).toEqual(["parent"]);
  });

  it("delegates a top-level task by planning, validating, and starting a worker graph", async () => {
    const runtime = new SurfaceFakeRuntime("default-agent", "test-agent");
    const surface = new OrchestrationProductSurface(
      new TaskOrchestrationService({
        defaultRuntimeId: runtime.runtimeId,
        runtimes: [runtime],
      }),
    );

    await expect(
      surface.delegateTask({
        taskId: "m29",
        workspacePath: "/repo",
        prompt: "Execute the validated delegate plan through workers.",
        milestoneId: "M29",
      }),
    ).resolves.toMatchObject({
      plan: {
        planId: "m29-decomposition-plan",
        parent: { taskId: "m29" },
        children: [
          { taskId: "m29-preflight" },
          { taskId: "m29-implementation" },
          { taskId: "m29-review" },
        ],
      },
      validation: { valid: true, issues: [] },
      graph: {
        parent: { taskId: "m29" },
        children: [
          { taskId: "m29-preflight" },
          { taskId: "m29-implementation" },
          { taskId: "m29-review" },
        ],
      },
    });
    expect(runtime.createdGraphParentIds).toEqual(["m29"]);
  });

  it("does not start delegated workers when generated plan validation fails", async () => {
    const runtime = new SurfaceFakeRuntime("default-agent", "test-agent");
    const surface = new OrchestrationProductSurface(
      new TaskOrchestrationService({
        defaultRuntimeId: runtime.runtimeId,
        runtimes: [runtime],
      }),
      {
        toolCatalog: [
          {
            name: "search_repo",
            title: "Search Repo",
            description: "Search repository text and filenames.",
            mode: "read",
            riskLevel: "low",
            failureModes: ["search_failed"],
          },
        ],
      },
    );

    await expect(
      surface.delegateTask({
        taskId: "m29",
        workspacePath: "/repo",
        prompt: "Execute the validated delegate plan through workers.",
      }),
    ).resolves.toMatchObject({
      plan: { planId: "m29-decomposition-plan" },
      validation: {
        valid: false,
        issues: expect.arrayContaining([
          expect.objectContaining({ code: "UNKNOWN_ALLOWED_TOOL" }),
        ]),
      },
    });
    expect(runtime.startedTaskIds).toEqual([]);
    expect(runtime.createdGraphParentIds).toEqual([]);
  });

  it("plans a validated read-only decomposition from a top-level task brief", async () => {
    const runtime = new SurfaceFakeRuntime("default-agent", "test-agent");
    const surface = new OrchestrationProductSurface(
      new TaskOrchestrationService({
        defaultRuntimeId: runtime.runtimeId,
        runtimes: [runtime],
      }),
    );

    const response = await surface.planTaskGraph({
      taskId: "m28-orchestration-planner",
      workspacePath: "/repo",
      prompt: "Implement the orchestration-domain planner/preflight slice for M28.",
      milestoneId: "M28",
      writeScopePaths: [
        "services/orchestration/src/index.ts",
        "services/orchestration/src/plan.ts",
        "services/orchestration/src/surface.ts",
        "services/orchestration/test/orchestration-product-surface.test.ts",
        "services/orchestration/README.md",
      ],
      verificationCommands: [
        "pnpm --filter @plato/orchestration test",
        "pnpm --filter @plato/orchestration typecheck",
      ],
    });

    expect(response.validation).toEqual({ valid: true, issues: [] });
    expect(response.plan).toMatchObject({
      planId: "m28-orchestration-planner-decomposition-plan",
      parent: {
        taskId: "m28-orchestration-planner",
        workspacePath: "/repo",
      },
      documentation: [
        expect.objectContaining({
          requirementId: "context7-preflight",
          gaps: expect.arrayContaining([
            expect.stringContaining("Resolve Context7 docs during preflight"),
          ]),
        }),
      ],
      children: [
        expect.objectContaining({
          taskId: "m28-orchestration-planner-preflight",
          allowedToolNames: expect.arrayContaining(["inspect_workspace", "read_contract", "list_tests"]),
          riskLevel: "low",
          contextPackage: expect.objectContaining({
            summary: expect.stringContaining("Context7 requirement"),
          }),
        }),
        expect.objectContaining({
          taskId: "m28-orchestration-planner-implementation",
          dependencyTaskIds: ["m28-orchestration-planner-preflight"],
          allowedToolNames: expect.arrayContaining([
            "context7.resolve_library",
            "context7.get_docs",
            "apply_patch",
            "run_tests",
            "run_typecheck",
          ]),
          writeScope: {
            exclusive: true,
            paths: expect.arrayContaining(["services/orchestration/src/plan.ts"]),
          },
        }),
        expect.objectContaining({
          taskId: "m28-orchestration-planner-review",
          dependencyTaskIds: ["m28-orchestration-planner-implementation"],
          allowedToolNames: expect.arrayContaining(["request_review", "git.push", "github.open_pr"]),
          requiresApproval: true,
          riskLevel: "high",
          verification: expect.objectContaining({
            acceptanceCriteria: expect.arrayContaining([
              "Milestone branch is pushed and a pull request is opened for review.",
            ]),
          }),
        }),
      ],
    });
    expect(response.plan.children.map((child) => child.prompt).join("\n")).toContain(
      "Review and PR steps",
    );
    expect(runtime.startedTaskIds).toEqual([]);
    expect(runtime.createdGraphParentIds).toEqual([]);
  });

  it("validates decomposition quality before graph execution", () => {
    const plan = buildPlan({
      children: [
        {
          ...buildPlan().children[0],
          taskId: "child-a",
          dependencyTaskIds: ["child-b", "child-b"],
          writeScope: { paths: [] },
          allowedToolNames: [],
          verification: { commands: [], acceptanceCriteria: [] },
          requiredDocumentation: [
            {
              requirementId: "docs-1",
              label: "Vitest",
              reason: "Confirm current test API usage.",
              sources: [],
            },
          ],
        },
        {
          ...buildPlan().children[1],
          taskId: "child-b",
          dependencyTaskIds: ["missing-child"],
          requiredDocumentation: [
            {
              requirementId: "docs-2",
              label: "MCP",
              reason: "Confirm current tool registration behavior.",
              sources: [
                {
                  sourceId: "mcp-docs",
                  kind: "url",
                  label: "MCP tools",
                  uri: "https://modelcontextprotocol.io/specification/draft/server/tools",
                },
              ],
            },
          ],
        },
      ],
    });

    expect(validateTaskDecompositionPlan(plan)).toEqual({
      valid: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "WRITE_SCOPE_REQUIRED", taskId: "child-a" }),
        expect.objectContaining({ code: "ALLOWED_TOOLS_REQUIRED", taskId: "child-a" }),
        expect.objectContaining({ code: "VERIFICATION_REQUIRED", taskId: "child-a" }),
        expect.objectContaining({ code: "DUPLICATE_DEPENDENCY", taskId: "child-a" }),
        expect.objectContaining({ code: "DOCUMENTATION_EVIDENCE_REQUIRED", taskId: "child-a" }),
        expect.objectContaining({ code: "MISSING_DEPENDENCY", taskId: "child-b" }),
        expect.objectContaining({
          severity: "warning",
          code: "CONTEXT7_SOURCE_RECOMMENDED",
          taskId: "child-b",
        }),
      ]),
    });
  });

  it("validates planned worker allowed tools against a supplied catalog", async () => {
    const runtime = new SurfaceFakeRuntime("default-agent", "test-agent");
    const surface = new OrchestrationProductSurface(
      new TaskOrchestrationService({
        defaultRuntimeId: runtime.runtimeId,
        runtimes: [runtime],
      }),
      {
        toolCatalog: [
          {
            name: "search_repo",
            title: "Search Repo",
            description: "Search repository text and filenames.",
            mode: "read",
            riskLevel: "low",
            failureModes: ["search_failed"],
          },
          {
            name: "read_file",
            title: "Read File",
            description: "Read repository files.",
            mode: "read",
            riskLevel: "low",
            failureModes: ["read_failed"],
          },
        ],
      },
    );
    const plan = buildPlan({
      children: [
        {
          ...buildPlan().children[0],
          allowedToolNames: ["search_repo", "run_tests"],
        },
      ],
    });

    await expect(surface.validateTaskGraphPlan({ plan })).resolves.toMatchObject({
      validation: {
        valid: false,
        issues: expect.arrayContaining([
          expect.objectContaining({
            code: "UNKNOWN_ALLOWED_TOOL",
            taskId: "child-a",
          }),
        ]),
      },
      graphInput: undefined,
    });
    expect(validateTaskDecompositionPlan(plan, { toolCatalog: surface.listToolCatalog() })).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "UNKNOWN_ALLOWED_TOOL",
          message: "Child task child-a allows unknown tool run_tests",
          taskId: "child-a",
        }),
      ]),
    });
  });

  it("requires approval for approval-gated worker tools", () => {
    const plan = buildPlan({
      children: [
        {
          ...buildPlan().children[0],
          allowedToolNames: ["git.push"],
          riskLevel: "medium",
        },
      ],
    });

    expect(validateTaskDecompositionPlan(plan)).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "TOOL_APPROVAL_REQUIRED",
          taskId: "child-a",
          toolName: "git.push",
        }),
        expect.objectContaining({
          severity: "warning",
          code: "TOOL_RISK_EXCEEDS_TASK_RISK",
          taskId: "child-a",
          toolName: "git.push",
        }),
      ]),
    });

    expect(validateTaskDecompositionPlan({
      ...plan,
      children: [
        {
          ...plan.children[0]!,
          riskLevel: "high",
          requiresApproval: true,
        },
      ],
    })).toEqual({
      valid: true,
      issues: [],
    });
  });

  it("requires child documentation for documentation-sensitive worker tools", () => {
    const toolCatalog: OrchestrationToolHarnessCatalog = [
      {
        name: "framework.lookup",
        title: "Framework Lookup",
        description: "Fetch current framework documentation before planning implementation work.",
        mode: "external",
        riskLevel: "low",
        documentationRequired: true,
        failureModes: ["docs_unavailable"],
      },
      {
        name: "search_repo",
        title: "Search Repo",
        description: "Search repository text and filenames.",
        mode: "read",
        riskLevel: "low",
        failureModes: ["search_failed"],
      },
    ];
    const plan = buildPlan({
      children: [
        {
          ...buildPlan().children[0],
          allowedToolNames: ["framework.lookup", "search_repo"],
          requiredDocumentation: undefined,
        },
      ],
    });

    expect(validateTaskDecompositionPlan(plan, { toolCatalog })).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "TOOL_DOCUMENTATION_REQUIRED",
          taskId: "child-a",
          toolName: "framework.lookup",
        }),
      ]),
    });
  });

  it("requires Context7 evidence or an explicit Context7 gap for documentation requirements", () => {
    const plan = buildPlan({
      children: [
        {
          ...buildPlan().children[0],
          requiredDocumentation: [
            {
              requirementId: "docs-1",
              label: "Framework docs",
              reason: "Confirm current framework behavior.",
              sources: [
                {
                  sourceId: "framework-url",
                  kind: "url",
                  label: "Framework docs",
                  uri: "https://example.com/docs",
                },
              ],
            },
          ],
        },
      ],
    });

    expect(validateTaskDecompositionPlan(plan)).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "CONTEXT7_EVIDENCE_REQUIRED",
          taskId: "child-a",
        }),
      ]),
    });
    expect(validateTaskDecompositionPlan({
      ...plan,
      children: [
        {
          ...plan.children[0]!,
          requiredDocumentation: [
            {
              requirementId: "docs-2",
              label: "Context7 docs",
              reason: "Confirm current framework behavior.",
              sources: [
                {
                  sourceId: "context7-docs",
                  kind: "context7",
                  label: "Context7 docs",
                  uri: "context7://framework",
                  summary: "Context7 documentation confirms the framework behavior.",
                },
              ],
            },
          ],
        },
      ],
    })).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "CONTEXT7_SOURCE_FRESHNESS_REQUIRED",
          taskId: "child-a",
        }),
        expect.objectContaining({
          code: "CONTEXT7_EVIDENCE_REQUIRED",
          taskId: "child-a",
        }),
      ]),
    });
    expect(validateTaskDecompositionPlan({
      ...plan,
      children: [
        {
          ...plan.children[0]!,
          requiredDocumentation: [
            {
              ...plan.children[0]!.requiredDocumentation![0]!,
              sources: [],
              gaps: ["Context7 unavailable for this internal API; use repo contracts instead."],
            },
          ],
        },
      ],
    })).toMatchObject({
      valid: true,
      issues: [],
    });
  });

  it("rejects low-risk writer tasks and publishing tools without approval", () => {
    const plan = buildPlan({
      children: [
        {
          ...buildPlan().children[0],
          writeScope: { paths: [] },
          allowedToolNames: ["apply_patch", "github.open_pr"],
          riskLevel: "low",
        },
      ],
    });

    expect(validateTaskDecompositionPlan(plan)).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "WRITE_SCOPE_REQUIRED",
          taskId: "child-a",
        }),
        expect.objectContaining({
          code: "WRITE_TOOL_SCOPE_REQUIRED",
          taskId: "child-a",
          toolName: "apply_patch",
        }),
        expect.objectContaining({
          code: "WRITE_TOOL_RISK_TOO_LOW",
          taskId: "child-a",
          toolName: "apply_patch",
        }),
        expect.objectContaining({
          code: "PUBLISHING_TOOL_APPROVAL_REQUIRED",
          taskId: "child-a",
          toolName: "github.open_pr",
        }),
      ]),
    });
  });

  it("rejects blank nested boundary, verification, and documentation evidence fields", () => {
    const plan = buildPlan({
      children: [
        {
          ...buildPlan().children[0],
          writeScope: { paths: [" "] },
          allowedToolNames: [" "],
          verification: {
            commands: [" "],
            acceptanceCriteria: [" "],
          },
          requiredDocumentation: [
            {
              requirementId: "docs-1",
              label: "Docs",
              reason: "Confirm current API behavior.",
              sources: [
                {
                  sourceId: " ",
                  kind: "context7",
                  label: " ",
                  uri: " ",
                },
              ],
            },
          ],
        },
      ],
    });

    expect(validateTaskDecompositionPlan(plan)).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "WRITE_SCOPE_PATH_REQUIRED", taskId: "child-a" }),
        expect.objectContaining({ code: "ALLOWED_TOOL_NAME_REQUIRED", taskId: "child-a" }),
        expect.objectContaining({ code: "VERIFICATION_COMMAND_REQUIRED", taskId: "child-a" }),
        expect.objectContaining({ code: "ACCEPTANCE_CRITERION_REQUIRED", taskId: "child-a" }),
        expect.objectContaining({ code: "DOCUMENTATION_SOURCE_ID_REQUIRED", taskId: "child-a" }),
        expect.objectContaining({ code: "DOCUMENTATION_SOURCE_LABEL_REQUIRED", taskId: "child-a" }),
        expect.objectContaining({ code: "DOCUMENTATION_SOURCE_URI_REQUIRED", taskId: "child-a" }),
        expect.objectContaining({ code: "CONTEXT7_SOURCE_SUMMARY_REQUIRED", taskId: "child-a" }),
        expect.objectContaining({ code: "CONTEXT7_SOURCE_FRESHNESS_REQUIRED", taskId: "child-a" }),
      ]),
    });
  });
});

function buildPlan(
  overrides: Partial<OrchestrationTaskDecompositionPlan> = {},
): OrchestrationTaskDecompositionPlan {
  return {
    planId: "m28-plan",
    summary: "Reviewable M28 task decomposition plan.",
    parent: {
      taskId: "parent",
      workspacePath: "/repo",
      prompt: "Implement M28 task decomposition planning.",
    },
    children: [
      {
        taskId: "child-a",
        prompt: "Implement the neutral planning contract and validation tests.",
        objective: "Define reviewable task graph plans before execution.",
        writeScope: { paths: ["services/orchestration/src", "services/orchestration/test"] },
        allowedToolNames: ["search_repo", "read_file", "apply_patch", "run_tests"],
        verification: {
          commands: ["pnpm --filter @plato/orchestration test"],
          acceptanceCriteria: ["Plan validation rejects incomplete worker briefs."],
        },
        riskLevel: "medium",
        requiredDocumentation: [
          {
            requirementId: "context7-docs",
            label: "Context7",
            reason: "Confirm documentation lookup policy before planning framework-specific work.",
            sources: [
              {
                sourceId: "context7",
                kind: "context7",
                label: "Context7 docs",
                uri: "context7://docs",
                checkedAt: "2026-04-27",
                summary: "Context7 provides current library documentation.",
              },
            ],
          },
        ],
      },
      {
        taskId: "child-b",
        prompt: "Expose the planning surface through CLI and MCP handlers.",
        objective: "Return and validate plans without starting graph execution.",
        dependencyTaskIds: ["child-a"],
        writeScope: { paths: ["apps/plato-cli/src", "apps/plato-cli/test"] },
        allowedToolNames: ["search_repo", "read_file", "apply_patch", "run_tests"],
        verification: {
          commands: ["pnpm --filter @plato/cli test"],
          acceptanceCriteria: ["CLI and MCP planning commands are read-only."],
        },
        riskLevel: "medium",
      },
    ],
    ...overrides,
  };
}

class SurfaceFakeRuntime implements AgentRuntime {
  readonly startedTaskIds: string[] = [];
  readonly createdGraphParentIds: string[] = [];
  readonly interruptedTaskIds: string[] = [];
  readonly resumedTaskIds: string[] = [];
  readonly approvedTaskIds: string[] = [];
  readonly rejectedTaskInputs: Array<{ taskId: string; reason: string }> = [];
  readonly tasks = new Map<string, OrchestrationTaskRecord>();
  readonly graphs = new Map<string, OrchestrationTaskGraphSnapshot>();
  readonly events = new Map<string, OrchestrationEvent[]>();
  graphResults?: OrchestrationTaskGraphResultSnapshot;

  constructor(
    readonly runtimeId: string,
    readonly backend: string,
  ) {}

  async startTask(input: StartOrchestrationTaskInput): Promise<OrchestrationTaskRecord> {
    this.startedTaskIds.push(input.taskId);
    const task = this.buildTask(input);
    this.tasks.set(task.taskId, task);
    this.addEvent(task.taskId, "task.queued");
    return task;
  }

  async createTaskGraph(input: CreateOrchestrationGraphInput): Promise<OrchestrationTaskGraphSnapshot> {
    this.createdGraphParentIds.push(input.parent.taskId);
    const parent = this.buildTask(input.parent);
    const children = input.children.map((child) =>
      this.buildTask({
        taskId: child.taskId,
        workspacePath: child.workspacePath ?? input.parent.workspacePath,
        prompt: child.prompt,
        priority: child.priority,
      }),
    );
    const graph = {
      parent,
      children,
      state: "queued" as const,
    };
    this.tasks.set(parent.taskId, parent);
    for (const child of children) {
      this.tasks.set(child.taskId, child);
    }
    this.graphs.set(parent.taskId, graph);
    this.addEvent(parent.taskId, "task.graph.created");
    return graph;
  }

  async getTask(taskId: string): Promise<OrchestrationTaskRecord | undefined> {
    return this.tasks.get(taskId);
  }

  async getTaskGraph(taskId: string): Promise<OrchestrationTaskGraphSnapshot | undefined> {
    return this.graphs.get(taskId);
  }

  async getTaskGraphResults(): Promise<OrchestrationTaskGraphResultSnapshot | undefined> {
    return this.graphResults;
  }

  async listTasks(): Promise<OrchestrationTaskRecord[]> {
    return [...this.tasks.values()];
  }

  async listEvents(taskId: string): Promise<OrchestrationEvent[]> {
    return this.events.get(taskId) ?? [];
  }

  async interruptTask(taskId: string): Promise<void> {
    this.interruptedTaskIds.push(taskId);
  }

  async resumeTask(taskId: string): Promise<OrchestrationTaskRecord> {
    this.resumedTaskIds.push(taskId);
    const existing = this.tasks.get(taskId);
    const task = existing ? { ...existing, state: "running" as const } : this.buildTask({ taskId });
    this.tasks.set(task.taskId, task);
    return task;
  }

  async approveTaskAction(taskId: string): Promise<OrchestrationTaskRecord> {
    this.approvedTaskIds.push(taskId);
    const existing = this.tasks.get(taskId);
    const task = existing ? { ...existing, state: "running" as const } : this.buildTask({ taskId });
    this.tasks.set(task.taskId, task);
    return task;
  }

  async rejectTaskAction(taskId: string, reason: string): Promise<OrchestrationTaskRecord> {
    this.rejectedTaskInputs.push({ taskId, reason });
    const existing = this.tasks.get(taskId);
    const task = existing ? { ...existing, state: "failed" as const } : this.buildTask({ taskId });
    this.tasks.set(task.taskId, task);
    return task;
  }

  buildTask(
    input: Partial<StartOrchestrationTaskInput> & {
      taskId: string;
      state?: OrchestrationTaskRecord["state"];
    },
  ): OrchestrationTaskRecord {
    return {
      taskId: input.taskId,
      workspacePath: input.workspacePath ?? "/repo",
      prompt: input.prompt ?? "Run task",
      priority: input.priority ?? 0,
      state: input.state ?? "queued",
      execution: {
        runtimeId: this.runtimeId,
        backend: this.backend,
        backendTaskId: input.taskId,
      },
    };
  }

  private addEvent(taskId: string, type: string): void {
    this.events.set(taskId, [
      ...(this.events.get(taskId) ?? []),
      {
        taskId,
        type,
        runtimeId: this.runtimeId,
        backend: this.backend,
      },
    ]);
  }
}
