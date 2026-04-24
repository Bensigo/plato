import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export type CodexAuthProvider = "openai_api_key" | "chatgpt_oauth";

export interface PlatoConfigRecord {
  codexAuth?: {
    provider: CodexAuthProvider;
    openAIApiKeySecretRef?: string;
    chatGptOAuth?: ChatGptOAuthConfig;
  };
}

export interface ChatGptOAuthConfig {
  accountId: string;
  email?: string;
  planType?: string;
  tokenSource: "codex_app_server";
  updatedAt: string;
}

export interface SetChatGptOAuthAccountInput {
  accountId?: string;
  email?: string;
  planType?: string;
  updatedAt?: string;
}

export interface CodexAuthStatus {
  configured: boolean;
  provider?: CodexAuthProvider;
  openAIApiKey?: {
    secretRef: string;
    last4: string;
  };
  chatGptOAuth?: {
    accountId?: string;
    email?: string;
    planType?: string;
    tokenSource?: "codex_app_server";
    updatedAt?: string;
    configured: boolean;
  };
}

export interface PlatoConfigStatus {
  configPath: string;
  codexAuth: CodexAuthStatus;
}

export interface ResolvedCodexAuth {
  provider: CodexAuthProvider;
  openAIApiKey?: string;
  chatGptOAuth?: ChatGptOAuthConfig;
}

export interface ConfigStore {
  readonly path: string;
  read(): Promise<PlatoConfigRecord>;
  write(config: PlatoConfigRecord): Promise<void>;
}

export interface SecretStore {
  set(secretRef: string, value: string): Promise<void>;
  get(secretRef: string): Promise<string | undefined>;
  delete(secretRef: string): Promise<void>;
}

export interface PlatoConfigServiceOptions {
  configStore?: ConfigStore;
  secretStore?: SecretStore;
}

export class PlatoConfigService {
  readonly #configStore: ConfigStore;
  readonly #secretStore: SecretStore;

  constructor(options: PlatoConfigServiceOptions = {}) {
    this.#configStore = options.configStore ?? new FileConfigStore();
    this.#secretStore = options.secretStore ?? new FileSecretStore();
  }

  async getStatus(): Promise<PlatoConfigStatus> {
    const config = await this.#configStore.read();
    const auth = config.codexAuth;
    if (!auth) {
      return {
        configPath: this.#configStore.path,
        codexAuth: {
          configured: false,
        },
      };
    }

    if (auth.provider === "openai_api_key" && auth.openAIApiKeySecretRef) {
      const key = await this.#secretStore.get(auth.openAIApiKeySecretRef);
      return {
        configPath: this.#configStore.path,
        codexAuth: {
          configured: key !== undefined,
          provider: "openai_api_key",
          openAIApiKey: {
            secretRef: auth.openAIApiKeySecretRef,
            last4: key ? key.slice(-4) : "",
          },
        },
      };
    }

    if (auth.provider === "chatgpt_oauth") {
      return {
        configPath: this.#configStore.path,
        codexAuth: {
          configured: Boolean(auth.chatGptOAuth?.accountId),
          provider: "chatgpt_oauth",
          chatGptOAuth: {
            accountId: auth.chatGptOAuth?.accountId,
            email: auth.chatGptOAuth?.email,
            planType: auth.chatGptOAuth?.planType,
            tokenSource: auth.chatGptOAuth?.tokenSource,
            updatedAt: auth.chatGptOAuth?.updatedAt,
            configured: Boolean(auth.chatGptOAuth?.accountId),
          },
        },
      };
    }

    return {
      configPath: this.#configStore.path,
      codexAuth: {
        configured: false,
        provider: auth.provider,
      },
    };
  }

  async setOpenAIApiKey(apiKey: string): Promise<PlatoConfigStatus> {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      throw new Error("OpenAI API key cannot be empty");
    }

    const secretRef = "codex.openai_api_key";
    await this.#secretStore.set(secretRef, trimmed);
    await this.#configStore.write({
      ...(await this.#configStore.read()),
      codexAuth: {
        provider: "openai_api_key",
        openAIApiKeySecretRef: secretRef,
      },
    });

    return this.getStatus();
  }

  async setChatGptOAuthAccount(input: SetChatGptOAuthAccountInput = {}): Promise<PlatoConfigStatus> {
    const accountId = input.accountId?.trim() || input.email?.trim() || "codex-chatgpt";
    const email = input.email?.trim();
    const planType = input.planType?.trim();

    await this.#configStore.write({
      ...(await this.#configStore.read()),
      codexAuth: {
        provider: "chatgpt_oauth",
        chatGptOAuth: {
          accountId,
          email: email || undefined,
          planType: planType || undefined,
          tokenSource: "codex_app_server",
          updatedAt: input.updatedAt ?? new Date().toISOString(),
        },
      },
    });

    return this.getStatus();
  }

  async clearCodexAuth(): Promise<PlatoConfigStatus> {
    const config = await this.#configStore.read();
    if (config.codexAuth?.openAIApiKeySecretRef) {
      await this.#secretStore.delete(config.codexAuth.openAIApiKeySecretRef);
    }

    await this.#configStore.write({
      ...config,
      codexAuth: undefined,
    });

    return this.getStatus();
  }

  async resolveCodexAuth(): Promise<ResolvedCodexAuth | undefined> {
    const config = await this.#configStore.read();
    const auth = config.codexAuth;
    if (!auth) {
      return undefined;
    }

    if (auth.provider === "openai_api_key" && auth.openAIApiKeySecretRef) {
      const openAIApiKey = await this.#secretStore.get(auth.openAIApiKeySecretRef);
      return openAIApiKey ? { provider: "openai_api_key", openAIApiKey } : undefined;
    }

    if (auth.provider === "chatgpt_oauth" && auth.chatGptOAuth?.accountId) {
      return {
        provider: "chatgpt_oauth",
        chatGptOAuth: auth.chatGptOAuth,
      };
    }

    return undefined;
  }
}

export interface FileConfigStoreOptions {
  path?: string;
}

export class FileConfigStore implements ConfigStore {
  readonly path: string;

  constructor(options: FileConfigStoreOptions = {}) {
    this.path = options.path ?? defaultConfigPath();
  }

  async read(): Promise<PlatoConfigRecord> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as PlatoConfigRecord;
    } catch (error) {
      if (isMissingFile(error)) {
        return {};
      }
      throw error;
    }
  }

  async write(config: PlatoConfigRecord): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(stripUndefined(config), null, 2)}\n`, {
      mode: 0o600,
    });
  }
}

export interface FileSecretStoreOptions {
  path?: string;
}

export class FileSecretStore implements SecretStore {
  readonly #path: string;

  constructor(options: FileSecretStoreOptions = {}) {
    this.#path = options.path ?? defaultSecretsPath();
  }

  async set(secretRef: string, value: string): Promise<void> {
    const secrets = await this.#readSecrets();
    secrets[secretRef] = value;
    await this.#writeSecrets(secrets);
  }

  async get(secretRef: string): Promise<string | undefined> {
    return (await this.#readSecrets())[secretRef];
  }

  async delete(secretRef: string): Promise<void> {
    const secrets = await this.#readSecrets();
    delete secrets[secretRef];
    if (Object.keys(secrets).length === 0) {
      await rm(this.#path, { force: true });
      return;
    }
    await this.#writeSecrets(secrets);
  }

  async #readSecrets(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readFile(this.#path, "utf8")) as Record<string, string>;
    } catch (error) {
      if (isMissingFile(error)) {
        return {};
      }
      throw error;
    }
  }

  async #writeSecrets(secrets: Record<string, string>): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    await writeFile(this.#path, `${JSON.stringify(secrets, null, 2)}\n`, {
      mode: 0o600,
    });
  }
}

export function createFileBackedPlatoConfigService(options: {
  configPath?: string;
  secretsPath?: string;
} = {}): PlatoConfigService {
  return new PlatoConfigService({
    configStore: new FileConfigStore({ path: options.configPath }),
    secretStore: new FileSecretStore({ path: options.secretsPath }),
  });
}

export function defaultConfigPath(): string {
  return resolve(homedir(), ".plato", "config.json");
}

export function defaultSecretsPath(): string {
  return resolve(homedir(), ".plato", "secrets.json");
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripUndefined);
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .map(([key, entryValue]) => [key, stripUndefined(entryValue)]),
  );
}
