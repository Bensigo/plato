# Plato Milestones

This roadmap turns Plato's product goal into reviewable milestones.

## Product Target

Plato should become a local-first CLI/MCP orchestration layer for personal agents such as Hermes and OpenClaw. A calling agent should be able to hand Plato a larger task, let Plato decompose it into smaller subtasks, spawn multiple worker agents to execute those subtasks in parallel, and receive one coordinated final outcome.

The milestones below keep that path incremental so each step can be reviewed and shipped independently.

## Milestone 1: Product Positioning and Shared Language

Goal: align the repo story around task decomposition and multi-agent orchestration instead of only single-run execution.

Deliverables:

- root docs describe Plato as a CLI/MCP orchestration layer for personal agents
- runner docs explain the current foundation versus the long-term multi-agent target
- milestone roadmap exists in the repo so follow-on work has a clear order

Why this comes first:

The implementation is still foundational. Tightening the product language first keeps future design and review discussions pointed at the same target.

## Milestone 2: Durable Subtask Graph

Goal: teach the runner to represent one parent task and many child tasks explicitly.

Deliverables:

- durable parent/child task relationships
- explicit subtask states and dependency metadata
- event model updates for graph creation and subtask lifecycle changes
- unit tests for decomposition and dependency state transitions

What this unlocks:

Plato can represent decomposed work as a first-class graph instead of treating every unit as an unrelated standalone task.

## Milestone 3: Multi-Agent Worker Execution

Goal: let Plato run multiple child tasks concurrently under one coordinated parent task.

Deliverables:

- coordinator flow that can spawn worker tasks from a parent task
- configurable concurrency limits
- separate worktree/session isolation per worker
- interruption and resume semantics for both parent and child tasks
- failure propagation rules from worker tasks back to the parent task

What this unlocks:

Real parallel execution rather than only durable single-task execution.

## Milestone 4: Result Collection and Synthesis

Goal: make parallel execution useful by turning worker output into one final answer.

Deliverables:

- durable result artifacts or structured worker summaries
- parent-task synthesis step
- explicit handling for partial success, conflicting outputs, and verification failures
- event and inspection APIs that show both per-worker output and final synthesis

What this unlocks:

Plato becomes an orchestration layer that produces a coordinated outcome instead of a bag of separate worker runs.

## Milestone 5: MCP and CLI Product Surface

Goal: expose the orchestration model to upstream personal agents in a stable way.

Deliverables:

- MCP tools for starting decomposed tasks, inspecting task graphs, and controlling execution
- CLI commands for operators to inspect parent/child tasks, events, approvals, and resumptions
- stable task graph snapshots and event resources for agent integrations

What this unlocks:

Hermes, OpenClaw, or other personal agents can call Plato as a reusable local orchestration tool instead of embedding orchestration logic directly.

Current M24 scope:

- protocol-neutral `plato.*` operation descriptors over `@bensigo/plato-orchestration`
- JSON-friendly command response envelopes for tasks, graphs, events, controls, and graph results
- `@bensigo/plato-cli` as the first CLI/MCP-facing app package
- MCP tool/resource registration for the neutral product surface

Current M26 scope:

- stdio MCP server entrypoint through `plato mcp`
- dedicated `plato-mcp` bin for agent configurations
- runtime-backed MCP server connection using the same neutral orchestration bootstrap
- smoke coverage for MCP tool discovery and tool calls over an MCP transport

Current M27 scope:

- deterministic `plato smoke` command for the local task lifecycle surface
- smoke coverage for task start, status, list, and events through CLI handlers
- first-run documentation for real Codex-backed local smoke testing with explicit temp storage
- debugging guidance for missing auth, runtime, repo path, worktree, and event inspection issues

Current M28 scope:

- reviewable task decomposition plan contracts before graph execution
- deterministic validation for worker context, boundaries, tools, dependencies, documentation evidence, and verification steps
- Context7-first documentation evidence for framework, SDK, API, MCP, and tool behavior used by a plan
- read-only CLI/MCP planning and validation operations before `create_task_graph`
- testing, review, git branch, and PR gates for each decomposition milestone slice

## Milestone 5a: Agent-Agnostic Orchestration Boundary

Goal: keep Plato's product-facing orchestration model independent from any one agent backend.

Deliverables:

- neutral task, graph, event, result, and agent runtime contracts
- a small orchestration service that routes work to registered agent runtimes
- a Codex runner adapter as the first backend implementation
- tests proving orchestration callers do not depend on Codex-specific fields
- docs that make the boundary explicit before MCP is added

What this unlocks:

MCP and future CLI surfaces can speak Plato orchestration concepts while Codex, Hermes, OpenClaw, or other agent runtimes plug in behind the same boundary.

## Milestone 6: Smarter Decomposition and Policies

Goal: improve the quality and safety of decomposition and coordination.

Deliverables:

- decomposition policies and templates for common task classes
- approval checkpoints for risky or high-impact subtask plans
- verification hooks per subtask and per final synthesis
- scheduling policies for priority, retries, and dependency-aware execution

What this unlocks:

Faster and better task completion with more predictable behavior and fewer wasted worker runs.

## Remaining MVP Path

M28 established the reviewable decomposition plan and validation gate. The
remaining MVP work should focus on turning that plan into a complete orchestration
loop.

### M29: Real Delegate Execution

Goal: execute validated delegate plans through the worker graph.

Deliverables:

- default flow from top-level task to plan, validation, worker graph start, and status inspection
- execution through the validated plan gate instead of raw graph inputs
- worker graph creation from `plato.delegate_task_plan` output
- tests proving invalid plans do not start workers

### M30: Worker Result Synthesis

Goal: turn parallel worker output into one coordinated parent result without
changing the CLI/MCP-facing orchestration contract shape.

Already in place:

- neutral worker result and parent synthesis records with `completed`,
  `partial`, `failed`, and `conflicted` classifications
- graph result snapshots that include per-worker results plus an optional parent
  synthesis record
- orchestration events that can reference result and synthesis identifiers
- `plato.get_task_graph_results`, `plato graph results`, and the
  `plato graph synthesis` alias for inspecting graph result snapshots
- Codex runner storage and adapter mapping for worker results and parent
  syntheses

Next reviewable slice:

- collect one durable worker result per terminal child task through the existing
  result snapshot contracts
- synthesize the parent record once all child results are available
- reconcile already-terminal child tasks before returning graph result
  inspection snapshots
- preserve partial, failed, and conflicted classifications in storage, events,
  and CLI/MCP inspection output
- add focused coverage around result collection, synthesis readiness, and graph
  result inspection rather than changing app runtime behavior outside the
  worker result path

### M31: Smarter Decomposition Policies

Goal: improve decomposition quality beyond the deterministic baseline.

Deliverables:

- task-class templates for CLI/MCP, backend service, docs, frontend, and infrastructure work
- workspace-specific verification command selection
- safer default write scopes
- approval rules based on risk and tool use

Current M31 scope:

- deterministic task-class policy templates for CLI/MCP, backend service, docs,
  frontend, and infrastructure briefs
- safer default write scopes, including narrower service defaults when the brief
  names a known service
- policy-specific verification commands and acceptance criteria while preserving
  caller-provided overrides
- approval-gated publishing handoff preserved for generated review workers

### M32: Operator Review UX

Goal: make the review loop usable by humans and calling agents.

Deliverables:

- commands and MCP tools for pending plans, approval-gated steps, worker status, validation failures, and final synthesis
- clear review output that explains worker boundaries, dependencies, allowed tools, and verification requirements
- operator-friendly failure messages for blocked or invalid plans

### M33: Runtime Hardening

Goal: make delegated execution resilient enough for MVP use.

Deliverables:

- resume and interruption behavior for delegated task graphs
- failure propagation and retry policy
- worktree and session isolation checks
- richer event history for debugging delegated runs

### M34: MVP End-to-End Smoke

Goal: prove the complete Plato orchestration loop.

Deliverables:

- one CLI command or MCP flow that takes a top-level task, decomposes it, validates it, runs workers, synthesizes results, and exposes the final outcome
- deterministic smoke coverage for the full loop
- MVP acceptance documentation

Current M34 scope:

- `plato smoke` drives the full deterministic delegate loop through
  `plato delegate start`, graph result inspection, graph review, and lifecycle
  events
- the smoke summary reports decomposition, validation, final synthesis, and
  review readiness checks as explicit acceptance signals
- MVP acceptance criteria live in `docs/mvp-acceptance.md`

Shortest MVP route:

1. M31: improve deterministic decomposition policies.
2. M32/M33: make review and hardening output usable enough for MVP smoke.
3. M34: prove the end-to-end smoke.

M31 through M33 improve quality and reliability, but M29, M30, and M34 are the
core path to "Plato works as an orchestration layer."

## Immediate Next Step

Review and merge M31 through M34 in order:

1. M31: smarter deterministic decomposition policies.
2. M32/M33: operator review surfaces and runtime smoke hardening.
3. M34: MVP end-to-end acceptance smoke.

After those PRs land, the next roadmap step should move from deterministic MVP
acceptance into a real Codex-backed smoke run against a disposable workspace.
