import type {
  AgentSession,
  AgentSessionFactory,
  CodexRuntimeManager,
  LogStreamer,
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
      worktreePath: task.worktreePath,
    };
    return this.#startManagedTask(task, allocation, "task.resumed");
  }

  async getTask(taskId: string): Promise<RunnerTaskRecord | undefined> {
    return this.#store.getTask(taskId);
  }

  async listEvents(taskId: string) {
    return this.#logStreamer.list(taskId);
  }

  async #scheduleQueuedTasks(): Promise<void> {
    if (!(await this.#hasCapacity())) {
      return;
    }

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
      return;
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
      return;
    }

    await this.#startManagedTask(nextTask, allocation, "task.started");
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

  async #hasCapacity(): Promise<boolean> {
    const runningTasks = await this.#store.listTasksByState("running");
    return runningTasks.length < this.#maxConcurrentTasks;
  }

  async #requireTask(taskId: string): Promise<RunnerTaskRecord> {
    const task = await this.#store.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} was not found`);
    }

    return task;
  }
}
