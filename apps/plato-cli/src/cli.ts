#!/usr/bin/env node

import { runPlatoCliWithRuntime, runPlatoMcpWithRuntime } from "./bootstrap.js";
import type {
  RunPlatoCliWithRuntimeOptions,
  RunPlatoMcpWithRuntimeOptions,
} from "./bootstrap.js";

export interface RunPlatoOptions {
  runCli?: (argv: string[], options?: RunPlatoCliWithRuntimeOptions) => Promise<number>;
  runMcp?: (options?: RunPlatoMcpWithRuntimeOptions) => Promise<number>;
  stderr?: Pick<NodeJS.WritableStream, "write">;
}

export async function runPlato(argv: string[], options: RunPlatoOptions = {}): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "mcp") {
    if (rest.length > 0) {
      (options.stderr ?? process.stderr).write("usage: plato mcp\n");
      return 1;
    }
    return (options.runMcp ?? runPlatoMcpWithRuntime)();
  }

  return (options.runCli ?? runPlatoCliWithRuntime)(argv);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await runPlato(process.argv.slice(2));
}
