import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { SessionEvent } from "../src/contracts.js";
import { FileLogStreamer } from "../src/logs/file-log-streamer.js";
import { cleanupDir, createTempDir } from "./helpers/git.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(cleanupDir));
});

describe("FileLogStreamer", () => {
  it("persists events across instances", async () => {
    const tempDir = await createTempDir("codex-runner-logs-");
    tempDirs.push(tempDir);
    const filePath = join(tempDir, "runner-events.json");

    const firstStreamer = new FileLogStreamer(filePath);
    const event: SessionEvent = { taskId: "task-1", type: "task.queued" };
    await firstStreamer.append(event);

    const secondStreamer = new FileLogStreamer(filePath);
    await expect(secondStreamer.list("task-1")).resolves.toEqual([event]);
  });

  it("keeps events for multiple tasks and filters on list", async () => {
    const tempDir = await createTempDir("codex-runner-logs-");
    tempDirs.push(tempDir);
    const filePath = join(tempDir, "runner-events.json");
    const streamer = new FileLogStreamer(filePath);

    await streamer.append({ taskId: "task-1", type: "task.queued" });
    await streamer.append({ taskId: "task-2", type: "task.failed", errorCode: "X" });

    await expect(streamer.list("task-1")).resolves.toEqual([{ taskId: "task-1", type: "task.queued" }]);
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as { events: SessionEvent[] };
    expect(parsed.events).toHaveLength(2);
  });
});
