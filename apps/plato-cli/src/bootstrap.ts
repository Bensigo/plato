import { TaskOrchestrationService } from "@plato/orchestration";
import {
  CodexRunnerAgentRuntime,
  type CodexRunnerAgentRuntimeService,
  openOperatorRuntime,
  type OperatorRuntimeOptions,
} from "@plato/codex-runner";

import {
  createPlatoMcpServer,
  runPlatoCli,
  type OrchestrationClient,
  type PlatoCliOptions,
} from "./index.js";

export interface PlatoRuntimeOptions extends OperatorRuntimeOptions {
  runtimeId?: string;
  defaultRuntimeId?: string;
  openCodexRuntime?: (options: OperatorRuntimeOptions) => Promise<PlatoCodexRuntime> | PlatoCodexRuntime;
}

export interface PlatoCodexRuntime {
  readonly service: CodexRunnerAgentRuntimeService;
  close(): void;
}

export interface PlatoRuntime {
  readonly client: OrchestrationClient;
  close(): void;
}

export async function openPlatoRuntime(options: PlatoRuntimeOptions = {}): Promise<PlatoRuntime> {
  const runtimeId = options.runtimeId ?? "codex";
  const codexRuntime = options.openCodexRuntime
    ? await options.openCodexRuntime(options)
    : await openDefaultCodexRuntime(options);
  const orchestrationRuntime = new CodexRunnerAgentRuntime({
    runtimeId,
    service: codexRuntime.service,
  });

  return {
    client: new TaskOrchestrationService({
      defaultRuntimeId: options.defaultRuntimeId ?? runtimeId,
      runtimes: [orchestrationRuntime],
    }),
    close: () => {
      codexRuntime.close();
    },
  };
}

async function openDefaultCodexRuntime(options: OperatorRuntimeOptions): Promise<PlatoCodexRuntime> {
  const runtime = await openOperatorRuntime(options);
  return {
    service: runtime.service as unknown as CodexRunnerAgentRuntimeService,
    close: () => {
      runtime.close();
    },
  };
}

export interface RunPlatoCliWithRuntimeOptions
  extends Omit<PlatoRuntimeOptions, "stdout" | "stderr">,
    Pick<PlatoCliOptions, "stdout" | "stderr"> {}

export async function runPlatoCliWithRuntime(
  argv: string[],
  options: RunPlatoCliWithRuntimeOptions = {},
): Promise<number> {
  const runtime = await openPlatoRuntime(options);
  try {
    return await runPlatoCli(argv, {
      client: runtime.client,
      stdout: options.stdout,
      stderr: options.stderr,
    });
  } finally {
    runtime.close();
  }
}

export interface PlatoMcpRuntime {
  readonly server: ReturnType<typeof createPlatoMcpServer>;
  close(): void;
}

export async function createPlatoMcpServerWithRuntime(
  options: PlatoRuntimeOptions = {},
): Promise<PlatoMcpRuntime> {
  const runtime = await openPlatoRuntime(options);
  return {
    server: createPlatoMcpServer(runtime.client),
    close: () => {
      runtime.close();
    },
  };
}
