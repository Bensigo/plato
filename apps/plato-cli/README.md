# Plato CLI and MCP Surface

`@plato/cli` owns Plato's caller-facing orchestration surface.

This package speaks `@plato/orchestration` contracts only. Command handlers and
MCP tool handlers must not import `@plato/codex-runner`; Codex is one runtime
adapter behind the orchestration boundary, not the product API.

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
