import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openSqliteDatabase } from "../src/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(cleanupDir));
});

async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function cleanupDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

describe("openSqliteDatabase", () => {
  it("runs bootstrap idempotently across repeated calls", async () => {
    const tempDir = await createTempDir("plato-db-");
    tempDirs.push(tempDir);
    const database = openSqliteDatabase({
      filePath: `${tempDir}/plato.sqlite`,
    });

    const bootstrap = (connection: { exec(sql: string): void }) => {
      connection.exec(
        "CREATE TABLE IF NOT EXISTS bootstrap_check (id TEXT PRIMARY KEY, value TEXT NOT NULL);",
      );
    };

    database.migrate(bootstrap);
    database.migrate(bootstrap);

    const row = database.connection
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("bootstrap_check");

    expect(row).toEqual({ name: "bootstrap_check" });

    database.close();
  });
});
