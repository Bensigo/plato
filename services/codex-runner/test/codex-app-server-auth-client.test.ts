import { describe, expect, it } from "vitest";

import {
  CodexAppServerAuthClient,
  type CodexAccountRpcTransport,
} from "../src/auth/codex-app-server-auth-client.js";

class FakeTransport implements CodexAccountRpcTransport {
  requests: Array<{ method: string; params?: Record<string, unknown> }> = [];
  notifications: Array<{ method: string; params?: Record<string, unknown> }> = [];

  constructor(
    private readonly responses: {
      loginStart: unknown;
      loginCompleted: Record<string, unknown>;
      account: unknown;
    },
  ) {}

  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === "initialize") {
      return { userAgent: "codex-test" };
    }
    if (method === "account/login/start") {
      return this.responses.loginStart;
    }
    if (method === "account/read") {
      return this.responses.account;
    }
    throw new Error(`Unexpected request: ${method}`);
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.notifications.push({ method, params });
  }

  async waitForNotification(
    method: string,
    predicate: (params: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown>> {
    if (method !== "account/login/completed" || !predicate(this.responses.loginCompleted)) {
      throw new Error("Unexpected notification wait");
    }
    return this.responses.loginCompleted;
  }

  close(): void {}
}

describe("CodexAppServerAuthClient", () => {
  it("starts browser ChatGPT OAuth and reads the signed-in Codex account", async () => {
    const transport = new FakeTransport({
      loginStart: {
        type: "chatgpt",
        loginId: "login-1",
        authUrl: "https://chatgpt.com/auth",
      },
      loginCompleted: {
        loginId: "login-1",
        success: true,
      },
      account: {
        account: {
          type: "chatgpt",
          email: "user@example.com",
          planType: "plus",
        },
        requiresOpenaiAuth: false,
      },
    });
    const startedEvents: unknown[] = [];

    await expect(
      new CodexAppServerAuthClient({ transport }).startChatGptOAuthLogin({
        onLoginStarted: (started) => startedEvents.push(started),
      }),
    ).resolves.toEqual({
      started: {
        type: "browser",
        loginId: "login-1",
        authUrl: "https://chatgpt.com/auth",
      },
      completed: {
        loginId: "login-1",
        success: true,
        error: null,
      },
      account: {
        authMode: "chatgpt",
        email: "user@example.com",
        planType: "plus",
      },
    });

    expect(startedEvents).toEqual([
      {
        type: "browser",
        loginId: "login-1",
        authUrl: "https://chatgpt.com/auth",
      },
    ]);
    expect(transport.requests.map((request) => request.method)).toEqual([
      "initialize",
      "account/login/start",
      "account/read",
    ]);
    expect(transport.requests[2]?.params).toEqual({
      refreshToken: true,
    });
    expect(transport.notifications).toEqual([{ method: "initialized", params: undefined }]);
  });

  it("uses the Codex device-code flow for headless ChatGPT OAuth", async () => {
    const transport = new FakeTransport({
      loginStart: {
        type: "chatgptDeviceCode",
        loginId: "login-2",
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-1234",
      },
      loginCompleted: {
        loginId: "login-2",
        success: true,
      },
      account: {
        account: {
          type: "chatgpt",
          planType: "pro",
        },
      },
    });

    await new CodexAppServerAuthClient({ transport }).startChatGptOAuthLogin({
      mode: "device_code",
    });

    expect(transport.requests[1]).toEqual({
      method: "account/login/start",
      params: {
        type: "chatgptDeviceCode",
      },
    });
  });
});
