import type {
  AgentSession,
  AgentSessionFactory,
  CodexRuntimeManager,
  ContextPackageRecord,
  CreateTaskGraphInput,
  LogStreamer,
  RequestTaskApprovalInput,
  RunnerStore,
  RunnerTaskGraphSnapshot,
  RunnerTaskGraphResultSnapshot,
  RunnerTaskGraphState,
  RunnerSessionRecord,
  RunnerTaskStatusSnapshot,
  RunnerTaskRecord,
  RunnerTaskState,
  SessionStore,
  StartTaskInput,
  ParentTaskOutcomeSynthesizer,
  TaskResultCollector,
  TaskResultVerifier,
  TaskVerificationResult,
  WorkerTaskResultRecord,
  WorktreeAllocation,
  WorktreeManager,
} from "./contracts.js";
import { WorktreeProvisioningError } from "./contracts.js";
import { CodexSdkBackedAgentSessionFactory } from "./session/codex-sdk-backed-agent-session.js";

export interface CodexRunnerServiceDeps {
  store: RunnerStore;
  sessionStore: SessionStore;
  worktreeManager: WorktreeManager;
  logStreamer: LogStreamer;
  agentSessionFactory?: AgentSessionFactory;
  runtimeManager?: CodexRuntimeManager;
  taskResultVerifier?: TaskResultVerifier;
  taskResultCollector?: TaskResultCollector;
  parentTaskOutcomeSynthesizer?: ParentTaskOutcomeSynthesizer;
  maxConcurrentTasks?: number;
}

export class CodexRunnerService {
  readonly #store: RunnerStore;
  readonly #sessionStore: SessionStore;
  readonly #worktreeManager: WorktreeManager;
  readonly #logStreamer: LogStreamer;
  readonly #agentSession: AgentSession;
  readonly #runtimeManager?: CodexRuntimeManager;
  readonly #taskResultVerifier?: TaskResultVerifier;
  readonly #taskResultCollector: TaskResultCollector;
  readonly #parentTaskOutcomeSynthesizer: ParentTaskOutcomeSynthesizer;
  readonly #maxConcurrentTasks: number;
  #scheduleInFlight?: Promise<void>;
  #scheduleAgain = false;

  constructor(deps: CodexRunnerServiceDeps) {
    this.#store = deps.store;
    this.#sessionStore = deps.sessionStore;
    this.#worktreeManager = deps.worktreeManager;
    this.#logStreamer = deps.logStreamer;
    const sessionFactory = deps.agentSessionFactory ?? new CodexSdkBackedAgentSessionFactory();
    this.#agentSession = sessionFactory.create(deps.logStreamer);
    this.#runtimeManager = deps.runtimeManager;
    this.#taskResultVerifier = deps.taskResultVerifier;
    this.#taskResultCollector = deps.taskResultCollector ?? new DefaultTaskResultCollector();
    this.#parentTaskOutcomeSynthesizer =
      deps.parentTaskOutcomeSynthesizer ?? new DefaultParentTaskOutcomeSynthesizer();
    this.#maxConcurrentTasks = deps.maxConcurrentTasks ?? 1;
  }

  async startTask(input: StartTaskInput): Promise<RunnerTaskRecord> {
    await this.#validateStartTaskInput(input);

    const task: RunnerTaskRecord = {
      taskId: input.taskId,
      repoPath: input.repoPath,
      prompt: input.prompt,
      priority: input.priority ?? 0,
      state: "queued",
      decomposition: input.decomposition,
    };

    await this.#store.saveTask(task);
    if (input.contextPackage) {
      await this.#store.saveContextPackage({
        taskId: task.taskId,
        summary: input.contextPackage.summary,
        sources: input.contextPackage.sources,
        artifacts: input.contextPackage.artifacts,
      });
    } else {
      await this.#store.deleteContextPackage(task.taskId);
    }
    await this.#logStreamer.append({ taskId: task.taskId, type: "task.queued" });
    await this.#scheduleQueuedTasks();

    return this.#requireTask(task.taskId);
  }

  async createTaskGraph(input: CreateTaskGraphInput): Promise<RunnerTaskGraphSnapshot> {
    await this.#validateCreateTaskGraphInput(input);

    const parent: RunnerTaskRecord = {
      taskId: input.parent.taskId,
      repoPath: input.parent.repoPath,
      prompt: input.parent.prompt,
      priority: input.parent.priority ?? 0,
      state: "queued",
      decomposition: input.parent.decomposition,
    };
    const children = input.children.map((child) => ({
      taskId: child.taskId,
      repoPath: child.repoPath ?? input.parent.repoPath,
      prompt: child.prompt,
      priority: child.priority ?? 0,
      state: "queued" as const,
      decomposition: {
        kind: "subtask" as const,
        parentTaskId: parent.taskId,
        ...((child.dependencyTaskIds?.length ?? 0) > 0
          ? { dependencyTaskIds: child.dependencyTaskIds }
          : {}),
      },
    }));
    const contextPackages: ContextPackageRecord[] = [
      ...(input.parent.contextPackage
        ? [{
            taskId: parent.taskId,
            summary: input.parent.contextPackage.summary,
            sources: input.parent.contextPackage.sources,
            artifacts: input.parent.contextPackage.artifacts,
          }]
        : []),
      ...input.children.flatMap((child) =>
        child.contextPackage
          ? [{
              taskId: child.taskId,
              summary: child.contextPackage.summary,
              sources: child.contextPackage.sources,
              artifacts: child.contextPackage.artifacts,
            }]
          : [],
      ),
    ];

    await this.#store.saveTaskGraph([parent, ...children], contextPackages);
    await this.#logStreamer.append({
      taskId: parent.taskId,
      type: "task.graph.created",
      graphState: "queued",
      message: `Created task graph with ${children.length} child task${children.length === 1 ? "" : "s"}`,
    });
    for (const task of [parent, ...children]) {
      await this.#logStreamer.append({ taskId: task.taskId, type: "task.queued" });
    }
    await this.#scheduleQueuedTasks();

    const graph = await this.getTaskGraph(parent.taskId);
    if (!graph) {
      throw new Error(`Task graph ${parent.taskId} was not found after creation`);
    }

    return graph;
  }

  async interruptTask(taskId: string): Promise<void> {
    const task = await this.#requireTask(taskId);
    const interruptedTask: RunnerTaskRecord = {
      ...task,
      state: "interrupted",
      activeSessionId: undefined,
    };

    await this.#store.saveTask(interruptedTask);
    if (task.activeSessionId) {
      await this.#sessionStore.saveSession({
        sessionId: task.activeSessionId,
        taskId: task.taskId,
        worktreePath: task.worktreePath ?? "",
        state: "interrupted",
      });
    }
    await this.#logStreamer.append({
      taskId,
      type: "task.interrupted",
      worktreePath: interruptedTask.worktreePath,
    });
    if (task.activeSessionId) {
      await this.#agentSession.interrupt(task.activeSessionId);
    }
    await this.#scheduleQueuedTasks();
  }

  async resumeTask(taskId: string): Promise<RunnerTaskRecord> {
    const task = await this.#requireTask(taskId);
    if (task.state !== "interrupted") {
      throw new Error(`Task ${taskId} is not interrupted`);
    }

    if (!task.worktreePath) {
      throw new Error(`Task ${taskId} cannot be resumed without a worktree`);
    }

    return this.#resumeTaskWithAllocation(task);
  }

  async requestTaskApproval(taskId: string, input: RequestTaskApprovalInput): Promise<RunnerTaskRecord> {
    const task = await this.#requireTask(taskId);
    const sessionId = input.sessionId ?? task.activeSessionId;
    if (task.state !== "running" || !sessionId) {
      throw new Error(`Task ${taskId} is not running with an active session`);
    }
    if (sessionId !== task.activeSessionId) {
      throw new Error(`Task ${taskId} approval session ${sessionId} is not the active session`);
    }

    const activeSession = await this.#sessionStore.getSession(sessionId);
    if (!activeSession || activeSession.taskId !== taskId || activeSession.state !== "running") {
      throw new Error(`Task ${taskId} approval session ${sessionId} is not active`);
    }

    const pendingApproval = {
      approvalRequestId: input.approvalRequestId,
      requestedAction: input.requestedAction,
      reason: input.reason,
      sessionId,
    };
    const awaitingApprovalTask: RunnerTaskRecord = {
      ...task,
      state: "awaiting_approval",
      pendingApproval,
    };

    await this.#store.saveTask(awaitingApprovalTask);
    await this.#saveSessionCheckpoint(task, {
      state: "awaiting_approval",
      pendingApproval,
    });
    await this.#logStreamer.append({
      taskId,
      type: "task.awaiting_approval",
      sessionId,
      worktreePath: task.worktreePath,
      approvalRequestId: pendingApproval.approvalRequestId,
      requestedAction: pendingApproval.requestedAction,
      message: pendingApproval.reason,
    });

    return awaitingApprovalTask;
  }

  async approveTaskAction(taskId: string): Promise<RunnerTaskRecord> {
    const task = await this.#requireApprovalTask(taskId);
    const clearedTask: RunnerTaskRecord = {
      ...task,
      pendingApproval: undefined,
    };

    await this.#logStreamer.append({
      taskId,
      type: "task.approval.granted",
      sessionId: task.pendingApproval.sessionId,
      worktreePath: task.worktreePath,
      approvalRequestId: task.pendingApproval.approvalRequestId,
      requestedAction: task.pendingApproval.requestedAction,
    });

    return this.#resumeTaskFromCheckpoint(clearedTask);
  }

  async rejectTaskAction(taskId: string, reason: string): Promise<RunnerTaskRecord> {
    const task = await this.#requireApprovalTask(taskId);
    const failedTask: RunnerTaskRecord = {
      ...task,
      state: "failed",
      activeSessionId: undefined,
      pendingApproval: undefined,
    };

    await this.#store.saveTask(failedTask);
    await this.#saveSessionCheckpoint(task, {
      state: "failed",
      pendingApproval: task.pendingApproval,
      exitCode: null,
    });
    await this.#logStreamer.append({
      taskId,
      type: "task.approval.rejected",
      sessionId: task.pendingApproval.sessionId,
      worktreePath: task.worktreePath,
      approvalRequestId: task.pendingApproval.approvalRequestId,
      requestedAction: task.pendingApproval.requestedAction,
      message: reason,
    });
    await this.#logStreamer.append({
      taskId,
      type: "task.failed",
      sessionId: task.pendingApproval.sessionId,
      worktreePath: task.worktreePath,
      errorCode: "TASK_APPROVAL_REJECTED",
      message: reason,
    });
    await this.#failQueuedDependents(failedTask);
    await this.#emitGraphLifecycleForTask(failedTask, {
      errorCode: "TASK_APPROVAL_REJECTED",
      message: reason,
    });
    await this.#scheduleQueuedTasks();

    return failedTask;
  }

  async #resumeTaskWithAllocation(task: RunnerTaskRecord): Promise<RunnerTaskRecord> {
    if (!(await this.#hasCapacity())) {
      const queuedTask: RunnerTaskRecord = {
        ...task,
        state: "queued",
      };

      await this.#store.saveTask(queuedTask);
      return queuedTask;
    }

    const allocation: WorktreeAllocation = {
      taskId: task.taskId,
      repoPath: task.repoPath,
      branchName: `plato/task-${task.taskId}`,
      worktreePath: task.worktreePath!,
    };
    return this.#startManagedTask(task, allocation, "task.resumed");
  }

  async getTask(taskId: string): Promise<RunnerTaskRecord | undefined> {
    return this.#store.getTask(taskId);
  }

  async listTasks(): Promise<RunnerTaskRecord[]> {
    return this.#store.listTasks();
  }

  async listTasksByState(state: RunnerTaskState): Promise<RunnerTaskRecord[]> {
    return this.#store.listTasksByState(state);
  }

  async getTaskStatus(taskId: string): Promise<RunnerTaskStatusSnapshot | undefined> {
    let task = await this.#store.getTask(taskId);
    if (!task) {
      return undefined;
    }

    if (task.state === "running") {
      const reconciledTask = await this.#reconcileRunningTask(task);
      if (reconciledTask) {
        task = reconciledTask;
        await this.#scheduleQueuedTasks();
      }
    }

    return {
      task,
      sessions: await this.#sessionStore.listSessionsByTask(taskId),
    };
  }

  async listSubtasks(taskId: string): Promise<RunnerTaskRecord[]> {
    await this.#requireTask(taskId);
    return this.#store.listChildTasks(taskId);
  }

  async getTaskGraph(taskId: string): Promise<RunnerTaskGraphSnapshot | undefined> {
    const task = await this.#store.getTask(taskId);
    if (!task) {
      return undefined;
    }

    const parentTask = task.decomposition ? await this.#store.getTask(task.decomposition.parentTaskId) : task;
    if (!parentTask) {
      return undefined;
    }

    const children = await this.#store.listChildTasks(parentTask.taskId);
    return {
      parent: parentTask,
      children,
      state: getGraphState(parentTask, children),
    };
  }

  async getTaskGraphResults(taskId: string): Promise<RunnerTaskGraphResultSnapshot | undefined> {
    const task = await this.#store.getTask(taskId);
    if (!task) {
      return undefined;
    }

    const parentTask = task.decomposition ? await this.#store.getTask(task.decomposition.parentTaskId) : task;
    if (!parentTask) {
      return undefined;
    }

    return {
      parentTaskId: parentTask.taskId,
      results: await this.#store.listWorkerTaskResults(parentTask.taskId),
      synthesis: await this.#store.getParentTaskSynthesis(parentTask.taskId),
    };
  }

  async reconcileTaskGraphResults(taskId: string): Promise<RunnerTaskGraphResultSnapshot | undefined> {
    const task = await this.#store.getTask(taskId);
    if (!task) {
      return undefined;
    }

    const parentTask = task.decomposition ? await this.#store.getTask(task.decomposition.parentTaskId) : task;
    if (!parentTask) {
      return undefined;
    }

    const children = await this.#store.listChildTasks(parentTask.taskId);
    for (const child of children) {
      if (child.state === "completed") {
        await this.#ensureWorkerResult(child, parentTask, {});
      }
      if (child.state === "failed") {
        await this.#ensureWorkerResult(child, parentTask, {
          errorCode: "TASK_RESULT_RECOVERED_FROM_FAILED_CHILD",
          message: `Recovered missing failed result for task ${child.taskId}.`,
        });
      }
    }

    if (children.length > 0 && children.every((child) => child.state === "completed" || child.state === "failed")) {
      await this.#ensureParentSynthesis(parentTask, children);
    }

    return this.getTaskGraphResults(parentTask.taskId);
  }

  async getContextPackage(taskId: string) {
    return this.#store.getContextPackage(taskId);
  }

  async listEvents(taskId: string) {
    return this.#logStreamer.list(taskId);
  }

  async reconcileRunningTasks(): Promise<RunnerTaskRecord[]> {
    const runningTasks = (await this.#store.listTasksByState("running"))
      .slice()
      .sort((left, right) => left.taskId.localeCompare(right.taskId));
    const reconciled: RunnerTaskRecord[] = [];

    for (const task of runningTasks) {
      const nextTask = await this.#reconcileRunningTask(task);
      if (nextTask) {
        reconciled.push(nextTask);
      }
    }

    await this.#scheduleQueuedTasks();

    return reconciled;
  }

  async #validateStartTaskInput(input: StartTaskInput): Promise<void> {
    if (!input.decomposition) {
      return;
    }

    if (input.decomposition.parentTaskId === input.taskId) {
      throw new Error(`Task ${input.taskId} cannot reference itself as a parent`);
    }

    const parentTask = await this.#store.getTask(input.decomposition.parentTaskId);
    if (!parentTask) {
      throw new Error(`Parent task ${input.decomposition.parentTaskId} was not found`);
    }
  }

  async #validateCreateTaskGraphInput(input: CreateTaskGraphInput): Promise<void> {
    if (input.parent.decomposition?.parentTaskId === input.parent.taskId) {
      throw new Error(`Task ${input.parent.taskId} cannot reference itself as a parent`);
    }

    const taskIds = [input.parent.taskId, ...input.children.map((child) => child.taskId)];
    const duplicateTaskId = findDuplicate(taskIds);
    if (duplicateTaskId) {
      throw new Error(`Task graph contains duplicate task id ${duplicateTaskId}`);
    }

    if (input.children.length === 0) {
      throw new Error("Task graph requires at least one child task");
    }

    const childTaskIds = new Set(input.children.map((child) => child.taskId));
    for (const child of input.children) {
      const dependencyTaskIds = child.dependencyTaskIds ?? [];
      const duplicateDependencyTaskId = findDuplicate(dependencyTaskIds);
      if (duplicateDependencyTaskId) {
        throw new Error(
          `Task graph child ${child.taskId} contains duplicate dependency ${duplicateDependencyTaskId}`,
        );
      }

      for (const dependencyTaskId of dependencyTaskIds) {
        if (dependencyTaskId === child.taskId) {
          throw new Error(`Task graph child ${child.taskId} cannot depend on itself`);
        }
        if (!childTaskIds.has(dependencyTaskId)) {
          throw new Error(
            `Task graph child ${child.taskId} depends on missing child task ${dependencyTaskId}`,
          );
        }
      }
    }
    const cycle = findChildDependencyCycle(input.children);
    if (cycle) {
      throw new Error(`Task graph child dependencies contain a cycle: ${cycle.join(" -> ")}`);
    }

    for (const taskId of taskIds) {
      if (await this.#store.getTask(taskId)) {
        throw new Error(`Task ${taskId} already exists`);
      }
    }

    if (input.parent.decomposition) {
      const parentTask = await this.#store.getTask(input.parent.decomposition.parentTaskId);
      if (!parentTask) {
        throw new Error(`Parent task ${input.parent.decomposition.parentTaskId} was not found`);
      }
    }
  }

  async #scheduleQueuedTasks(): Promise<void> {
    if (this.#scheduleInFlight) {
      this.#scheduleAgain = true;
      await this.#scheduleInFlight;
      return;
    }

    this.#scheduleInFlight = this.#runScheduleLoop();
    try {
      await this.#scheduleInFlight;
    } finally {
      this.#scheduleInFlight = undefined;
      if (this.#scheduleAgain) {
        this.#scheduleAgain = false;
        await this.#scheduleQueuedTasks();
      }
    }
  }

  async #runScheduleLoop(): Promise<void> {
    while (await this.#hasCapacity()) {
      await this.#failQueuedTasksWithFailedDependencies();
      const queuedTasks = await this.#store.listTasksByState("queued");
      const runnableTasks = await this.#filterRunnableTasks(queuedTasks);
      const nextTask = runnableTasks
        .slice()
        .sort((left, right) => right.priority - left.priority || left.taskId.localeCompare(right.taskId))[0];

      if (!nextTask) {
        return;
      }

      let allocation: WorktreeAllocation;
      try {
        if (this.#runtimeManager) {
          await this.#runtimeManager.ensureReady(nextTask, this.#logStreamer);
        }
      } catch (error) {
        const failedTask: RunnerTaskRecord = {
          ...nextTask,
          state: "failed",
        };

        await this.#store.saveTask(failedTask);
        await this.#logStreamer.append({
          taskId: nextTask.taskId,
          type: "task.failed",
          errorCode: error instanceof Error && "code" in error ? String(error.code) : "CODEX_RUNTIME_FAILED",
          message: error instanceof Error ? error.message : "Unknown Codex runtime failure",
        });
        await this.#failQueuedDependents(failedTask);
        await this.#emitGraphLifecycleForTask(failedTask, {
          errorCode: error instanceof Error && "code" in error ? String(error.code) : "CODEX_RUNTIME_FAILED",
          message: error instanceof Error ? error.message : "Unknown Codex runtime failure",
        });
        continue;
      }

      try {
        allocation =
          nextTask.worktreePath === undefined
            ? await this.#worktreeManager.createWorktree(nextTask.taskId, nextTask.repoPath)
            : {
                taskId: nextTask.taskId,
                repoPath: nextTask.repoPath,
                branchName: `plato/task-${nextTask.taskId}`,
                worktreePath: nextTask.worktreePath,
              };
      } catch (error) {
        const provisioningError =
          error instanceof WorktreeProvisioningError
            ? error
            : new WorktreeProvisioningError(
                error instanceof Error ? error.message : "Unknown worktree provisioning failure",
                nextTask.taskId,
                nextTask.repoPath,
              );

        const failedTask: RunnerTaskRecord = {
          ...nextTask,
          state: "failed",
        };

        await this.#store.saveTask(failedTask);
        await this.#logStreamer.append({
          taskId: nextTask.taskId,
          type: "task.failed",
          errorCode: provisioningError.code,
          message: provisioningError.message,
        });
        await this.#failQueuedDependents(failedTask);
        await this.#emitGraphLifecycleForTask(failedTask, {
          errorCode: provisioningError.code,
          message: provisioningError.message,
        });
        continue;
      }

      await this.#startManagedTask(nextTask, allocation, "task.started");
    }
  }

  async #startManagedTask(
    task: RunnerTaskRecord,
    allocation: WorktreeAllocation,
    eventType: "task.started" | "task.resumed",
  ): Promise<RunnerTaskRecord> {
    const session = await this.#agentSession.start(task, allocation, {
      onExit: async (exitCode) => {
        await this.#handleSessionExit(task.taskId, session.sessionId, allocation.worktreePath, exitCode);
      },
    });
    const runningTask: RunnerTaskRecord = {
      ...task,
      state: "running",
      worktreePath: allocation.worktreePath,
      activeSessionId: session.sessionId,
    };

    await this.#store.saveTask(runningTask);
    await this.#sessionStore.saveSession({
      sessionId: session.sessionId,
      taskId: task.taskId,
      worktreePath: allocation.worktreePath,
      pid: session.pid,
      state: "running",
    });
    await this.#logStreamer.append({
      taskId: task.taskId,
      type: eventType,
      sessionId: session.sessionId,
      worktreePath: allocation.worktreePath,
    });
    await this.#emitGraphWorkerStarted(runningTask);

    return runningTask;
  }

  async #handleSessionExit(
    taskId: string,
    sessionId: string,
    worktreePath: string,
    exitCode: number | null,
  ): Promise<void> {
    const task = await this.#store.getTask(taskId);
    if (!task || task.activeSessionId !== sessionId) {
      return;
    }

    const completed = exitCode === 0;
    if (completed) {
      await this.#finalizeSuccessfulSession(task, {
        sessionId,
        taskId,
        worktreePath,
        exitCode,
      });
    } else {
      await this.#persistFailedTask(task, {
        sessionId,
        taskId,
        worktreePath,
        state: "failed",
        exitCode,
      }, {
        errorCode: "TASK_EXIT_NON_ZERO",
        message: `Task exited with code ${exitCode}`,
      });
    }
    await this.#scheduleQueuedTasks();
  }

  async #reconcileRunningTask(task: RunnerTaskRecord): Promise<RunnerTaskRecord | undefined> {
    const activeSessionId = task.activeSessionId;
    if (!activeSessionId) {
      return this.#persistRecoveredTask(task, {
        recoveredState: "interrupted",
        errorCode: "TASK_RECOVERY_SESSION_MISSING",
        message: "Recovered running task without an active session reference",
      });
    }

    const session = await this.#sessionStore.getSession(activeSessionId);
    if (!session || session.taskId !== task.taskId) {
      return this.#persistRecoveredTask(task, {
        sessionId: activeSessionId,
        recoveredState: "interrupted",
        errorCode: "TASK_RECOVERY_SESSION_MISSING",
        message: "Recovered running task without a persisted active session",
      });
    }

    if (session.state === "running") {
      return this.#persistRecoveredTask(task, {
        sessionId: session.sessionId,
        recoveredState: "interrupted",
        errorCode: "TASK_RECOVERY_SESSION_ORPHANED",
        message: "Recovered running task from a persisted running session after startup",
      });
    }

    if (session.state === "awaiting_approval") {
      return undefined;
    }

    if (session.state === "verifying") {
      return this.#recoverVerifyingTask(task, session);
    }

    if (session.state === "failed") {
      return this.#persistRecoveredTask(task, {
        sessionId: session.sessionId,
        recoveredState: "failed",
        errorCode: "TASK_RECOVERY_SESSION_FAILED",
        message: "Recovered running task from failed session state",
        exitCode: session.exitCode,
      });
    }

    if (session.state === "interrupted") {
      return this.#persistRecoveredTask(task, {
        sessionId: session.sessionId,
        recoveredState: "interrupted",
        errorCode: "TASK_RECOVERY_SESSION_INTERRUPTED",
        message: "Recovered running task from interrupted session state",
        exitCode: session.exitCode,
      });
    }

    return this.#persistRecoveredTask(task, {
      sessionId: session.sessionId,
      recoveredState: "completed",
      errorCode: "TASK_RECOVERY_SESSION_COMPLETED",
      message: "Recovered running task from completed session state",
      exitCode: session.exitCode,
    });
  }

  async #persistRecoveredTask(
    task: RunnerTaskRecord,
    recovery: {
      sessionId?: string;
      recoveredState: "interrupted" | "failed" | "completed";
      errorCode: string;
      message: string;
      exitCode?: number | null;
    },
  ): Promise<RunnerTaskRecord> {
    const reconciledTask: RunnerTaskRecord = {
      ...task,
      state: recovery.recoveredState,
      activeSessionId: undefined,
    };

    await this.#store.saveTask(reconciledTask);
    await this.#logStreamer.append({
      taskId: task.taskId,
      type: "task.reconciled",
      sessionId: recovery.sessionId,
      worktreePath: task.worktreePath,
      recoveredState: recovery.recoveredState,
      errorCode: recovery.errorCode,
      message: recovery.message,
      exitCode: recovery.exitCode,
    });

    return reconciledTask;
  }

  async #resumeTaskFromCheckpoint(task: RunnerTaskRecord): Promise<RunnerTaskRecord> {
    const resumedTask: RunnerTaskRecord = {
      ...task,
      state: "interrupted",
    };

    await this.#store.saveTask(resumedTask);
    return this.resumeTask(task.taskId);
  }

  async #saveSessionCheckpoint(
    task: RunnerTaskRecord,
    update: Pick<RunnerSessionRecord, "state" | "pendingApproval"> &
      Partial<Pick<RunnerSessionRecord, "exitCode">>,
  ): Promise<void> {
    if (!task.activeSessionId) {
      return;
    }

    const current = await this.#sessionStore.getSession(task.activeSessionId);
    await this.#sessionStore.saveSession({
      sessionId: task.activeSessionId,
      taskId: task.taskId,
      worktreePath: task.worktreePath ?? current?.worktreePath ?? "",
      pid: current?.pid,
      state: update.state,
      exitCode: update.exitCode ?? current?.exitCode,
      pendingApproval: update.pendingApproval,
    });
  }

  async #runPostRunVerification(
    task: RunnerTaskRecord,
    session: RunnerSessionRecord,
  ): Promise<TaskVerificationResult> {
    if (!this.#taskResultVerifier) {
      return {
        verificationId: "verification-skipped",
        status: "passed",
      };
    }

    await this.#logStreamer.append({
      taskId: task.taskId,
      type: "verification.started",
      sessionId: session.sessionId,
      worktreePath: session.worktreePath,
    });

    try {
      const result = await this.#taskResultVerifier.verify({
        task,
        session,
      });
      await this.#logStreamer.append({
        taskId: task.taskId,
        type: result.status === "passed" ? "verification.completed" : "verification.failed",
        sessionId: session.sessionId,
        worktreePath: session.worktreePath,
        verificationId: result.verificationId,
        verificationStatus: result.status,
        errorCode: result.errorCode,
        message: result.message,
      });

      return result;
    } catch (error) {
      const failure: TaskVerificationResult = {
        verificationId: "verification-error",
        status: "failed",
        errorCode:
          error instanceof Error && "code" in error ? String(error.code) : "TASK_VERIFICATION_ERRORED",
        message: error instanceof Error ? error.message : "Task verification errored",
      };

      await this.#logStreamer.append({
        taskId: task.taskId,
        type: "verification.failed",
        sessionId: session.sessionId,
        worktreePath: session.worktreePath,
        verificationId: failure.verificationId,
        verificationStatus: failure.status,
        errorCode: failure.errorCode,
        message: failure.message,
      });

      return failure;
    }
  }

  async #finalizeSuccessfulSession(
    task: RunnerTaskRecord,
    session: Omit<RunnerSessionRecord, "state">,
  ): Promise<void> {
    if (!this.#taskResultVerifier) {
      await this.#persistCompletedTask(task, {
        ...session,
        state: "completed",
      });
      return;
    }

    const verifyingSession: RunnerSessionRecord = {
      ...session,
      state: "verifying",
    };
    await this.#sessionStore.saveSession(verifyingSession);

    const verification = await this.#runPostRunVerification(task, verifyingSession);
    if (verification.status === "passed") {
      await this.#persistCompletedTask(task, {
        ...session,
        state: "completed",
      });
      return;
    }

    await this.#persistFailedTask(
      task,
      {
        ...session,
        state: "failed",
      },
      {
        errorCode: verification.errorCode ?? "TASK_VERIFICATION_FAILED",
        message: verification.message ?? "Task verification failed",
      },
    );
  }

  async #recoverVerifyingTask(
    task: RunnerTaskRecord,
    session: RunnerSessionRecord,
  ): Promise<RunnerTaskRecord> {
    const verification = await this.#runPostRunVerification(task, session);
    const recoveredState = verification.status === "passed" ? "completed" : "failed";

    await this.#sessionStore.saveSession({
      ...session,
      state: recoveredState,
    });

    return this.#persistRecoveredTask(task, {
      sessionId: session.sessionId,
      recoveredState,
      errorCode:
        verification.status === "passed"
          ? "TASK_RECOVERY_SESSION_VERIFICATION_COMPLETED"
          : verification.errorCode ?? "TASK_VERIFICATION_FAILED",
      message:
        verification.status === "passed"
          ? "Recovered running task by completing post-run verification"
          : verification.message ?? "Task verification failed",
      exitCode: session.exitCode,
    });
  }

  async #persistCompletedTask(task: RunnerTaskRecord, session: RunnerSessionRecord): Promise<void> {
    await this.#sessionStore.saveSession(session);

    const nextTask: RunnerTaskRecord = {
      ...task,
      state: "completed",
      activeSessionId: undefined,
    };

    await this.#store.saveTask(nextTask);
    await this.#logStreamer.append({
      taskId: task.taskId,
      type: "task.completed",
      sessionId: session.sessionId,
      worktreePath: session.worktreePath,
      exitCode: session.exitCode,
    });
    await this.#emitDependencySatisfied(nextTask);
    await this.#emitGraphLifecycleForTask(nextTask, { session });
  }

  async #persistFailedTask(
    task: RunnerTaskRecord,
    session: RunnerSessionRecord,
    failure: {
      errorCode: string;
      message: string;
    },
  ): Promise<void> {
    await this.#sessionStore.saveSession(session);

    const nextTask: RunnerTaskRecord = {
      ...task,
      state: "failed",
      activeSessionId: undefined,
    };

    await this.#store.saveTask(nextTask);
    await this.#logStreamer.append({
      taskId: task.taskId,
      type: "task.failed",
      sessionId: session.sessionId,
      worktreePath: session.worktreePath,
      exitCode: session.exitCode,
      errorCode: failure.errorCode,
      message: failure.message,
    });
    await this.#failQueuedDependents(nextTask);
    await this.#emitGraphLifecycleForTask(nextTask, failure);
  }

  async #filterRunnableTasks(tasks: RunnerTaskRecord[]): Promise<RunnerTaskRecord[]> {
    const runnableTasks: RunnerTaskRecord[] = [];
    for (const task of tasks) {
      if (await this.#isTaskRunnable(task)) {
        runnableTasks.push(task);
      }
    }

    return runnableTasks;
  }

  async #isTaskRunnable(task: RunnerTaskRecord): Promise<boolean> {
    for (const dependencyTaskId of getTaskDependencyIds(task)) {
      const dependency = await this.#store.getTask(dependencyTaskId);
      if (dependency?.state !== "completed") {
        return false;
      }
    }

    return true;
  }

  async #failQueuedTasksWithFailedDependencies(): Promise<void> {
    const queuedTasks = await this.#store.listTasksByState("queued");
    for (const task of queuedTasks) {
      const failedDependencies = await this.#listFailedDependencies(task);
      if (failedDependencies.length > 0) {
        await this.#persistDependencyBlockedTask(task, failedDependencies);
      }
    }
  }

  async #failQueuedDependents(failedTask: RunnerTaskRecord): Promise<void> {
    const queuedTasks = await this.#store.listTasksByState("queued");
    for (const task of queuedTasks) {
      if (getTaskDependencyIds(task).includes(failedTask.taskId)) {
        await this.#persistDependencyBlockedTask(task, [failedTask.taskId]);
      }
    }
  }

  async #listFailedDependencies(task: RunnerTaskRecord): Promise<string[]> {
    const failedDependencies: string[] = [];
    for (const dependencyTaskId of getTaskDependencyIds(task)) {
      const dependency = await this.#store.getTask(dependencyTaskId);
      if (dependency?.state === "failed") {
        failedDependencies.push(dependencyTaskId);
      }
    }

    return failedDependencies;
  }

  async #persistDependencyBlockedTask(
    task: RunnerTaskRecord,
    failedDependencyTaskIds: string[],
  ): Promise<void> {
    const nextTask: RunnerTaskRecord = {
      ...task,
      state: "failed",
      activeSessionId: undefined,
    };

    await this.#store.saveTask(nextTask);
    await this.#logStreamer.append({
      taskId: task.taskId,
      type: "task.graph.dependency.blocked",
      parentTaskId: task.decomposition?.parentTaskId,
      dependencyTaskIds: getTaskDependencyIds(task),
      blockedByTaskIds: failedDependencyTaskIds,
      errorCode: "TASK_GRAPH_DEPENDENCY_FAILED",
      message: `Blocked by failed graph dependency ${failedDependencyTaskIds.join(", ")}`,
    });
    await this.#logStreamer.append({
      taskId: task.taskId,
      type: "task.failed",
      errorCode: "TASK_GRAPH_DEPENDENCY_FAILED",
      message: `Blocked by failed graph dependency ${failedDependencyTaskIds.join(", ")}`,
    });
    await this.#emitGraphLifecycleForTask(nextTask, {
      errorCode: "TASK_GRAPH_DEPENDENCY_FAILED",
      message: `Blocked by failed graph dependency ${failedDependencyTaskIds.join(", ")}`,
    });
  }

  async #emitDependencySatisfied(task: RunnerTaskRecord): Promise<void> {
    const queuedTasks = await this.#store.listTasksByState("queued");
    for (const queuedTask of queuedTasks) {
      const dependencyTaskIds = getTaskDependencyIds(queuedTask);
      if (dependencyTaskIds.includes(task.taskId)) {
        await this.#logStreamer.append({
          taskId: queuedTask.taskId,
          type: "task.graph.dependency.satisfied",
          parentTaskId: queuedTask.decomposition?.parentTaskId,
          dependencyTaskId: task.taskId,
          dependencyTaskIds,
        });
      }
    }
  }

  async #emitGraphWorkerStarted(task: RunnerTaskRecord): Promise<void> {
    if (!task.decomposition?.parentTaskId) {
      return;
    }

    await this.#logStreamer.append({
      taskId: task.taskId,
      type: "task.graph.worker.started",
      parentTaskId: task.decomposition.parentTaskId,
      dependencyTaskIds: getTaskDependencyIds(task),
      sessionId: task.activeSessionId,
      worktreePath: task.worktreePath,
    });
  }

  async #emitGraphLifecycleForTask(
    task: RunnerTaskRecord,
    terminalContext: {
      session?: RunnerSessionRecord;
      errorCode?: string;
      message?: string;
    } = {},
  ): Promise<void> {
    const parentTaskId = task.decomposition?.parentTaskId;
    if (!parentTaskId) {
      const children = await this.#store.listChildTasks(task.taskId);
      if (children.length === 0) {
        return;
      }

      const graphState = getGraphState(task, children);
      await this.#emitGraphTerminalOnce(task.taskId, graphState);
      return;
    }

    let parent = await this.#store.getTask(parentTaskId);
    if (!parent) {
      return;
    }

    if (task.state === "failed") {
      parent = await this.#propagateGraphFailureToParent(parent, task);
    }

    await this.#ensureWorkerResult(task, parent, terminalContext);

    const children = await this.#store.listChildTasks(parentTaskId);
    const graphState = getGraphState(parent, children);
    await this.#logStreamer.append({
      taskId: parentTaskId,
      type: task.state === "completed" ? "task.graph.child.completed" : "task.graph.child.failed",
      parentTaskId,
      childTaskId: task.taskId,
      graphState,
    });

    if (graphState === "completed" || graphState === "failed") {
      await this.#ensureParentSynthesis(parent, children);
    }
    await this.#emitGraphTerminalOnce(parentTaskId, graphState);
  }

  async #emitGraphTerminalOnce(
    parentTaskId: string,
    graphState: RunnerTaskGraphState,
  ): Promise<void> {
    if (graphState !== "completed" && graphState !== "failed") {
      return;
    }

    const existingEvents = await this.#logStreamer.list(parentTaskId);
    if (
      existingEvents.some(
        (event) => event.type === "task.graph.completed" || event.type === "task.graph.failed",
      )
    ) {
      return;
    }

    await this.#logStreamer.append({
      taskId: parentTaskId,
      type: graphState === "completed" ? "task.graph.completed" : "task.graph.failed",
      parentTaskId,
      graphState,
    });
  }

  async #propagateGraphFailureToParent(
    parent: RunnerTaskRecord,
    failedChild: RunnerTaskRecord,
  ): Promise<RunnerTaskRecord> {
    if (parent.state === "failed") {
      return parent;
    }

    const failedParent: RunnerTaskRecord = {
      ...parent,
      state: "failed",
      activeSessionId: undefined,
    };

    await this.#store.saveTask(failedParent);
    await this.#saveSessionCheckpoint(parent, {
      state: "failed",
      exitCode: null,
    });
    await this.#logStreamer.append({
      taskId: parent.taskId,
      type: "task.failed",
      sessionId: parent.activeSessionId,
      worktreePath: parent.worktreePath,
      errorCode: "TASK_GRAPH_CHILD_FAILED",
      message: `Graph failed because child task ${failedChild.taskId} failed`,
    });

    return failedParent;
  }

  async #ensureWorkerResult(
    task: RunnerTaskRecord,
    parentTask: RunnerTaskRecord,
    terminalContext: {
      session?: RunnerSessionRecord;
      errorCode?: string;
      message?: string;
    },
  ): Promise<WorkerTaskResultRecord> {
    const existing = await this.#store.getWorkerTaskResult(task.taskId);
    if (existing) {
      return existing;
    }

    const result = task.state === "completed"
      ? await this.#collectCompletedWorkerResult(task, parentTask, terminalContext.session)
      : buildFailedWorkerResult(task, parentTask, terminalContext);

    await this.#store.saveWorkerTaskResult(result);
    await this.#logStreamer.append({
      taskId: parentTask.taskId,
      type: "task.graph.result.collected",
      parentTaskId: parentTask.taskId,
      childTaskId: task.taskId,
      resultId: result.resultId,
      resultClassification: result.classification,
      errorCode: result.errorCode,
      message: result.summary,
    });

    return result;
  }

  async #collectCompletedWorkerResult(
    task: RunnerTaskRecord,
    parentTask: RunnerTaskRecord,
    session?: RunnerSessionRecord,
  ): Promise<WorkerTaskResultRecord> {
    try {
      const result = await this.#taskResultCollector.collect({
        task,
        parentTask,
        session,
      });

      return {
        ...result,
        resultId: result.resultId || `result-${task.taskId}`,
        taskId: task.taskId,
        parentTaskId: parentTask.taskId,
      };
    } catch (error) {
      return buildFailedWorkerResult(task, parentTask, {
        errorCode: error instanceof Error && "code" in error
          ? String(error.code)
          : "TASK_RESULT_COLLECTION_FAILED",
        message: error instanceof Error ? error.message : "Task result collection failed",
      });
    }
  }

  async #ensureParentSynthesis(
    parentTask: RunnerTaskRecord,
    children: RunnerTaskRecord[],
  ): Promise<void> {
    const existing = await this.#store.getParentTaskSynthesis(parentTask.taskId);
    if (existing) {
      return;
    }

    const results = await this.#store.listWorkerTaskResults(parentTask.taskId);
    if (results.length !== children.length) {
      return;
    }

    const synthesis = await this.#parentTaskOutcomeSynthesizer.synthesize({
      parentTask,
      children,
      results,
    });
    const normalizedSynthesis = {
      ...synthesis,
      synthesisId: synthesis.synthesisId || `synthesis-${parentTask.taskId}`,
      parentTaskId: parentTask.taskId,
      childTaskCount: children.length,
      resultIds: results.map((result) => result.resultId),
    };

    await this.#store.saveParentTaskSynthesis(normalizedSynthesis);
    await this.#logStreamer.append({
      taskId: parentTask.taskId,
      type: "task.graph.synthesized",
      parentTaskId: parentTask.taskId,
      synthesisId: normalizedSynthesis.synthesisId,
      resultClassification: normalizedSynthesis.classification,
      message: normalizedSynthesis.summary,
    });
  }

  async #hasCapacity(): Promise<boolean> {
    const [runningTasks, approvalTasks] = await Promise.all([
      this.#store.listTasksByState("running"),
      this.#store.listTasksByState("awaiting_approval"),
    ]);
    const activeTasks = runningTasks.length + approvalTasks.filter((task) => task.activeSessionId).length;
    return activeTasks < this.#maxConcurrentTasks;
  }

  async #requireApprovalTask(
    taskId: string,
  ): Promise<RunnerTaskRecord & { pendingApproval: NonNullable<RunnerTaskRecord["pendingApproval"]> }> {
    const task = await this.#requireTask(taskId);
    if (task.state !== "awaiting_approval" || !task.pendingApproval) {
      throw new Error(`Task ${taskId} is not awaiting approval`);
    }

    return task as RunnerTaskRecord & {
      pendingApproval: NonNullable<RunnerTaskRecord["pendingApproval"]>;
    };
  }

  async #requireTask(taskId: string): Promise<RunnerTaskRecord> {
    const task = await this.#store.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} was not found`);
    }

    return task;
  }
}

function findDuplicate(values: string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      return value;
    }
    seen.add(value);
  }

  return undefined;
}

function findChildDependencyCycle(
  children: CreateTaskGraphInput["children"],
): string[] | undefined {
  const childById = new Map(children.map((child) => [child.taskId, child]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];

  const visit = (taskId: string): string[] | undefined => {
    if (visiting.has(taskId)) {
      return [...path.slice(path.indexOf(taskId)), taskId];
    }
    if (visited.has(taskId)) {
      return undefined;
    }

    const child = childById.get(taskId);
    if (!child) {
      return undefined;
    }

    visiting.add(taskId);
    path.push(taskId);
    for (const dependencyTaskId of child.dependencyTaskIds ?? []) {
      const cycle = visit(dependencyTaskId);
      if (cycle) {
        return cycle;
      }
    }
    path.pop();
    visiting.delete(taskId);
    visited.add(taskId);

    return undefined;
  };

  for (const child of children) {
    const cycle = visit(child.taskId);
    if (cycle) {
      return cycle;
    }
  }

  return undefined;
}

function getTaskDependencyIds(task: RunnerTaskRecord): string[] {
  return task.decomposition?.dependencyTaskIds ?? [];
}

class DefaultTaskResultCollector implements TaskResultCollector {
  async collect({
    task,
    parentTask,
  }: {
    task: RunnerTaskRecord;
    parentTask: RunnerTaskRecord;
  }): Promise<WorkerTaskResultRecord> {
    return {
      resultId: `result-${task.taskId}`,
      taskId: task.taskId,
      parentTaskId: parentTask.taskId,
      classification: "completed",
      summary: `Task ${task.taskId} completed successfully.`,
    };
  }
}

class DefaultParentTaskOutcomeSynthesizer implements ParentTaskOutcomeSynthesizer {
  async synthesize({
    parentTask,
    children,
    results,
  }: {
    parentTask: RunnerTaskRecord;
    children: RunnerTaskRecord[];
    results: WorkerTaskResultRecord[];
  }) {
    const classification = classifyParentOutcome(results);
    return {
      synthesisId: `synthesis-${parentTask.taskId}`,
      parentTaskId: parentTask.taskId,
      classification,
      summary: buildParentSynthesisSummary(classification, children.length, results),
      childTaskCount: children.length,
      resultIds: results.map((result) => result.resultId),
    };
  }
}

function buildFailedWorkerResult(
  task: RunnerTaskRecord,
  parentTask: RunnerTaskRecord,
  failure: {
    errorCode?: string;
    message?: string;
  },
): WorkerTaskResultRecord {
  return {
    resultId: `result-${task.taskId}`,
    taskId: task.taskId,
    parentTaskId: parentTask.taskId,
    classification: "failed",
    summary: failure.message ?? `Task ${task.taskId} did not complete successfully.`,
    errorCode: failure.errorCode ?? "TASK_FAILED",
  };
}

function classifyParentOutcome(results: WorkerTaskResultRecord[]): WorkerTaskResultRecord["classification"] {
  if (results.some((result) => result.classification === "failed")) {
    return "failed";
  }
  if (results.some((result) => result.classification === "conflicted")) {
    return "conflicted";
  }
  if (results.some((result) => result.classification === "partial")) {
    return "partial";
  }

  return "completed";
}

function buildParentSynthesisSummary(
  classification: WorkerTaskResultRecord["classification"],
  childTaskCount: number,
  results: WorkerTaskResultRecord[],
): string {
  const counts = results.reduce<Record<WorkerTaskResultRecord["classification"], number>>(
    (current, result) => ({
      ...current,
      [result.classification]: current[result.classification] + 1,
    }),
    {
      completed: 0,
      partial: 0,
      conflicted: 0,
      failed: 0,
    },
  );

  return [
    `Synthesized ${childTaskCount} child task result${childTaskCount === 1 ? "" : "s"} as ${classification}.`,
    `completed=${counts.completed}`,
    `partial=${counts.partial}`,
    `conflicted=${counts.conflicted}`,
    `failed=${counts.failed}`,
  ].join(" ");
}

function getGraphState(parent: RunnerTaskRecord, children: RunnerTaskRecord[]): RunnerTaskGraphState {
  const tasks = [parent, ...children];
  if (tasks.some((task) => task.state === "failed")) {
    return "failed";
  }
  if (tasks.length > 0 && tasks.every((task) => task.state === "completed")) {
    return "completed";
  }
  if (tasks.some((task) => task.state === "awaiting_approval")) {
    return "awaiting_approval";
  }
  if (tasks.some((task) => task.state === "running")) {
    return "running";
  }
  if (tasks.some((task) => task.state === "interrupted")) {
    return "interrupted";
  }

  return "queued";
}
