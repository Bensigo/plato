# MVP Acceptance

M34 defines the first end-to-end MVP acceptance signal for Plato as an
orchestration layer.

## Fast Acceptance Smoke

Run the deterministic smoke from the repository root:

```sh
pnpm --filter @bensigo/plato-cli smoke
```

The command passes when the JSON summary reports every check as `true`.

The deterministic smoke proves the local caller-facing loop:

- accepts a top-level task
- decomposes the task through `plato delegate start`
- validates the generated decomposition plan before graph creation
- starts the worker graph from the validated plan
- records readable graph lifecycle events
- exposes worker results and final parent synthesis through `plato graph results`
- exposes review readiness through `plato review graph`
- preserves interrupt and resume control signals for task debugging

## MVP Bar

For MVP acceptance, Plato does not need to prove that every runtime worker
produces perfect code. It must prove that the orchestration surface can accept a
task, produce a reviewable plan, gate execution on validation, run worker tasks,
synthesize the final outcome, and expose enough state for an operator or calling
agent to understand what happened.

The deterministic smoke is the required fast check for CLI handler changes.
MCP surface changes should also run the MCP transport/tool tests in
`apps/plato-cli/test/plato-cli.test.ts`. The real Codex smoke in
[local-task-smoke.md](/Users/macbook/work/plato/docs/local-task-smoke.md) is
the follow-up manual check when local Codex auth and a disposable workspace are
available.
