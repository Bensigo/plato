# Codex Runner Service Guidelines

## Purpose

This service owns Codex task execution inside Plato. It is responsible for task admission, git worktree isolation, Codex session lifecycle, process supervision, interruption and resume, and structured event streaming.

Future readers should understand this workspace as the beginning of Plato's durable agent execution layer, not just a place to shell out to Codex. Changes here should make task behavior more explicit, more recoverable, and easier to inspect from outside the process.

## Design Rules

- Keep the public service API small and explicit.
- Prefer pure domain logic for scheduling and state transitions.
- Put side effects behind interfaces so the core service is easy to unit test.
- Model task and session state as explicit string unions; do not hide lifecycle state in booleans.
- Preserve interrupted state and worktree paths; never silently discard task execution state.
- Treat logs as structured events first, text second.

## Agent Working Rules

- Preserve the core domain nouns: `task`, `session`, `worktree`, `runtime`, and `event`.
- Keep lifecycle transitions centralized. If a new transition is needed, add it in one place and test it there.
- Do not erase recovery context. Interrupted tasks should keep the worktree path and any session history needed for resume or debugging.
- Prefer adding a narrow interface over reaching directly into process, filesystem, or git code from service logic.
- When you add runner behavior, update the local README or this file if the new behavior changes how contributors should reason about the service.
- Keep write scope tight. This workspace is likely to evolve in parallel with adjacent services.

## Service Direction

`codex-runner` is becoming the service boundary that other parts of Plato can trust to run agent work safely. A good change in this workspace usually strengthens one of these properties:

- deterministic task state
- clear worktree ownership
- durable event history
- resumable execution
- testable side-effect boundaries

Be cautious about changes that make lifecycle state implicit, hide failures behind booleans, or blur the difference between a task record and a running session.

## Testing Rules

- Use TDD for new runner behavior.
- Start with service-level unit tests over `CodexRunnerService`.
- Prefer in-memory fakes for `RunnerStore`, `ProcessPool`, `WorktreeManager`, and `LogStreamer`.
- Add integration tests only after the domain contract is stable.

## Code Style

- Keep files focused on one responsibility.
- Use descriptive type names for runner contracts.
- Avoid framework-heavy abstractions in the core service layer.
- Add short comments only where state transitions or scheduling behavior are non-obvious.
- Prefer small, explicit interfaces over implicit objects with optional behavior.
- Make failure modes part of the design. If a dependency can fail, the service contract should make that visible and testable.
- Keep public method names aligned with the runner language used across Plato: task, session, worktree, interrupt, resume.
- Validate state transitions in one place instead of spreading lifecycle rules across many files.
