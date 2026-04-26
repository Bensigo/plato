#!/usr/bin/env node

import { runPlatoCliWithRuntime } from "./bootstrap.js";

process.exitCode = await runPlatoCliWithRuntime(process.argv.slice(2));
