import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export type ChatGptLoginMode = "browser" | "device_code";

export type ChatGptLoginStarted =
  | {
      type: "browser";
      loginId: string;
      authUrl: string;
    }
  | {
      type: "device_code";
      loginId: string;
      verificationUrl: string;
      userCode: string;
    };

export interface ChatGptLoginCompleted {
  loginId: string;
  success: boolean;
  error?: string | null;
}

export interface CodexAccountSnapshot {
  authMode: "apikey" | "chatgpt" | null;
  email?: string;
  planType?: string;
}

export interface ChatGptOAuthLoginResult {
  started: ChatGptLoginStarted;
  completed: ChatGptLoginCompleted;
  account: CodexAccountSnapshot;
}

export interface StartChatGptOAuthLoginOptions {
  mode?: ChatGptLoginMode;
  timeoutMs?: number;
  onLoginStarted?: (started: ChatGptLoginStarted) => void;
}

export interface CodexAccountRpcTransport {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  notify(method: string, params?: Record<string, unknown>): void;
  waitForNotification(
    method: string,
    predicate: (params: Record<string, unknown>) => boolean,
    timeoutMs: number,
  ): Promise<Record<string, unknown>>;
  close(): void;
}

export interface CodexAppServerAuthClientOptions {
  codexPath?: string;
  transport?: CodexAccountRpcTransport;
  clientInfo?: {
    name: string;
    title: string;
    version: string;
  };
}

export class CodexAppServerAuthClient {
  readonly #transport: CodexAccountRpcTransport;
  #initialized = false;

  constructor(options: CodexAppServerAuthClientOptions = {}) {
    this.#transport =
      options.transport ??
      new JsonlRpcProcessTransport({
        command: options.codexPath ?? "codex",
        args: ["app-server", "--listen", "stdio://"],
      });
    this.#clientInfo = options.clientInfo ?? {
      name: "plato",
      title: "Plato",
      version: "0.1.0",
    };
  }

  readonly #clientInfo: {
    name: string;
    title: string;
    version: string;
  };

  async readAccount(options: { refreshToken?: boolean } = {}): Promise<CodexAccountSnapshot> {
    await this.#initialize();
    return normalizeAccountSnapshot(await this.#transport.request("account/read", options));
  }

  async startChatGptOAuthLogin(
    options: StartChatGptOAuthLoginOptions = {},
  ): Promise<ChatGptOAuthLoginResult> {
    await this.#initialize();
    const started = normalizeLoginStarted(
      await this.#transport.request("account/login/start", {
        type: options.mode === "device_code" ? "chatgptDeviceCode" : "chatgpt",
      }),
    );
    options.onLoginStarted?.(started);

    const completed = normalizeLoginCompleted(
      await this.#transport.waitForNotification(
        "account/login/completed",
        (params) => params.loginId === started.loginId,
        options.timeoutMs ?? 300_000,
      ),
    );
    if (!completed.success) {
      throw new Error(completed.error || "ChatGPT OAuth login failed");
    }

    const account = await this.readAccount({ refreshToken: true });
    if (account.authMode !== "chatgpt") {
      throw new Error("ChatGPT OAuth login completed but Codex did not report chatgpt auth mode");
    }

    return {
      started,
      completed,
      account,
    };
  }

  close(): void {
    this.#transport.close();
  }

  async #initialize(): Promise<void> {
    if (this.#initialized) {
      return;
    }

    await this.#transport.request("initialize", {
      clientInfo: this.#clientInfo,
    });
    this.#transport.notify("initialized");
    this.#initialized = true;
  }
}

interface JsonlRpcProcessTransportOptions {
  command: string;
  args: string[];
}

class JsonlRpcProcessTransport implements CodexAccountRpcTransport {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #notificationWaiters: NotificationWaiter[] = [];
  #nextId = 1;
  #closed = false;
  #stderr = "";

  constructor(options: JsonlRpcProcessTransportOptions) {
    this.#child = spawn(options.command, options.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.#child.stderr.on("data", (chunk: Buffer) => {
      this.#stderr += chunk.toString("utf8");
    });
    this.#child.once("error", (error) => {
      this.#rejectAll(error);
    });
    this.#child.once("exit", (code, signal) => {
      if (!this.#closed) {
        this.#rejectAll(new Error(`Codex app-server exited with ${signal ? `signal ${signal}` : `code ${code ?? 1}`}: ${this.#stderr}`));
      }
    });

    const rl = createInterface({
      input: this.#child.stdout,
      crlfDelay: Infinity,
    });
    rl.on("line", (line) => {
      this.#handleLine(line);
    });
  }

  request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.#nextId++;
    const message = params === undefined ? { id, method } : { id, method, params };

    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#write(message).catch((error: unknown) => {
        this.#pending.delete(id);
        reject(error);
      });
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    const message = params === undefined ? { method } : { method, params };
    void this.#write(message);
  }

  waitForNotification(
    method: string,
    predicate: (params: Record<string, unknown>) => boolean,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const waiter: NotificationWaiter = {
        method,
        predicate,
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.#removeNotificationWaiter(waiter);
          reject(new Error(`Timed out waiting for ${method}`));
        }, timeoutMs),
      };
      this.#notificationWaiters.push(waiter);
    });
  }

  close(): void {
    this.#closed = true;
    this.#child.kill();
  }

  async #write(message: unknown): Promise<void> {
    if (this.#closed) {
      throw new Error("Codex app-server transport is closed");
    }
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleLine(line: string): void {
    if (!line.trim()) {
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch (error) {
      this.#rejectAll(new Error(`Codex app-server emitted invalid JSON: ${line}`, { cause: error }));
      return;
    }

    if (!message || typeof message !== "object") {
      return;
    }

    const record = message as Record<string, unknown>;
    if (typeof record.id === "number") {
      const pending = this.#pending.get(record.id);
      if (!pending) {
        return;
      }
      this.#pending.delete(record.id);
      if (record.error) {
        pending.reject(new Error(formatRpcError(record.error)));
        return;
      }
      pending.resolve(record.result);
      return;
    }

    if (typeof record.method === "string" && isRecord(record.params)) {
      for (let index = this.#notificationWaiters.length - 1; index >= 0; index -= 1) {
        const waiter = this.#notificationWaiters[index];
        if (waiter.method === record.method && waiter.predicate(record.params)) {
          this.#removeNotificationWaiter(waiter);
          waiter.resolve(record.params);
        }
      }
    }
  }

  #removeNotificationWaiter(waiter: NotificationWaiter): void {
    const index = this.#notificationWaiters.indexOf(waiter);
    if (index !== -1) {
      this.#notificationWaiters.splice(index, 1);
    }
    clearTimeout(waiter.timeout);
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
    for (const waiter of this.#notificationWaiters.splice(0)) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
  }
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface NotificationWaiter {
  method: string;
  predicate(params: Record<string, unknown>): boolean;
  resolve(params: Record<string, unknown>): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

function normalizeLoginStarted(value: unknown): ChatGptLoginStarted {
  if (!isRecord(value) || typeof value.loginId !== "string" || typeof value.type !== "string") {
    throw new Error("Codex app-server returned an invalid login start response");
  }

  if (value.type === "chatgpt" && typeof value.authUrl === "string") {
    return {
      type: "browser",
      loginId: value.loginId,
      authUrl: value.authUrl,
    };
  }

  if (
    value.type === "chatgptDeviceCode" &&
    typeof value.verificationUrl === "string" &&
    typeof value.userCode === "string"
  ) {
    return {
      type: "device_code",
      loginId: value.loginId,
      verificationUrl: value.verificationUrl,
      userCode: value.userCode,
    };
  }

  throw new Error("Codex app-server returned an unsupported ChatGPT login response");
}

function normalizeLoginCompleted(value: unknown): ChatGptLoginCompleted {
  if (!isRecord(value) || typeof value.loginId !== "string" || typeof value.success !== "boolean") {
    throw new Error("Codex app-server returned an invalid login completion notification");
  }

  return {
    loginId: value.loginId,
    success: value.success,
    error: typeof value.error === "string" ? value.error : null,
  };
}

function normalizeAccountSnapshot(value: unknown): CodexAccountSnapshot {
  if (!isRecord(value)) {
    throw new Error("Codex app-server returned an invalid account response");
  }

  const account = isRecord(value.account) ? value.account : value;
  const authType = account.type ?? account.authMode;
  const authMode =
    authType === "apiKey"
      ? "apikey"
      : authType === "apikey" || authType === "chatgpt" || authType === null
        ? authType
        : null;

  const email =
    readString(account, ["email", "chatGptEmail", "accountEmail"]) ??
    readString(value, ["email", "chatGptEmail", "accountEmail"]);
  const planType =
    readString(account, ["planType", "chatGptPlanType"]) ??
    readString(value, ["planType", "chatGptPlanType"]);

  return {
    authMode,
    email,
    planType,
  };
}

function readString(value: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const entry = value[key];
    if (typeof entry === "string" && entry.trim()) {
      return entry;
    }
  }
  return undefined;
}

function formatRpcError(error: unknown): string {
  if (isRecord(error) && typeof error.message === "string") {
    return error.message;
  }
  return "Codex app-server request failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
