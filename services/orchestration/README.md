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

## Development Notes

- Run tests with `pnpm --filter @plato/orchestration test`.
- Run type-checking with `pnpm --filter @plato/orchestration typecheck`.
