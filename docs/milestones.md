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

## Milestone 6: Smarter Decomposition and Policies

Goal: improve the quality and safety of decomposition and coordination.

Deliverables:

- decomposition policies and templates for common task classes
- approval checkpoints for risky or high-impact subtask plans
- verification hooks per subtask and per final synthesis
- scheduling policies for priority, retries, and dependency-aware execution

What this unlocks:

Faster and better task completion with more predictable behavior and fewer wasted worker runs.

## Immediate Next Step

The next implementation milestone should be Milestone 2: Durable Subtask Graph.

That is the smallest meaningful product step because it introduces the core orchestration object model Plato needs before parallel worker spawning, result synthesis, and MCP control surfaces can be built safely.
