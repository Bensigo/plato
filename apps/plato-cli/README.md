# Plato CLI and MCP Surface

`@plato/cli` owns Plato's caller-facing orchestration surface.

This package speaks `@plato/orchestration` contracts only. Command handlers and
MCP tool handlers must not import `@plato/codex-runner`; Codex is one runtime
adapter behind the orchestration boundary, not the product API.

## Runtime Bootstrap

`src/index.ts` owns the neutral handler surface and accepts an injected
orchestration client. `src/bootstrap.ts` is the composition layer that opens the
current Codex runtime, wraps it in `CodexRunnerAgentRuntime`, registers it with
`TaskOrchestrationService`, and passes that neutral client into the CLI or MCP
surface.

Use `runPlatoCliWithRuntime()` when the CLI should open the default local
Codex-backed runtime for one command. Use `createPlatoMcpServerWithRuntime()`
when MCP hosting code needs a server plus a `close()` hook for the opened
runtime resources.

The package exposes two thin executables:

- `plato` for operator CLI commands, including `plato mcp`
- `plato-mcp` for agent configs that prefer a dedicated MCP command

It also exposes a deterministic health check:

```sh
pnpm --filter @plato/cli smoke
```

The smoke command exercises task start, status, list, and events through the
real CLI handlers using an in-memory fake runtime. For the real Codex-backed
manual smoke path, see [docs/local-task-smoke.md](/Users/macbook/work/plato/docs/local-task-smoke.md).

The read-only worker tool harness catalog is available without opening a runtime:

```sh
plato tool catalog
```

The delegate planner entrypoint turns a top-level task into a reviewable
decomposition plan and validates it without starting tasks or opening the
runtime-backed client:

```sh
plato delegate plan --task-id m28 --workspace-path /repo --prompt "Break this into reviewable milestones"
```

The response shape is `{ "plan": ..., "validation": ... }`, using the
deterministic planner from `@plato/orchestration`.

To run the default delegated execution flow in one step, use:

```sh
plato delegate start --task-id m29 --workspace-path /repo --prompt "Execute this through workers"
```

This creates the plan, validates it, and starts the worker graph only when the
plan passes validation. The response shape is
`{ "plan": ..., "validation": ..., "graph": ... }`; invalid plans omit
`graph`.

After review, start execution through the validated plan gate:

```sh
plato graph start-plan --plan-json "$PLAN_JSON"
```

Invalid plans return validation issues and do not start a graph.

To convert a reviewed plan into graph input for execution, use:

```sh
plato graph validate --plan-json '<plan-json>'
```

The validation command returns `{ "validation": ..., "graphInput": ... }` only
when the decomposition plan is valid. Invalid plans return validation issues and
omit `graphInput`; `plato graph start` remains the lower-level command for
already-prepared graph inputs.

Both MCP entrypoints use stdio transport. Do not write normal logs to stdout in
this process; stdout is reserved for MCP JSON-RPC messages.

The boundary rule is intentional: handler tests should use fake
`OrchestrationClient` implementations, and only bootstrap or executable
entrypoints should import concrete runtime adapters.

Example local agent configuration:

```json
{
  "mcpServers": {
    "plato": {
      "command": "plato",
      "args": ["mcp"]
    }
  }
}
```

## Tool Catalog

- `plato.delegate_task_plan`
- `plato.delegate_task`
- `plato.start_task`
- `plato.plan_task_graph`
- `plato.validate_task_graph_plan`
- `plato.create_task_graph_from_plan`
- `plato.create_task_graph`
- `plato.get_task`
- `plato.list_tasks`
- `plato.get_task_graph`
- `plato.get_task_graph_results`
- `plato.list_task_events`
- `plato.interrupt_task`
- `plato.resume_task`
- `plato.approve_task_action`
- `plato.reject_task_action`
- `plato.list_tools`
- `plato.list_orchestration_tools`

## Resource Catalog

- `plato://tasks`
- `plato://tasks/{taskId}`
- `plato://tasks/{taskId}/events`
- `plato://graphs/{taskId}`
- `plato://graphs/{taskId}/results`
- `plato://approvals`

## Development Notes

- Run tests with `pnpm --filter @plato/cli test`.
- Run type-checking with `pnpm --filter @plato/cli typecheck`.
