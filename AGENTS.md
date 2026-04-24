# Plato Monorepo Guidelines

## Purpose

Plato is a monorepo with user-facing applications in `apps/` and backend or infrastructure services in `services/`. Each workspace should stay focused on a clear responsibility and expose clean boundaries to the rest of the repo.

## Monorepo Rules

- Prefer adding behavior in the most specific workspace that owns it instead of creating cross-cutting helpers too early.
- Decouple things that can be decoupled. Product-facing contracts should not depend on a specific backend when a narrow interface or adapter can preserve the boundary.
- Keep service boundaries explicit. Shared concepts should be modeled through contracts and interfaces, not hidden coupling.
- When a workspace has its own `AGENTS.md`, follow the workspace-local rules in addition to these repo-level rules.

## Delivery Workflow

- Always work in milestones.
- Create a dedicated branch for each milestone.
- Push every milestone branch to GitHub.
- Open a pull request for each milestone so the work can be reviewed before the next milestone grows on top of it.
- Keep milestone scope small enough that review can focus on one meaningful step forward.

## Engineering Standards

- Default to TDD for new domain behavior and service contracts.
- Prefer small, testable components with side effects behind interfaces.
- Make failure modes explicit in contracts and tests.
- Preserve state that is needed for recovery or debugging instead of silently discarding it.

## Repository Layout

- `apps/`: application entrypoints and app-specific code
- `services/`: backend, execution, persistence, and integration services
- root config files: workspace, TypeScript, and turbo orchestration
