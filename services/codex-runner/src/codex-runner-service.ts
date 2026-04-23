import type {
  AgentSession,
  AgentSessionFactory,
  CodexRuntimeManager,
  LogStreamer,
  RequestTaskApprovalInput,
  RunnerStore,
  RunnerSessionRecord,
  RunnerTaskRecord,
  SessionStore,
  StartTaskInput,
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
  maxConcurrentTasks?: number;
}

export class CodexRunnerService {
  readonly #store: RunnerStore;
  readonly #sessionStore: SessionStore;
  readonly #worktreeManager: WorktreeManager;
  readonly #logStreamer: LogStreamer;
  readonly #agentSession: AgentSession;
  readonly #runtimeManager?: CodexRuntimeManager;
  readonly #maxConcurrentTasks: number;

  constructor(deps: CodexRunnerServiceDeps) {
    this.#store = deps.store;
    this.#sessionStore = deps.sessionStore;
    this.#worktreeManager = deps.worktreeManager;
    this.#logStreamer = deps.logStreamer;
    const sessionFactory = deps.agentSessionFactory ?? new CodexSdkBackedAgentSessionFactory();
    this.#agentSession = sessionFactory.create(deps.logStreamer);
    this.#runtimeManager = deps.runtimeManager;
    this.#maxConcurrentTasks = deps.maxConcurrentTasks ?? 1;
  }

  async startTask(input: StartTaskInput): Promise<RunnerTaskRecord> {
    const task: RunnerTaskRecord = {
      taskId: input.taskId,
      repoPath: input.repoPath,
      prompt: input.prompt,
      priority: input.priority ?? 0,
      state: "queued",
    };

    await this.#store.saveTask(task);
    await this.#logStreamer.append({ taskId: task.taskId, type: "task.queued" });
    await this.#scheduleQueuedTasks();

    return this.#requireTask(task.taskId);
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
    const nextTask: RunnerTaskRecord = {
      ...task,
      state: completed ? "completed" : "failed",
      activeSessionId: undefined,
    };
    const sessionRecord: RunnerSessionRecord = {
      sessionId,
      taskId,
      worktreePath,
      state: completed ? "completed" : "failed",
      exitCode,
    };

    await this.#store.saveTask(nextTask);
    await this.#sessionStore.saveSession(sessionRecord);
    await this.#logStreamer.append(
      completed
        ? {
            taskId,
            type: "task.completed",
            sessionId,
            worktreePath,
            exitCode,
          }
        : {
            taskId,
            type: "task.failed",
            sessionId,
            worktreePath,
            exitCode,
            errorCode: "TASK_EXIT_NON_ZERO",
            message: `Task exited with code ${exitCode}`,
          },
    );
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
      recoveredState: "failed",
      errorCode: "TASK_RECOVERY_SESSION_COMPLETED",
      message: "Recovered running task from completed session state without a terminal task transition",
      exitCode: session.exitCode,
    });
  }

  async #persistRecoveredTask(
    task: RunnerTaskRecord,
    recovery: {
      sessionId?: string;
      recoveredState: "interrupted" | "failed";
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
