#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const result = {
  node: {
    version: process.version,
    supported: isSupportedNodeVersion(process.version),
  },
  codex: detectCodexCli(),
};

process.stdout.write(`${buildInstallCheckMessage(result)}\n`);

function buildInstallCheckMessage(check) {
  const lines = ["Plato install check:"];

  lines.push(
    check.node.supported
      ? `  OK Node ${check.node.version}`
      : `  Action needed: Plato expects Node 22 or newer. Current version: ${check.node.version}`,
  );

  if (check.codex.found) {
    lines.push(`  OK Codex CLI detected${check.codex.version ? ` (${check.codex.version})` : ""}`);
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

function isSupportedNodeVersion(version) {
  const major = Number.parseInt(version.replace(/^v/, "").split(".")[0] ?? "", 10);
  return Number.isInteger(major) && major >= 22;
}

function detectCodexCli() {
  const codex = spawnSync("codex", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (codex.error || codex.status !== 0) {
    return { found: false };
  }

  const version = `${codex.stdout}${codex.stderr}`.trim().split("\n")[0]?.trim();
  return version ? { found: true, version } : { found: true };
}
