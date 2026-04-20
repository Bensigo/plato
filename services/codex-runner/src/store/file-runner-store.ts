import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { RunnerStore, RunnerStoreRecord, RunnerTaskRecord, RunnerTaskState } from "../contracts.js";

const EMPTY_STORE: RunnerStoreRecord = {
  tasks: [],
};

export class FileRunnerStore implements RunnerStore {
  readonly #filePath: string;

  constructor(filePath: string) {
    this.#filePath = filePath;
  }

  async saveTask(task: RunnerTaskRecord): Promise<void> {
    const record = await this.#readRecord();
    const nextTasks = record.tasks.filter((candidate) => candidate.taskId !== task.taskId);
    nextTasks.push(task);
    await this.#writeRecord({ tasks: nextTasks });
  }

  async getTask(taskId: string): Promise<RunnerTaskRecord | undefined> {
    const record = await this.#readRecord();
    return record.tasks.find((task) => task.taskId === taskId);
  }

  async listTasksByState(state: RunnerTaskState): Promise<RunnerTaskRecord[]> {
    const record = await this.#readRecord();
    return record.tasks.filter((task) => task.state === state);
  }

  async #readRecord(): Promise<RunnerStoreRecord> {
    try {
      const raw = await readFile(this.#filePath, "utf8");
      const parsed = JSON.parse(raw) as RunnerStoreRecord;
      return {
        tasks: parsed.tasks ?? [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return EMPTY_STORE;
      }

      throw error;
    }
  }

  async #writeRecord(record: RunnerStoreRecord): Promise<void> {
    await mkdir(dirname(this.#filePath), { recursive: true });
    await writeFile(this.#filePath, JSON.stringify(record, null, 2));
  }
}
