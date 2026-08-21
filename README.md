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


## Installing into a profile

The profile's `package.json` takes the dependency; `cordis.patch.yml` inserts the plugin:

```jsonc
// $DSH_HOME/profiles/<name>/package.json
{ "dependencies": { "dsh-claude-cli-provider": "file:/abs/path/to/dsh-claude-cli-provider" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] } } }
```

```yaml
# $DSH_HOME/profiles/<name>/cordis.patch.yml
- insert:
    - id: claude-cli-provider
      name: 'dsh-claude-cli-provider'
      config: { command: /usr/local/bin/claude, timeoutMs: 300000 }
- id: agent-default-model
  config: { provider: claude-cli, model: claude-fable-5 }
```

Then `pnpm install --dir .` in the profile and `dsh --profile <name> "..."`.

**Use an absolute `file:` path.** A relative one resolves against the profile directory and breaks the
moment the profile moves — you get `Cannot find package 'dsh-claude-cli-provider'`.

**Never vendor a stub of `@deepseek-ai/dsh-llm` into this package.** `LlmAdapter` must resolve to the
real base class; a stub silently drops inherited methods and you get
`adapter.providerRetryPolicy is not a function` at plugin load.

## Installing from a local checkout

Use **`link:`**, not `file:`. pnpm *copies* a `file:` dependency into its store, so edits to
your checkout never reach the running harness — the profile keeps executing the copy made at
install time. This is unusually costly here, because the symptom is a fix that "does not work"
rather than a fix that is missing.

```jsonc
{ "dependencies": { "dsh-claude-cli-provider": "link:/path/to/checkout" } }
```

## Config

| key | default | meaning |
|---|---|---|
| `command` | `claude` | path to the CLI |
| `models` | opus-5[1m], opus-5, sonnet-5, fable-5 | exposed models |
| `timeoutMs` | `600000` | **idle** timeout: ms with no output before the CLI is killed |
| `cwd` | process cwd | working directory for the CLI |
| `extraArgs` | `[]` | extra flags passed through |

`timeoutMs` is not a ceiling on how long a turn may run. The timer is re-armed on every byte the
CLI writes to stdout, so a turn that keeps streaming never expires however long it takes, while
one that has genuinely hung is killed after `timeoutMs` of silence. It was an absolute wall until
0.2.0, which killed healthy 10-minute agentic turns mid-stream and discarded their output. When
the kill is ours the error says so, with the duration:
`claude CLI killed after 600s with no output (idle timeout)`.


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
- **This is a reasoning tier, not a tool-executing tier — by design.**
  `claude -p` is itself an agent: given tools it runs *its own* loop with *its own* MCP servers and
  permission prompts, ignoring the schemas dsh passed. Inside a dsh turn that shows up as
  `Claude requested permissions to use mcp__…, but you haven't granted it yet` and no result.
  So this plugin defaults to **`isolateTools: true`**, passing
  `--strict-mcp-config --mcp-config '{"mcpServers":{}}'` to strip Claude's tooling, and dsh's
  native runtime (DeepSeek et al.) executes — it drives dsh's MCP, memory and agent-team tools
  correctly.

  **`isolateTools: false` is the more interesting setting, not merely the escape hatch.** Claude
  keeps its own tools — read, edit, bash, its MCP servers — and can then act as an orchestrator
  *above* dsh rather than a text tier inside it: it plans, reads and reviews on the subscription,
  and shells out to whatever command-line front doors your deployment exposes to dispatch work to
  metered models. Pair it with `extraArgs: ['--dangerously-skip-permissions']`, or the tool loop
  stops at the first approval prompt in non-interactive mode.

  Either way the boundary is the same one: Claude never sees dsh's tool schemas. You are choosing
  whether it brings its own.

- **Claude brings its own context.** The CLI loads your `~/.claude/CLAUDE.md`, output style, and
  memory dir. That is usually helpful, occasionally surprising (it may follow *its* memory
  conventions rather than dsh's).
- Requires a logged-in `claude` CLI on the same host (`claude setup-token` / `/login`).

## Part of a set

Three independent plugins, each usable on its own, that together make a headless DeepSeek
Harness behave like a persistent assistant. They were written one problem at a time and
share no code — the seams between them are the harness's own.

| plugin | what it adds |
|---|---|
| **dsh-claude-cli-provider** *(this one)* | Claude on a subscription as a model route — and, with `isolateTools: false`, as an orchestrator above the harness |
| [dsh-headless-resume](https://github.com/Eyalm321/dsh-headless-resume) | makes one-shot sessions durable, so goals and history survive a process exit |
| [dsh-telegram-inbox](https://github.com/Eyalm321/dsh-telegram-inbox) | a Telegram channel where one chat is one durable agent session |
| [dsh-whatsapp-inbox](https://github.com/Eyalm321/dsh-whatsapp-inbox) | WhatsApp over Twilio, polled — no public endpoint |
| [dsh-mcp-bridge](https://github.com/Eyalm321/dsh-mcp-bridge) | harness capabilities as MCP tools for any client |

The three compose: the inbox resumes a chat, the resume helper keeps that chat's state
honest across restarts, and this provider decides which tier answers it. A useful split is
Claude for reading, planning and review — free on a subscription — with a metered model
doing implementation.

## Test

```bash
npm test                     # unit: fixture -> chunk translation, no CLI needed
```

MIT.
