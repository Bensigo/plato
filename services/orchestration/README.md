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
`validateTaskDecompositionPlan`, so callers can inspect validation issues before
calling `create_task_graph`.

## Development Notes

- Run tests with `pnpm --filter @plato/orchestration test`.
- Run type-checking with `pnpm --filter @plato/orchestration typecheck`.
