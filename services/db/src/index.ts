import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type SqliteBootstrap = (connection: DatabaseSync) => void;

export interface OpenSqliteDatabaseOptions {
  filePath: string;
}

export interface SqliteDatabase {
  readonly filePath: string;
  readonly connection: DatabaseSync;
  migrate(...bootstraps: SqliteBootstrap[]): void;
  close(): void;
}

class DefaultSqliteDatabase implements SqliteDatabase {
  readonly #connection: DatabaseSync;
  readonly #filePath: string;

  constructor(options: OpenSqliteDatabaseOptions) {
    if (options.filePath !== ":memory:") {
      mkdirSync(dirname(options.filePath), { recursive: true });
    }

    this.#filePath = options.filePath;
    this.#connection = new DatabaseSync(options.filePath);
    this.#connection.exec("PRAGMA foreign_keys = ON;");
    this.#connection.exec("PRAGMA journal_mode = WAL;");
  }

  get filePath(): string {
    return this.#filePath;
  }

  get connection(): DatabaseSync {
    return this.#connection;
  }

  migrate(...bootstraps: SqliteBootstrap[]): void {
    if (bootstraps.length === 0) {
      return;
    }

    this.#connection.exec("BEGIN;");
    try {
      for (const bootstrap of bootstraps) {
        bootstrap(this.#connection);
      }
      this.#connection.exec("COMMIT;");
    } catch (error) {
      this.#connection.exec("ROLLBACK;");
      throw error;
    }
  }

  close(): void {
    this.#connection.close();
  }
}

export function openSqliteDatabase(options: OpenSqliteDatabaseOptions): SqliteDatabase {
  return new DefaultSqliteDatabase(options);
}
