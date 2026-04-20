import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function createGitRepo(prefix = "codex-runner-repo-"): Promise<string> {
  const repoPath = await createTempDir(prefix);
  await execFileAsync("git", ["init", repoPath]);
  await execFileAsync("git", ["-C", repoPath, "config", "user.name", "Codex Runner Tests"]);
  await execFileAsync("git", ["-C", repoPath, "config", "user.email", "tests@example.com"]);
  await writeFile(join(repoPath, "README.md"), "# Temp Repo\n");
  await execFileAsync("git", ["-C", repoPath, "add", "README.md"]);
  await execFileAsync("git", ["-C", repoPath, "commit", "-m", "init"]);
  return repoPath;
}

export async function runGit(repoPath: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", repoPath, ...args]);
  return result.stdout.trim();
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await mkdir(path, { recursive: false });
    await rm(path, { recursive: true, force: true });
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EEXIST";
  }
}

export async function cleanupDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}
