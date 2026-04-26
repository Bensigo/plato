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

The package also exposes the `plato` bin. The executable is intentionally thin:
it calls `runPlatoCliWithRuntime(process.argv.slice(2))` and keeps command
behavior in the injected-client handler surface.

The boundary rule is intentional: handler tests should use fake
`OrchestrationClient` implementations, and only bootstrap or executable
entrypoints should import concrete runtime adapters.

## Tool Catalog

- `plato.start_task`
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
