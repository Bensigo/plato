# Plato Orchestrator

`@plato/orchestration` owns Plato's agent-agnostic orchestration contracts.

This package is intentionally not tied to Codex. It defines the product-level
language for tasks, task graphs, events, and agent runtimes so Plato can route
work to Codex today and other agents later without changing upstream callers.

## Boundary

- Plato orchestration contracts live here.
- Agent-specific execution details live in adapter packages.
- `@plato/codex-runner` is the first adapter behind this boundary.
- MCP and other caller-facing surfaces should depend on this package, not on a
  concrete runner implementation.
- `OrchestrationProductSurface` defines stable `plato.*` operation descriptors
  and JSON-friendly envelopes that CLI/MCP adapters can expose.
- Worker tool harnesses can provide a neutral `OrchestrationToolHarnessCatalog`;
  plan validation rejects planned `allowedToolNames` that are not in the
  supplied catalog.
- `plato.plan_task_graph` is read-only. It can accept either an already-authored
  `OrchestrationTaskDecompositionPlan` for validation or a top-level
  `OrchestrationTaskPlanningInput` brief. Briefs are expanded by the
  deterministic planner in `src/plan.ts`; the planner does not call LLMs or
  start runtime tasks.

## Runtime Registration

Runtime bootstrap code should compose concrete agent adapters behind
`TaskOrchestrationService`:

```ts
const orchestration = new TaskOrchestrationService({
  defaultRuntimeId: "codex",
  runtimes: [codexRuntime],
});
```

In the current product surface, `apps/plato-cli/src/bootstrap.ts` creates the
Codex adapter and registers it this way. CLI and MCP handlers receive the
resulting orchestration service as their neutral client, so handler code does
not depend on Codex-specific runner internals.

## Planning Preflight

`createTaskDecompositionPlan` turns a top-level task brief into a reviewable
`OrchestrationTaskDecompositionPlan` before execution. The generated plan
contains three deterministic children:

- preflight and contract discovery, with read-only workspace and contract tools;
- scoped implementation, with Context7 lookup requirements, declared write
  boundaries, dependencies, and verification commands;
- verification, review, push, and pull-request handoff, marked approval-gated
  because it may use external publishing tools.

The product surface immediately validates generated plans with
`validateTaskDecompositionPlan`. Use
`createValidatedGraphInputFromDecompositionPlan` or
`plato.validate_task_graph_plan` to convert a reviewed decomposition plan into
executable graph input; invalid plans return validation issues and no graph
input. `plato.create_task_graph` remains the lower-level execution operation for
already-prepared graph inputs.

For the default delegated execution path, `plato.delegate_task` accepts a
top-level task brief, generates the decomposition plan, validates it, and starts
the worker graph only when validation succeeds. The response includes the plan
and validation result alongside the graph snapshot when execution starts.

Plan validation also checks that documentation requirements carry usable
Context7 evidence. A requirement must include a Context7 source with a summary
and version or `checkedAt` freshness marker, or an explicit Context7 gap that
explains why the lookup could not be completed. The deterministic planner uses
an explicit preflight gap so generated plans stay valid before a worker has
performed live documentation lookup.

Allowed tools must match the declared execution scope. Write tools such as
`apply_patch` require writable paths and cannot be placed on low-risk read-only
tasks, while publishing tools such as `git.push` and `github.open_pr` require
approval-gated children.

## Result and Synthesis Substrate

The orchestration boundary already has the neutral M30 result shape. Worker
outputs are represented by `OrchestrationTaskResultRecord`, parent outcomes by
`OrchestrationSynthesisRecord`, and graph inspection by
`OrchestrationTaskGraphResultSnapshot`. Classifications are intentionally small
and product-facing: `completed`, `partial`, `conflicted`, and `failed`.

`plato.get_task_graph_results` exposes those records to CLI/MCP callers without
requiring knowledge of the backend runtime. When a runtime supports graph result
reconciliation, neutral result inspection asks it to backfill missing terminal
child results and syntheses before returning the snapshot. Events can also carry
result and synthesis identifiers so callers can correlate collection and
synthesis activity with graph lifecycle events.

The M30 product slice should therefore wire runtime collection, reconciliation,
and parent synthesis behind these contracts rather than introduce new surface
area. A reviewable slice should collect one durable result per terminal child
task, create the parent synthesis only after every child has a result, and keep
the classification visible through graph result inspection.

## Development Notes

- Run tests with `pnpm --filter @plato/orchestration test`.
- Run type-checking with `pnpm --filter @plato/orchestration typecheck`.
