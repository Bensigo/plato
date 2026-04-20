# Codex Runner Service Guidelines

## Purpose

This service owns Codex task execution inside Plato. It is responsible for task admission, git worktree isolation, Codex session lifecycle, process supervision, interruption and resume, and structured event streaming.

## Design Rules

- Keep the public service API small and explicit.
- Prefer pure domain logic for scheduling and state transitions.
- Put side effects behind interfaces so the core service is easy to unit test.
- Model task and session state as explicit string unions; do not hide lifecycle state in booleans.
- Preserve interrupted state and worktree paths; never silently discard task execution state.
- Treat logs as structured events first, text second.

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
