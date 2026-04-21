import { describe, expect, it } from "vitest";

import type { CommandResult, CommandRunner } from "../src/runtime/codex-runtime-manager.js";
import { DefaultCodexRuntimeManager } from "../src/runtime/codex-runtime-manager.js";
import type { LogStreamer, RunnerTaskRecord, SessionEvent } from "../src/contracts.js";

class InMemoryLogStreamer implements LogStreamer {
  readonly events: SessionEvent[] = [];

  async append(event: SessionEvent): Promise<void> {
    this.events.push(event);
  }

  async list(taskId: string): Promise<SessionEvent[]> {
    return this.events.filter((event) => event.taskId === taskId);
  }
}

class FakeCommandRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: string[] }> = [];
  readonly #results: CommandResult[];

  constructor(results: CommandResult[]) {
    this.#results = [...results];
  }

  async run(command: string, args: string[] = []): Promise<CommandResult> {
    this.calls.push({ command, args });
    const result = this.#results.shift();
    if (!result) {
      throw new Error("No fake command result configured");
    }

    return result;
  }
}

function buildTask(): RunnerTaskRecord {
  return {
    taskId: "task-1",
    repoPath: "/repo",
    prompt: "Run codex",
    priority: 1,
    state: "queued",
  };
}

describe("DefaultCodexRuntimeManager", () => {
  it("verifies Codex when it is already installed", async () => {
    const logStreamer = new InMemoryLogStreamer();
    const commandRunner = new FakeCommandRunner([
      { stdout: "/usr/local/bin/codex\n", stderr: "", exitCode: 0 },
      { stdout: "codex 1.2.3\n", stderr: "", exitCode: 0 },
    ]);
    const runtimeManager = new DefaultCodexRuntimeManager({ commandRunner });

    await runtimeManager.ensureReady(buildTask(), logStreamer);

    expect(commandRunner.calls).toHaveLength(2);
    expect(logStreamer.events.at(-1)).toMatchObject({
      taskId: "task-1",
      type: "runtime.checked",
    });
  });

  it("installs Codex when it is missing", async () => {
    const logStreamer = new InMemoryLogStreamer();
    const commandRunner = new FakeCommandRunner([
      { stdout: "", stderr: "", exitCode: 1 },
      { stdout: "installed\n", stderr: "", exitCode: 0 },
      { stdout: "codex 1.2.3\n", stderr: "", exitCode: 0 },
    ]);
    const runtimeManager = new DefaultCodexRuntimeManager({ commandRunner });

    await runtimeManager.ensureReady(buildTask(), logStreamer);

    expect(logStreamer.events.map((event) => event.type)).toEqual([
      "runtime.install.started",
      "runtime.install.completed",
      "runtime.checked",
    ]);
  });

  it("fails when install does not succeed", async () => {
    const logStreamer = new InMemoryLogStreamer();
    const commandRunner = new FakeCommandRunner([
      { stdout: "", stderr: "", exitCode: 1 },
      { stdout: "", stderr: "install failed", exitCode: 1 },
    ]);
    const runtimeManager = new DefaultCodexRuntimeManager({ commandRunner });

    await expect(runtimeManager.ensureReady(buildTask(), logStreamer)).rejects.toMatchObject({
      name: "CodexRuntimeBootstrapError",
      code: "CODEX_INSTALL_FAILED",
    });
  });

  it("fails when verification does not succeed after install", async () => {
    const logStreamer = new InMemoryLogStreamer();
    const commandRunner = new FakeCommandRunner([
      { stdout: "", stderr: "", exitCode: 1 },
      { stdout: "installed\n", stderr: "", exitCode: 0 },
      { stdout: "", stderr: "verify failed", exitCode: 1 },
    ]);
    const runtimeManager = new DefaultCodexRuntimeManager({ commandRunner });

    await expect(runtimeManager.ensureReady(buildTask(), logStreamer)).rejects.toMatchObject({
      code: "CODEX_VERIFY_FAILED",
    });
  });
});
