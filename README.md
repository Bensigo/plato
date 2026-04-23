# Plato

Plato is a monorepo for building agent-driven products and infrastructure. The repo is split into user-facing applications in `apps/` and backend or infrastructure services in `services/`, with each workspace owning a clear slice of behavior.

## What Lives Here

```text
.
├── apps/
│   └── desktop/          # User-facing desktop entrypoint
├── services/
│   ├── codex-runner/     # Codex task execution and orchestration
│   ├── db/               # Database code, migrations, and clients
│   └── github-server/    # GitHub-facing integrations
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── turbo.json
```

## How To Read The Repo

- `apps/` contains product surfaces.
- `services/` contains infrastructure and backend capabilities that those surfaces depend on.
- Each workspace should own its behavior directly instead of pushing shared abstractions upward too early.
- Workspace-local `AGENTS.md` files add implementation rules for contributors and coding agents working in that area.

## Workspace Snapshot

- `apps/desktop` is the current desktop application entrypoint.
- `services/codex-runner` is the current execution and orchestration service for Codex-powered work.
- `services/db` is reserved for database-related code, migrations, and clients.
- `services/github-server` is reserved for GitHub-facing integrations.

Each workspace should be understandable on its own. Service-specific design details belong in that workspace's local README and `AGENTS.md`.

## Current Direction

One active direction in the monorepo is reliable agent execution rather than one-off scripts. In practical terms, that means:

- tasks should move through explicit lifecycle states
- work should happen in isolated git worktrees
- session output should be captured as durable events
- interrupted work should stay recoverable instead of being discarded

Those ideas are currently most concrete in `services/codex-runner`, but they do not define the entire monorepo by themselves.

## Getting Started

1. Install dependencies with `pnpm install`.
2. Run workspace tasks from the repo root with `pnpm turbo run <task>`.
3. Make changes in the workspace that owns the behavior instead of adding cross-repo helpers by default.

## Contributor Workflow

- Work in small milestones.
- Use a dedicated branch per milestone.
- Push each milestone branch and open a PR before building the next step on top of it.
- Keep tests and contracts close to the workspace that owns the behavior.

For service-specific guidance on Codex execution, start with [services/codex-runner/README.md](/Users/macbook/work/plato/services/codex-runner/README.md) and [services/codex-runner/AGENTS.md](/Users/macbook/work/plato/services/codex-runner/AGENTS.md).
