# Local Task Smoke

M27 adds a repeatable smoke path for Plato's caller-facing task flow.

The smoke path has two layers:

- deterministic smoke, which uses an in-memory fake runtime and can run on any development machine
- real Codex smoke, which exercises the runtime-backed CLI against local Codex auth and a real repository

## Deterministic Smoke

Run this from the repository root:

```sh
pnpm --filter @plato/cli smoke
```

This command builds `@plato/cli`, then runs:

```sh
node dist/src/cli.js smoke
```

The smoke command drives the real CLI handlers with a deterministic in-memory
orchestration client. It verifies that a task can be started, inspected through
status, listed, and inspected through events without requiring Codex auth.

Successful output looks like:

```json
{
  "taskId": "plato-smoke-task",
  "workspacePath": "/path/to/plato",
  "checks": {
    "started": true,
    "statusReadable": true,
    "eventsReadable": true,
    "listed": true
  },
  "eventTypes": ["task.queued", "task.started", "task.completed"]
}
```

Use this as the fast health check after CLI/MCP surface changes.

## Real Codex Smoke

The real smoke path needs local Codex auth and a repository that Codex can work
inside.

First check auth:

```sh
pnpm --filter @plato/codex-runner build
node services/codex-runner/dist/src/cli.js config status
```

If auth is missing, configure one auth mode:

```sh
printf '%s' "$OPENAI_API_KEY" | node services/codex-runner/dist/src/cli.js config set-openai-key --api-key-stdin
```

or:

```sh
node services/codex-runner/dist/src/cli.js config auth-chatgpt
```

Then build the CLI:

```sh
pnpm --filter @plato/cli build
```

Use explicit temporary storage so the smoke run does not mix with normal local
state:

```sh
SMOKE_DIR="$(mktemp -d /tmp/plato-smoke.XXXXXX)"
TASK_ID="plato-real-smoke"

node apps/plato-cli/dist/src/cli.js task start \
  --task-id "$TASK_ID" \
  --workspace-path "$PWD" \
  --prompt "Inspect this repository and summarize the package layout." \
  --db-path "$SMOKE_DIR/runner.sqlite" \
  --log-path "$SMOKE_DIR/events.json"
```

Inspect the task:

```sh
node apps/plato-cli/dist/src/cli.js task status \
  --task-id "$TASK_ID" \
  --db-path "$SMOKE_DIR/runner.sqlite" \
  --log-path "$SMOKE_DIR/events.json"
```

Inspect events:

```sh
node apps/plato-cli/dist/src/cli.js task events \
  --task-id "$TASK_ID" \
  --db-path "$SMOKE_DIR/runner.sqlite" \
  --log-path "$SMOKE_DIR/events.json"
```

For MVP validation, the important signal is not that Codex always produces a
perfect answer. The important signal is that Plato accepts the task, records a
clear lifecycle state, persists events, and reports useful errors for auth,
runtime, worktree, or repository problems.

## What To Debug

- Missing auth: run `config status` and configure API key or ChatGPT auth.
- Missing Codex runtime: inspect task events for runtime readiness or install events.
- Invalid repository path: rerun with an absolute `--workspace-path`.
- Worktree setup failure: inspect task events and the temporary smoke directory.
- Interrupted or failed task: preserve the smoke directory until the state and events are understood.
