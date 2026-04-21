import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { LogStreamer, LogStreamRecord, SessionEvent } from "../contracts.js";

const EMPTY_LOG: LogStreamRecord = {
  events: [],
};

export class FileLogStreamer implements LogStreamer {
  readonly #filePath: string;
  #writeChain: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.#filePath = filePath;
  }

  async append(event: SessionEvent): Promise<void> {
    this.#writeChain = this.#writeChain.then(async () => {
      const record = await this.#readRecord();
      record.events.push(event);
      await this.#writeRecord(record);
    });

    await this.#writeChain;
  }

  async list(taskId: string): Promise<SessionEvent[]> {
    const record = await this.#readRecord();
    return record.events.filter((event) => event.taskId === taskId);
  }

  async #readRecord(): Promise<LogStreamRecord> {
    try {
      const raw = await readFile(this.#filePath, "utf8");
      const parsed = JSON.parse(raw) as LogStreamRecord;
      return {
        events: parsed.events ?? [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          events: [...EMPTY_LOG.events],
        };
      }

      throw error;
    }
  }

  async #writeRecord(record: LogStreamRecord): Promise<void> {
    await mkdir(dirname(this.#filePath), { recursive: true });
    await writeFile(this.#filePath, JSON.stringify(record, null, 2));
  }
}
