import type {
  AgentSessionFactory,
  LogStreamer,
  ProcessPool,
  RunnerStore,
  RunnerTaskRecord,
  StartTaskInput,
  WorktreeAllocation,
  WorktreeManager,
} from "./contracts.js";
import { WorktreeProvisioningError } from "./contracts.js";

export interface CodexRunnerServiceDeps {
  store: RunnerStore;
  worktreeManager: WorktreeManager;
  processPool: ProcessPool;
  logStreamer: LogStreamer;
  agentSessionFactory?: AgentSessionFactory;
}

export class CodexRunnerService {
  readonly #store: RunnerStore;
  readonly #worktreeManager: WorktreeManager;
  readonly #processPool: ProcessPool;
  readonly #logStreamer: LogStreamer;
  readonly #agentSessionFactory?: AgentSessionFactory;

  constructor(deps: CodexRunnerServiceDeps) {
    this.#store = deps.store;
    this.#worktreeManager = deps.worktreeManager;
    this.#processPool = deps.processPool;
    this.#logStreamer = deps.logStreamer;
    this.#agentSessionFactory = deps.agentSessionFactory;
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
    if (task.activeSessionId) {
      await this.#processPool.interrupt(task.activeSessionId);
    }

    const interruptedTask: RunnerTaskRecord = {
      ...task,
      state: "interrupted",
      activeSessionId: undefined,
    };

    await this.#store.saveTask(interruptedTask);
    await this.#logStreamer.append({
      taskId,
      type: "task.interrupted",
      worktreePath: interruptedTask.worktreePath,
    });
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

    if (!this.#processPool.hasCapacity()) {
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
    const session = await this.#processPool.spawn(task, allocation);
    const runningTask: RunnerTaskRecord = {
      ...task,
      state: "running",
      activeSessionId: session.sessionId,
    };

    await this.#store.saveTask(runningTask);
    await this.#logStreamer.append({
      taskId,
      type: "task.resumed",
      sessionId: session.sessionId,
      worktreePath: allocation.worktreePath,
    });

    return runningTask;
  }

  async getTask(taskId: string): Promise<RunnerTaskRecord | undefined> {
    return this.#store.getTask(taskId);
  }

  async listEvents(taskId: string) {
    return this.#logStreamer.list(taskId);
  }

  async #scheduleQueuedTasks(): Promise<void> {
    if (!this.#processPool.hasCapacity()) {
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

    const session = this.#agentSessionFactory
      ? await this.#agentSessionFactory.create(this.#logStreamer).start(nextTask, allocation)
      : await this.#processPool.spawn(nextTask, allocation);
    const runningTask: RunnerTaskRecord = {
      ...nextTask,
      state: "running",
      worktreePath: allocation.worktreePath,
      activeSessionId: session.sessionId,
    };

    await this.#store.saveTask(runningTask);
    await this.#logStreamer.append({
      taskId: nextTask.taskId,
      type: "task.started",
      sessionId: session.sessionId,
      worktreePath: allocation.worktreePath,
    });
  }

  async #requireTask(taskId: string): Promise<RunnerTaskRecord> {
    const task = await this.#store.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} was not found`);
    }

    return task;
  }
}
