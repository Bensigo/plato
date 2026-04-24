# Plato Config

`@plato/config` owns local user configuration and auth material for Plato.

Milestone 21 starts with Codex auth because Plato cannot run a real end-to-end worker flow until the runtime knows how the user wants to authenticate. The first supported provider is an OpenAI API key. ChatGPT OAuth is also represented as a first-class provider, using Codex app-server managed login for ChatGPT subscription usage.

## What This Service Owns

- local config file reads and writes
- local secret storage fallback for development and MVP testing
- redacted auth status for operator surfaces
- resolving Codex auth for execution services

## Defaults

- config: `~/.plato/config.json`
- local secret fallback: `~/.plato/secrets.json`

The local secret file is an MVP fallback, not the long-term storage strategy. A future pass should add an OS keychain-backed `SecretStore` implementation.

## Codex Auth

Use the service API directly or the runner CLI:

```sh
codex-runner config status
printf '%s' "$OPENAI_API_KEY" | codex-runner config set-openai-key --api-key-stdin
# or: codex-runner config set-openai-key --api-key-env OPENAI_API_KEY
codex-runner config auth-chatgpt
codex-runner config auth-chatgpt --device-code
codex-runner config clear-openai-key
```

`codex-runner` reads this config when opening its operator runtime and passes the configured OpenAI API key into the Codex SDK. For ChatGPT OAuth, Plato records only safe account metadata and the fact that the token source is Codex app-server. Codex owns the browser/device-code OAuth flow, persists refresh tokens in its own auth store, and refreshes them for subscription-backed runs.
