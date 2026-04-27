#!/usr/bin/env node

import { isMainModule } from "./bin.js";
import { runPlatoMcpWithRuntime } from "./bootstrap.js";
import type { RunPlatoMcpWithRuntimeOptions } from "./bootstrap.js";

export function runPlatoMcp(options?: RunPlatoMcpWithRuntimeOptions): Promise<number> {
  return runPlatoMcpWithRuntime(options);
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await runPlatoMcp();
}
