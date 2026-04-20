# Plato

Plato is organized as a monorepo with application code under `apps/` and backend or infrastructure services under `services/`.

## Structure

```text
.
├── apps/
│   └── desktop/
├── services/
│   ├── codex-runner/
│   ├── db/
│   └── github-server/
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── turbo.json
```

## Workspace Packages

- `apps/desktop`: desktop application entrypoint
- `services/db`: database-related code, migrations, and clients
- `services/codex-runner`: execution or orchestration service for Codex jobs
- `services/github-server`: GitHub-facing server integrations

## Getting Started

1. Install dependencies with `pnpm install`.
2. Add code inside the relevant workspace package.
3. Run workspace scripts from the root with `pnpm turbo run <task>`.

This repo uses `pnpm` workspaces and `turbo` for orchestration.
