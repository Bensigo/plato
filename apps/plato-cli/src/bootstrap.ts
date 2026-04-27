import { TaskOrchestrationService } from "@plato/orchestration";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  CodexRunnerAgentRuntimeService,
  OperatorRuntimeOptions,
} from "@plato/codex-runner";

import {
  createPlatoMcpServer,
  runPlatoCli,
  type OrchestrationClient,
  type PlatoCliOptions,
} from "./index.js";
import type {
  AgentRuntimeSelector,
  CreateOrchestrationGraphInput,
  StartOrchestrationTaskInput,
} from "@plato/orchestration";

export interface PlatoRuntimeOptions extends OperatorRuntimeOptions {
  runtimeId?: string;
  defaultRuntimeId?: string;
  openCodexRuntime?: (options: OperatorRuntimeOptions) => Promise<PlatoCodexRuntime> | PlatoCodexRuntime;
}

export interface PlatoCodexRuntime {
  readonly service: CodexRunnerAgentRuntimeService;
  close(): Promise<void> | void;
}

export interface PlatoRuntime {
  readonly client: OrchestrationClient;
  close(): Promise<void> | void;
}

export async function openPlatoRuntime(options: PlatoRuntimeOptions = {}): Promise<PlatoRuntime> {
  const runtimeId = options.runtimeId ?? "codex";
  const codexRuntime = options.openCodexRuntime
    ? await options.openCodexRuntime(options)
    : await openDefaultCodexRuntime(options);

  try {
    const { CodexRunnerAgentRuntime } = await import("@plato/codex-runner");
    const orchestrationRuntime = new CodexRunnerAgentRuntime({
      runtimeId,
      service: codexRuntime.service,
    });

    return {
      client: new TaskOrchestrationService({
        defaultRuntimeId: options.defaultRuntimeId ?? runtimeId,
        runtimes: [orchestrationRuntime],
      }),
      close: async () => {
        await codexRuntime.close();
      },
    };
  } catch (error) {
    await codexRuntime.close();
    throw error;
  }
}

async function openDefaultCodexRuntime(options: OperatorRuntimeOptions): Promise<PlatoCodexRuntime> {
  const { openOperatorRuntime } = await import("@plato/codex-runner");
  const runtime = await openOperatorRuntime(options);
  return {
    service: runtime.service as unknown as CodexRunnerAgentRuntimeService,
    close: async () => {
      await runtime.close();
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
  const runtime = new LazyPlatoRuntime(options);
  try {
    return await runPlatoCli(argv, {
      client: runtime.client,
      stdout: options.stdout,
      stderr: options.stderr,
    });
  } finally {
    await runtime.close();
  }
}

class LazyPlatoRuntime implements PlatoRuntime {
  readonly client: OrchestrationClient;
  readonly #options: PlatoRuntimeOptions;
  #runtime?: Promise<PlatoRuntime>;
  #openedRuntime?: PlatoRuntime;

  constructor(options: PlatoRuntimeOptions) {
    this.#options = options;
    this.client = new LazyOrchestrationClient(() => this.#open());
  }

  async close(): Promise<void> {
    await this.#openedRuntime?.close();
  }

  async #open(): Promise<PlatoRuntime> {
    this.#runtime ??= openPlatoRuntime(this.#options).then((runtime) => {
      this.#openedRuntime = runtime;
      return runtime;
    });
    return this.#runtime;
  }
}

class LazyOrchestrationClient implements OrchestrationClient {
  readonly #openRuntime: () => Promise<PlatoRuntime>;

  constructor(openRuntime: () => Promise<PlatoRuntime>) {
    this.#openRuntime = openRuntime;
  }

  async startTask(input: StartOrchestrationTaskInput) {
    return (await this.#client()).startTask(input);
  }

  async createTaskGraph(input: CreateOrchestrationGraphInput) {
    return (await this.#client()).createTaskGraph(input);
  }

  async getTask(taskId: string, selector?: AgentRuntimeSelector) {
    return (await this.#client()).getTask(taskId, selector);
  }

  async getTaskGraph(taskId: string, selector?: AgentRuntimeSelector) {
    return (await this.#client()).getTaskGraph(taskId, selector);
  }

  async getTaskGraphResults(taskId: string, selector?: AgentRuntimeSelector) {
    return (await this.#client()).getTaskGraphResults(taskId, selector);
  }

  async listTasks(selector?: AgentRuntimeSelector) {
    return (await this.#client()).listTasks(selector);
  }

  async listEvents(taskId: string, selector?: AgentRuntimeSelector) {
    return (await this.#client()).listEvents(taskId, selector);
  }

  async interruptTask(taskId: string, selector?: AgentRuntimeSelector) {
    return (await this.#client()).interruptTask(taskId, selector);
  }

  async resumeTask(taskId: string, selector?: AgentRuntimeSelector) {
    return (await this.#client()).resumeTask(taskId, selector);
  }

  async approveTaskAction(taskId: string, selector?: AgentRuntimeSelector) {
    return (await this.#client()).approveTaskAction(taskId, selector);
  }

  async rejectTaskAction(taskId: string, reason: string, selector?: AgentRuntimeSelector) {
    return (await this.#client()).rejectTaskAction(taskId, reason, selector);
  }

  async #client(): Promise<OrchestrationClient> {
    return (await this.#openRuntime()).client;
  }
}

export interface PlatoMcpRuntime {
  readonly server: ReturnType<typeof createPlatoMcpServer>;
  close(): Promise<void> | void;
}

export async function createPlatoMcpServerWithRuntime(
  options: PlatoRuntimeOptions = {},
): Promise<PlatoMcpRuntime> {
  const runtime = await openPlatoRuntime(options);
  return {
    server: createPlatoMcpServer(runtime.client),
    close: async () => {
      await runtime.close();
    },
  };
}

export interface RunPlatoMcpWithRuntimeOptions extends PlatoRuntimeOptions {
  createTransport?: () => Transport;
  connectServer?: (server: McpServer, transport: Transport) => Promise<void>;
}

export async function runPlatoMcpWithRuntime(
  options: RunPlatoMcpWithRuntimeOptions = {},
): Promise<number> {
  const runtime = await createPlatoMcpServerWithRuntime(options);
  const createTransport = options.createTransport ?? (() => new StdioServerTransport());
  const connectServer = options.connectServer ?? ((server, transport) => server.connect(transport));

  try {
    await connectServer(runtime.server, createTransport());
    return 0;
  } catch (error) {
    try {
      await runtime.server.close();
    } finally {
      await runtime.close();
    }
    throw error;
  }
}
