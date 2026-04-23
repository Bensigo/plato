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
  RunnerTaskGraphState,
  RunnerSessionRecord,
  RunnerTaskStatusSnapshot,
  RunnerTaskRecord,
  RunnerTaskState,
  SessionStore,
  StartTaskInput,
  TaskResultVerifier,
  TaskVerificationResult,
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
  readonly #maxConcurrentTasks: number;

  constructor(deps: CodexRunnerServiceDeps) {
    this.#store = deps.store;
    this.#sessionStore = deps.sessionStore;
    this.#worktreeManager = deps.worktreeManager;
    this.#logStreamer = deps.logStreamer;
    const sessionFactory = deps.agentSessionFactory ?? new CodexSdkBackedAgentSessionFactory();
    this.#agentSession = sessionFactory.create(deps.logStreamer);
    this.#runtimeManager = deps.runtimeManager;
    this.#taskResultVerifier = deps.taskResultVerifier;
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
    while (await this.#hasCapacity()) {
      const queuedTasks = await this.#store.listTasksByState("queued");
      const nextTask = queuedTasks
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
    await this.#emitGraphLifecycleForTask(nextTask);
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
    await this.#emitGraphLifecycleForTask(nextTask);
  }

  async #emitGraphLifecycleForTask(task: RunnerTaskRecord): Promise<void> {
    const parentTaskId = task.decomposition?.parentTaskId;
    if (!parentTaskId) {
      return;
    }

    const parent = await this.#store.getTask(parentTaskId);
    if (!parent) {
      return;
    }

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
      await this.#logStreamer.append({
        taskId: parentTaskId,
        type: graphState === "completed" ? "task.graph.completed" : "task.graph.failed",
        parentTaskId,
        graphState,
      });
    }
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
