# Codex Runner

`@plato/codex-runner` is a service inside the Plato monorepo. It owns the lifecycle of a Codex task from queueing through worktree setup, runtime checks, session start, interruption, resume, and event capture.

This package is not the whole project and should not describe the whole monorepo. Its job is narrower: provide the service boundary that lets the rest of Plato ask for agent work in a predictable way and recover what happened later.

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

As the service grows, keep the domain language centered on `task`, `session`, `worktree`, `interrupt`, and `resume`. Those concepts are already the backbone of the implementation and should stay visible in the public API.

## Startup Recovery

`CodexRunnerService.reconcileRunningTasks()` is the startup recovery entrypoint for durable runner state. It scans persisted `running` tasks, checks the active session record, and reconciles orphaned tasks with missing or terminal sessions into `interrupted` or `failed`.

Recovery preserves the stored `worktreePath`, clears the stale active session pointer, and appends a `task.reconciled` event so operators can see that the state changed during reconciliation rather than during normal session exit handling.

## Development Notes

- Install dependencies from the repo root with `pnpm install`.
- Run tests with `pnpm --filter @plato/codex-runner test`.
- Run type-checking with `pnpm --filter @plato/codex-runner typecheck`.

Implementation rules for agents and contributors in this workspace live in [AGENTS.md](/Users/macbook/work/plato/services/codex-runner/AGENTS.md).
