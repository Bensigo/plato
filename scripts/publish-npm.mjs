#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const publishOrder = [
  "services/orchestration",
  "services/config",
  "services/db",
  "services/codex-runner",
  "apps/plato-cli",
];

const root = resolve(import.meta.dirname, "..");
const dryRun = process.argv.includes("--dry-run") || process.env.DRY_RUN === "1";

for (const workspacePath of publishOrder) {
  const packagePath = resolve(root, workspacePath, "package.json");
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));

  if (packageJson.private) {
    log(`skip ${packageJson.name}: private package`);
    continue;
  }

  if (!packageJson.publishConfig) {
    log(`skip ${packageJson.name}: no publishConfig`);
    continue;
  }

  if (await packageVersionExists(packageJson.name, packageJson.version)) {
    log(`skip ${packageJson.name}@${packageJson.version}: already published`);
    continue;
  }

  if (!dryRun && !hasNpmAuthToken()) {
    throw new Error("NPM_TOKEN is required to publish unpublished packages");
  }

  const args = ["--dir", workspacePath, "publish", "--access", "public", "--no-git-checks"];
  if (dryRun) {
    args.push("--dry-run");
  }

  log(`${dryRun ? "dry-run" : "publish"} ${packageJson.name}@${packageJson.version}`);
  run("pnpm", args);
}

async function packageVersionExists(name, version) {
  const result = spawnSync("npm", ["view", `${name}@${version}`, "version", "--json"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status === 0) {
    return true;
  }

  if (result.stderr.includes("E404") || result.stdout.includes("E404")) {
    return false;
  }

  process.stderr.write(result.stdout);
  process.stderr.write(result.stderr);
  throw new Error(`Failed to check npm version for ${name}@${version}`);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function log(message) {
  process.stdout.write(`[publish:npm] ${message}\n`);
}

function hasNpmAuthToken() {
  return Boolean(process.env.NODE_AUTH_TOKEN || process.env.NPM_TOKEN);
}
