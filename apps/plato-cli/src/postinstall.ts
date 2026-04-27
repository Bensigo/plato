import { spawnSync } from "node:child_process";

import { isMainModule } from "./bin.js";

export interface InstallCheckResult {
  node: {
    version: string;
    supported: boolean;
  };
  codex: {
    found: boolean;
    version?: string;
  };
}

export function runInstallChecks(): InstallCheckResult {
  return {
    node: {
      version: process.version,
      supported: isSupportedNodeVersion(process.version),
    },
    codex: detectCodexCli(),
  };
}

export function buildInstallCheckMessage(result: InstallCheckResult): string {
  const lines = ["Plato install check:"];

  lines.push(
    result.node.supported
      ? `  OK Node ${result.node.version}`
      : `  Action needed: Plato expects Node 22 or newer. Current version: ${result.node.version}`,
  );

  if (result.codex.found) {
    lines.push(`  OK Codex CLI detected${result.codex.version ? ` (${result.codex.version})` : ""}`);
  } else {
    lines.push(
      "  Action needed: Codex CLI was not found on PATH.",
      "    Install: npm install -g @openai/codex",
      "    Login:   plato config auth-chatgpt",
      "    Model:   plato config set-model gpt-5.4",
    );
  }

  lines.push("  Verify:  plato smoke");
  return lines.join("\n");
}

function isSupportedNodeVersion(version: string): boolean {
  const major = Number.parseInt(version.replace(/^v/, "").split(".")[0] ?? "", 10);
  return Number.isInteger(major) && major >= 22;
}

function detectCodexCli(): InstallCheckResult["codex"] {
  const result = spawnSync("codex", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error || result.status !== 0) {
    return { found: false };
  }

  const version = `${result.stdout}${result.stderr}`.trim().split("\n")[0]?.trim();
  return version ? { found: true, version } : { found: true };
}

if (isMainModule(import.meta.url)) {
  process.stdout.write(`${buildInstallCheckMessage(runInstallChecks())}\n`);
}
