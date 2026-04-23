import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { RunnerSessionRecord, SessionStore } from "../contracts.js";

interface SessionStoreRecord {
  sessions: RunnerSessionRecord[];
}

const EMPTY_STORE: SessionStoreRecord = {
  sessions: [],
};

export class FileSessionStore implements SessionStore {
  readonly #filePath: string;

  constructor(filePath: string) {
    this.#filePath = filePath;
  }

  async saveSession(session: RunnerSessionRecord): Promise<void> {
    const record = await this.#readRecord();
    const nextSessions = record.sessions.filter((candidate) => candidate.sessionId !== session.sessionId);
    nextSessions.push(session);
    await this.#writeRecord({ sessions: nextSessions });
  }

  async getSession(sessionId: string): Promise<RunnerSessionRecord | undefined> {
    const record = await this.#readRecord();
    return record.sessions.find((session) => session.sessionId === sessionId);
  }

  async listSessionsByTask(taskId: string): Promise<RunnerSessionRecord[]> {
    const record = await this.#readRecord();
    return record.sessions.filter((session) => session.taskId === taskId);
  }

  async #readRecord(): Promise<SessionStoreRecord> {
    try {
      const raw = await readFile(this.#filePath, "utf8");
      const parsed = JSON.parse(raw) as SessionStoreRecord;
      return {
        sessions: parsed.sessions ?? [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return EMPTY_STORE;
      }

      throw error;
    }
  }

  async #writeRecord(record: SessionStoreRecord): Promise<void> {
    await mkdir(dirname(this.#filePath), { recursive: true });
    await writeFile(this.#filePath, JSON.stringify(record, null, 2));
  }
}
