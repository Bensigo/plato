import { openSqliteDatabase, type SqliteDatabase } from "@plato/db";

import type { RunnerStore, SessionStore } from "../contracts.js";
import { bootstrapCodexRunnerSchema } from "./sqlite-schema.js";
import { SqliteRunnerStore } from "./sqlite-runner-store.js";
import { SqliteSessionStore } from "./sqlite-session-store.js";

export interface OpenCodexRunnerPersistenceOptions {
  filePath: string;
}

export interface CodexRunnerPersistence {
  readonly database: SqliteDatabase;
  readonly store: RunnerStore;
  readonly sessionStore: SessionStore;
  close(): void;
}

export function openCodexRunnerPersistence(
  options: OpenCodexRunnerPersistenceOptions,
): CodexRunnerPersistence {
  const database = openSqliteDatabase({ filePath: options.filePath });
  database.migrate(bootstrapCodexRunnerSchema);

  return {
    database,
    store: new SqliteRunnerStore(database.connection),
    sessionStore: new SqliteSessionStore(database.connection),
    close: () => {
      database.close();
    },
  };
}
