# Codex Runner

`@plato/codex-runner` is a service inside the Plato monorepo. It owns the lifecycle of Codex-backed execution from queueing through worktree setup, runtime checks, session start, interruption, resume, and event capture.

This package is not the whole project and should not describe the whole monorepo. Its job is narrower: provide the service boundary that lets the rest of Plato ask for agent work in a predictable way and recover what happened later.

In the larger Plato product, this service is the execution substrate for a future multi-agent orchestration flow. Plato's end goal is to help personal agents such as Hermes or OpenClaw decompose larger tasks into smaller subtasks, spawn multiple worker agents in parallel, and coordinate their results into one final outcome. `codex-runner` is the durability and execution layer that makes that orchestration believable.

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

## What Codex Runner Is Becoming

The longer-term role of this workspace is to be one of Plato's core execution services for agent work:

- a stable service contract for submitting and inspecting tasks
- strong isolation between tasks via git worktrees
- resumable execution that preserves debugging context
- adapters around side effects so scheduling and lifecycle rules remain unit-testable

The next product step beyond the current foundation is not "more task execution" in the abstract. It is explicit support for parent tasks, child tasks, worker coordination, and result synthesis so Plato can evolve from a durable single-task runner into the orchestration core for a personal multi-agent system.

## Task Graphs

`CodexRunnerService.createTaskGraph()` is the durable admission path for submitting one parent task with one or more child tasks. The parent and children are persisted through the store as one graph operation before scheduling begins, and each child is recorded with a `subtask` decomposition that points back to the parent task id. Children can also declare `dependencyTaskIds`; the scheduler only starts queued graph workers after every declared prerequisite has completed.

Operators can inspect graph state with `getTaskGraph(taskId)` or `codex-runner graph status <taskId>`. Passing either a parent id or child id returns the parent, immediate children, dependencies, and aggregate graph state. Parent-scoped graph lifecycle events are emitted when the graph is created and when child tasks complete or fail. Worker/dependency events are emitted on child task streams when a dependency is satisfied, when a worker starts, or when a failed prerequisite blocks a dependent worker.

The CLI accepts `--max-concurrent-tasks <n>` on `start` and `graph start` to tune how many runner tasks may be active at once for that operator runtime.

As the service grows, keep the domain language centered on `task`, `session`, `worktree`, `interrupt`, and `resume`. Those concepts are already the backbone of the implementation and should stay visible in the public API.

## Startup Recovery

`CodexRunnerService.reconcileRunningTasks()` is the startup recovery entrypoint for durable runner state. It scans persisted `running` tasks, checks the active session record, and reconciles orphaned tasks with missing or terminal sessions into `interrupted` or `failed`.

Recovery preserves the stored `worktreePath`, clears the stale active session pointer, and appends a `task.reconciled` event so operators can see that the state changed during reconciliation rather than during normal session exit handling.

## Development Notes

- Install dependencies from the repo root with `pnpm install`.
- Run tests with `pnpm --filter @plato/codex-runner test`.
- Run type-checking with `pnpm --filter @plato/codex-runner typecheck`.

Implementation rules for agents and contributors in this workspace live in [AGENTS.md](/Users/macbook/work/plato/services/codex-runner/AGENTS.md).
