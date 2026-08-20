# dsh-claude-cli-provider

Claude as a **DeepSeek Harness** LLM provider, served by the local `claude` CLI — so it bills against a
**Claude Pro/Max subscription instead of an Anthropic API key**.

This is the dsh equivalent of OpenClaw's `claude-cli` agentRuntime. It exists because the only other
Claude provider for dsh authenticates with `x-api-key` (metered). If you want a Claude *planning and
review* tier above cheaper implementation models, this makes that tier free.

## How it works

Spawns `claude -p --output-format stream-json --verbose --model <model>`, reads the NDJSON event
stream, and translates it into dsh `StreamChunk`s (`block-start` / `text-delta` / `reasoning-delta` /
`tool-call-delta` / `block-end` / `usage` / `finish`).

- **Auth is the CLI's.** This plugin never reads `~/.claude/.credentials.json` and never sends a key.
- It **blanks `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`** in the child env, so a stray variable
  can't silently flip you onto metered billing.
- `thinking` blocks become `reasoning` chunks; `tool_use` becomes `tool-call`.
- Cache-creation and cache-read tokens are folded into `inputTokens` (Claude reports them separately).

## Install

```bash
dsh plugin --profile <name> add dsh-claude-cli-provider
```

`cordis.patch.yml` inserts the plugin; it registers provider id **`claude-cli`**.

## Config

| key | default | meaning |
|---|---|---|
| `command` | `claude` | path to the CLI |
| `models` | opus-5[1m], opus-5, sonnet-5, fable-5 | exposed models |
| `timeoutMs` | `600000` | hard kill for a stuck run |
| `cwd` | process cwd | working directory for the CLI |
| `extraArgs` | `[]` | extra flags passed through |


## Gotcha: settings precedence

`$DSH_HOME/settings.yaml` (the **user layer**) overrides a profile's `cordis.patch.yml`. If your
settings pin `agent-default-model` to another provider, your profile patch is ignored and you'll get a
misleading `TRANSPORT: Connection error` from *that* provider — not from this plugin. Either set

```yaml
agent-default-model:
  provider: claude-cli
  model: claude-fable-5
```

in `settings.yaml`, or run the profile under its own `DSH_HOME`.

## Limits (known, deliberate)

- **One-shot per request.** `claude -p` is non-interactive: messages are flattened into a single
  prompt. Multi-turn context is replayed, not resumed, so long conversations re-send history.
- **Block-level, not token-level streaming.** The CLI emits whole content blocks; each becomes one
  delta. Output appears in chunks, not character-by-character.
- **Tool calls are surfaced but the CLI runs its own tools.** Treat this provider as a text/reasoning
  tier; let dsh's own tool loop own execution.
- Requires a logged-in `claude` CLI on the same host (`claude setup-token` / `/login`).

## Test

```bash
npm test                     # unit: fixture -> chunk translation, no CLI needed
```

MIT.
