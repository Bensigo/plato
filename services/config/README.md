# Plato Config

`@plato/config` owns local user configuration and auth material for Plato.

Milestone 21 starts with Codex auth because Plato cannot run a real end-to-end worker flow until the runtime knows how the user wants to authenticate. The first supported provider is an OpenAI API key. ChatGPT OAuth is represented in the domain model as a provider, but the OAuth flow itself is intentionally left for a later milestone.

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
codex-runner config set-openai-key --api-key "$OPENAI_API_KEY"
codex-runner config clear-openai-key
```

`codex-runner` reads this config when opening its operator runtime and passes the configured OpenAI API key into the Codex SDK.
