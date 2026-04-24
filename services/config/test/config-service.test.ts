import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createFileBackedPlatoConfigService } from "../src/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createTempDir(prefix: string): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}

describe("PlatoConfigService", () => {
  it("reports missing Codex auth before a user configures it", async () => {
    const tempDir = await createTempDir("plato-config-");
    const service = createFileBackedPlatoConfigService({
      configPath: `${tempDir}/config.json`,
      secretsPath: `${tempDir}/secrets.json`,
    });

    await expect(service.getStatus()).resolves.toEqual({
      configPath: `${tempDir}/config.json`,
      codexAuth: {
        configured: false,
      },
    });
    await expect(service.resolveCodexAuth()).resolves.toBeUndefined();
  });

  it("stores an OpenAI API key as a secret and only exposes a redacted status", async () => {
    const tempDir = await createTempDir("plato-config-");
    const service = createFileBackedPlatoConfigService({
      configPath: `${tempDir}/config.json`,
      secretsPath: `${tempDir}/secrets.json`,
    });

    await expect(service.setOpenAIApiKey("sk-test-123456")).resolves.toEqual({
      configPath: `${tempDir}/config.json`,
      codexAuth: {
        configured: true,
        provider: "openai_api_key",
        openAIApiKey: {
          secretRef: "codex.openai_api_key",
          last4: "3456",
        },
      },
    });
    await expect(service.resolveCodexAuth()).resolves.toEqual({
      provider: "openai_api_key",
      openAIApiKey: "sk-test-123456",
    });
    await expect(readFile(`${tempDir}/config.json`, "utf8")).resolves.not.toContain("sk-test");
    await expect(readFile(`${tempDir}/secrets.json`, "utf8")).resolves.toContain("sk-test-123456");
  });

  it("clears the configured Codex auth and removes the local secret", async () => {
    const tempDir = await createTempDir("plato-config-");
    const service = createFileBackedPlatoConfigService({
      configPath: `${tempDir}/config.json`,
      secretsPath: `${tempDir}/secrets.json`,
    });

    await service.setOpenAIApiKey("sk-test-123456");

    await expect(service.clearCodexAuth()).resolves.toEqual({
      configPath: `${tempDir}/config.json`,
      codexAuth: {
        configured: false,
      },
    });
    await expect(service.resolveCodexAuth()).resolves.toBeUndefined();
    await expect(readFile(`${tempDir}/secrets.json`, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects empty OpenAI API keys", async () => {
    const tempDir = await createTempDir("plato-config-");
    const service = createFileBackedPlatoConfigService({
      configPath: `${tempDir}/config.json`,
      secretsPath: `${tempDir}/secrets.json`,
    });

    await expect(service.setOpenAIApiKey("   ")).rejects.toThrow("OpenAI API key cannot be empty");
  });
});
