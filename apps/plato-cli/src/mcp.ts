#!/usr/bin/env node

import { runPlatoMcpWithRuntime } from "./bootstrap.js";
import type { RunPlatoMcpWithRuntimeOptions } from "./bootstrap.js";

export function runPlatoMcp(options?: RunPlatoMcpWithRuntimeOptions): Promise<number> {
  return runPlatoMcpWithRuntime(options);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await runPlatoMcp();
}
