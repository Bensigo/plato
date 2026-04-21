import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { CodexRuntimeManager, LogStreamer, RunnerTaskRecord } from "../contracts.js";

const execFileAsync = promisify(execFile);

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommandRunner {
  run(command: string, args?: string[]): Promise<CommandResult>;
}

export class ExecFileCommandRunner implements CommandRunner {
  async run(command: string, args: string[] = []): Promise<CommandResult> {
    try {
      const result = await execFileAsync(command, args);
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: 0,
      };
    } catch (error) {
      const processError = error as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        code?: number | string;
      };

      return {
        stdout: processError.stdout ?? "",
        stderr: processError.stderr ?? "",
        exitCode: typeof processError.code === "number" ? processError.code : 1,
      };
    }
  }
}

export interface RuntimeCommandSpec {
  command: string;
  args?: string[];
}

export interface CodexRuntimeManagerOptions {
  commandRunner?: CommandRunner;
  detectCommand?: RuntimeCommandSpec;
  verifyCommand?: RuntimeCommandSpec;
  installCommand?: RuntimeCommandSpec;
}

export class CodexRuntimeBootstrapError extends Error {
  readonly code: "CODEX_INSTALL_FAILED" | "CODEX_VERIFY_FAILED";

  constructor(code: "CODEX_INSTALL_FAILED" | "CODEX_VERIFY_FAILED", message: string) {
    super(message);
    this.name = "CodexRuntimeBootstrapError";
    this.code = code;
  }
}

export class DefaultCodexRuntimeManager implements CodexRuntimeManager {
  readonly #commandRunner: CommandRunner;
  readonly #detectCommand: RuntimeCommandSpec;
  readonly #verifyCommand: RuntimeCommandSpec;
  readonly #installCommand: RuntimeCommandSpec;
  #ready = false;

  constructor(options: CodexRuntimeManagerOptions = {}) {
    this.#commandRunner = options.commandRunner ?? new ExecFileCommandRunner();
    this.#detectCommand = options.detectCommand ?? { command: "sh", args: ["-lc", "command -v codex"] };
    this.#verifyCommand = options.verifyCommand ?? { command: "codex", args: ["--version"] };
    this.#installCommand = options.installCommand ?? {
      command: "npm",
      args: ["install", "-g", "@openai/codex"],
    };
  }

  async ensureReady(task: RunnerTaskRecord, logStreamer: LogStreamer): Promise<void> {
    if (this.#ready) {
      await logStreamer.append({
        taskId: task.taskId,
        type: "runtime.checked",
        message: "codex runtime already ready",
      });
      return;
    }

    const detected = await this.#runCommand(this.#detectCommand);
    if (detected.exitCode !== 0) {
      await logStreamer.append({
        taskId: task.taskId,
        type: "runtime.install.started",
        message: "codex runtime missing, starting installation",
      });

      const installResult = await this.#runCommand(this.#installCommand);
      if (installResult.exitCode !== 0) {
        await logStreamer.append({
          taskId: task.taskId,
          type: "runtime.install.failed",
          errorCode: "CODEX_INSTALL_FAILED",
          message: installResult.stderr || installResult.stdout || "Codex installation failed",
        });
        throw new CodexRuntimeBootstrapError(
          "CODEX_INSTALL_FAILED",
          installResult.stderr || installResult.stdout || "Codex installation failed",
        );
      }

      await logStreamer.append({
        taskId: task.taskId,
        type: "runtime.install.completed",
        message: installResult.stdout.trim() || "codex runtime installed",
      });
    }

    const verified = await this.#runCommand(this.#verifyCommand);
    if (verified.exitCode !== 0) {
      await logStreamer.append({
        taskId: task.taskId,
        type: "runtime.install.failed",
        errorCode: "CODEX_VERIFY_FAILED",
        message: verified.stderr || verified.stdout || "Codex verification failed",
      });
      throw new CodexRuntimeBootstrapError(
        "CODEX_VERIFY_FAILED",
        verified.stderr || verified.stdout || "Codex verification failed",
      );
    }

    this.#ready = true;
    await logStreamer.append({
      taskId: task.taskId,
      type: "runtime.checked",
      message: verified.stdout.trim() || "codex runtime ready",
    });
  }

  async #runCommand(spec: RuntimeCommandSpec): Promise<CommandResult> {
    return this.#commandRunner.run(spec.command, spec.args ?? []);
  }
}
