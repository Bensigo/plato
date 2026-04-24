# Codex Runner

`@plato/codex-runner` is a service inside the Plato monorepo. It owns the lifecycle of Codex-backed execution from queueing through worktree setup, runtime checks, session start, interruption, resume, and event capture.

This package is not the whole project and should not describe the whole monorepo. Its job is narrower: provide the Codex execution backend that lets Plato ask for agent work in a predictable way and recover what happened later.

In the larger Plato product, this service is one execution substrate for a future multi-agent orchestration flow. Plato's end goal is to help personal agents such as Hermes or OpenClaw decompose larger tasks into smaller subtasks, spawn multiple worker agents in parallel, and coordinate their results into one final outcome. Product-facing orchestration contracts live in `@plato/orchestration`; `codex-runner` adapts Codex-backed execution behind that neutral boundary.

## What The Service Owns

- task admission and priority ordering
- explicit task lifecycle state
- git worktree isolation per task
- Codex runtime readiness checks and bootstrap
- agent session adapters for Codex-backed execution
- structured event logs for task and session history
- interruption and resume without losing the original worktree

## Current Shape

The current codebase already exercises a concrete slice of this design:

- `CodexRunnerService` queues tasks, schedules work when capacity exists, and persists task state.
- `GitWorktreeManager` creates a dedicated branch and worktree under `.plato/worktrees/<taskId>`.
- `DefaultCodexRuntimeManager` verifies that the `codex` runtime is available and can install it when missing.
- `CodexSdkBackedAgentSession` provides the Codex-SDK-backed execution path while normalizing events into the runner stream.
- SQLite-backed task and session stores provide durable runner state through the shared `@plato/db` foundation.
- File-backed log streaming still provides the ordered event trail used for inspection and recovery.
- `@plato/config` provides local Codex auth configuration so real operator runs can pass user-provided OpenAI credentials into the Codex SDK.
- `CodexRunnerAgentRuntime` adapts `CodexRunnerService` to the agent-agnostic `@plato/orchestration` runtime contract.

## Task Lifecycle

Runner tasks use explicit states rather than hidden flags:

- `queued`
- `running`
- `awaiting_approval`
- `interrupted`
- `completed`
- `failed`

The key invariant is that task state, active session identity, and worktree location stay understandable after failures or interrupts. If a task is interrupted, the worktree path should still exist in the persisted record so the task can resume in place.

## Event Model

The runner treats logs as structured events first, text second. Current events include:

- runtime checks and installation events
- task queue, start, interrupt, resume, complete, and failure events
- task reconciliation events emitted during startup recovery
- session start, output, and exit events

That event stream is the service's audit trail. Other parts of Plato should be able to reconstruct what happened to a task without scraping terminal text.

## Orchestration Boundary

`@plato/orchestration` owns neutral task, graph, event, result, and agent runtime contracts. MCP and other caller-facing surfaces should depend on that package instead of importing `CodexRunnerService` directly.

`CodexRunnerAgentRuntime` is this package's adapter for that boundary. It maps Plato-level `workspacePath` and orchestration graph inputs to the runner's `repoPath` and task graph APIs, then maps runner records and events back to neutral orchestration records with `execution: { runtimeId, backend: "codex" }`.

The caller-facing CLI/MCP runtime bootstrap lives in `apps/plato-cli/src/bootstrap.ts`.
That app-level composition opens the existing operator runtime, wraps the runner
service in `CodexRunnerAgentRuntime`, and registers it with
`TaskOrchestrationService`. The runner package exports its service, adapter, and
operator runtime pieces for that bootstrap, while product handlers continue to
speak only orchestration contracts.

## What Codex Runner Is Becoming

The longer-term role of this workspace is to be one of Plato's core execution services for agent work:

- a stable Codex backend contract for submitting and inspecting tasks
- strong isolation between tasks via git worktrees
- resumable execution that preserves debugging context
- adapters around side effects so scheduling and lifecycle rules remain unit-testable

The next product step beyond this package is not "more Codex surface" in the abstract. It is caller-facing orchestration over the neutral `@plato/orchestration` boundary so future agent backends can plug in without reshaping Plato's product model.

## Task Graphs

`CodexRunnerService.createTaskGraph()` is the durable admission path for submitting one parent task with one or more child tasks. The parent and children are persisted through the store as one graph operation before scheduling begins, and each child is recorded with a `subtask` decomposition that points back to the parent task id. Children can also declare `dependencyTaskIds`; the scheduler only starts queued graph workers after every declared prerequisite has completed.

Operators can inspect graph state with `getTaskGraph(taskId)` or `codex-runner graph status <taskId>`. Passing either a parent id or child id returns the parent, immediate children, dependencies, and aggregate graph state. Parent-scoped graph lifecycle events are emitted when the graph is created and when child tasks complete or fail. Worker/dependency events are emitted on child task streams when a dependency is satisfied, when a worker starts, or when a failed prerequisite blocks a dependent worker.

The CLI accepts `--max-concurrent-tasks <n>` on `start` and `graph start` to tune how many runner tasks may be active at once for that operator runtime.

## Codex Auth Configuration

Before running real Codex-backed tasks, operators can configure local Codex auth:

```sh
codex-runner config status
printf '%s' "$OPENAI_API_KEY" | codex-runner config set-openai-key --api-key-stdin
# or: codex-runner config set-openai-key --api-key-env OPENAI_API_KEY
codex-runner config auth-chatgpt
codex-runner config auth-chatgpt --device-code
codex-runner config clear-openai-key
```

Config defaults to `~/.plato/config.json`, with MVP local secret fallback storage at `~/.plato/secrets.json`. OpenAI API keys are stored in Plato's local secret fallback and passed to the Codex SDK as API-key auth.

ChatGPT subscription auth follows the OpenClaw-style split route: `chatgpt_oauth` is distinct from `openai_api_key`, and the login flow is owned by Codex app-server. `auth-chatgpt` starts `codex app-server`, calls `account/login/start` with browser OAuth by default, or `chatgptDeviceCode` when `--device-code` is passed, then stores only safe account metadata in Plato config. Codex persists and refreshes the OAuth tokens in its own auth store.

As the service grows, keep the domain language centered on `task`, `session`, `worktree`, `interrupt`, and `resume`. Those concepts are already the backbone of the implementation and should stay visible in the public API.

## Startup Recovery

`CodexRunnerService.reconcileRunningTasks()` is the startup recovery entrypoint for durable runner state. It scans persisted `running` tasks, checks the active session record, and reconciles orphaned tasks with missing or terminal sessions into `interrupted` or `failed`.

Recovery preserves the stored `worktreePath`, clears the stale active session pointer, and appends a `task.reconciled` event so operators can see that the state changed during reconciliation rather than during normal session exit handling.

## Development Notes

- Install dependencies from the repo root with `pnpm install`.
- Run tests with `pnpm --filter @plato/codex-runner test`.
- Run adapter tests with `pnpm --filter @plato/codex-runner test -- codex-agent-runtime.test.ts`.
- Run type-checking with `pnpm --filter @plato/codex-runner typecheck`.

Implementation rules for agents and contributors in this workspace live in [AGENTS.md](/Users/macbook/work/plato/services/codex-runner/AGENTS.md).
