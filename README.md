# Plato

Plato is a monorepo for a local-first CLI/MCP orchestration layer that helps personal agents complete complex work faster and better. The long-term product goal is to let agents such as Hermes or OpenClaw decompose a larger task into smaller subtasks, spawn multiple worker agents in parallel, and coordinate their results into one completed outcome.

The repo is split into user-facing applications in `apps/` and backend or infrastructure services in `services/`, with each workspace owning a clear slice of behavior.

## What Lives Here

```text
.
├── apps/
│   ├── desktop/          # User-facing desktop entrypoint
│   └── plato-cli/        # CLI and MCP orchestration surface
├── services/
│   ├── codex-runner/     # Codex task execution and orchestration
│   ├── config/           # Local Plato configuration and auth status
│   ├── db/               # Database code, migrations, and clients
│   ├── github-server/    # GitHub-facing integrations
│   └── orchestration/    # Agent-agnostic task and graph contracts
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
- `apps/plato-cli` owns the agent-facing CLI and MCP product surface.
- `services/orchestration` owns the agent-agnostic task, graph, event, and runtime contracts.
- `services/codex-runner` is the current Codex execution backend behind those contracts.
- `services/config` owns local Plato configuration and Codex auth status.
- `services/db` is reserved for database-related code, migrations, and clients.
- `services/github-server` is reserved for GitHub-facing integrations.

Each workspace should be understandable on its own. Service-specific design details belong in that workspace's local README and `AGENTS.md`.

## Product Goal

Plato is aiming to be the execution and orchestration layer a personal agent can call when a task is too large for a single serial run. In practical terms, that means Plato should eventually:

- accept a top-level task from a personal agent
- decompose that task into smaller, explicit subtasks
- spawn multiple worker agents to handle those subtasks in parallel
- isolate each unit of work so concurrent execution stays safe
- preserve enough state and event history to inspect, interrupt, resume, and recover work
- merge subtask outcomes back into one understandable result for the calling agent

## Current Direction

The current implementation is still closer to the foundation than the full multi-agent product. One active direction in the monorepo is separating Plato's orchestration model from any single agent backend while keeping reliable agent execution rather than one-off scripts. In practical terms, that means:

- tasks should move through explicit lifecycle states
- product-facing task contracts should stay agent-agnostic
- work should happen in isolated git worktrees
- session output should be captured as durable events
- interrupted work should stay recoverable instead of being discarded

Those ideas are currently split between `services/orchestration`, which defines the neutral product boundary, and `services/codex-runner`, which provides the first concrete execution backend.

## Current Status

Today, Plato most concretely provides the execution backbone and first agent-agnostic boundary for that future system:

- neutral orchestration contracts for tasks, graphs, events, and agent runtimes
- initial CLI and MCP tool/resource surface over those orchestration contracts
- queueing and lifecycle management for Codex-backed tasks
- isolated git worktrees per task
- runtime readiness checks and bootstrap
- session start, interruption, and resume
- durable task/session state
- structured event capture for inspection and recovery

That means the repo already has the beginnings of a trustworthy execution layer, a clean place for future agent adapters, and the first caller-facing surface for MCP/CLI integrations.

## Getting Started

1. Install dependencies with `pnpm install`.
2. Run workspace tasks from the repo root with `pnpm turbo run <task>`.
3. Make changes in the workspace that owns the behavior instead of adding cross-repo helpers by default.

## Contributor Workflow

- Work in small milestones.
- Use a dedicated branch per milestone.
- Push each milestone branch and open a PR before building the next step on top of it.
- Keep tests and contracts close to the workspace that owns the behavior.

The current milestone path for the product is documented in [docs/milestones.md](/Users/macbook/work/plato/docs/milestones.md).

For service-specific guidance on Codex execution, start with [services/codex-runner/README.md](/Users/macbook/work/plato/services/codex-runner/README.md) and [services/codex-runner/AGENTS.md](/Users/macbook/work/plato/services/codex-runner/AGENTS.md).
