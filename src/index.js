/**
 * dsh-claude-cli-provider — Claude through the local `claude` CLI.
 *
 * Auth is the CLI's own subscription OAuth: this plugin never reads a credential
 * file and never sends an API key. That is the whole point — it is the dsh
 * equivalent of OpenClaw's `claude-cli` agentRuntime, so a Claude planning/review
 * tier costs subscription usage instead of metered API tokens.
 */
import { spawn } from 'node:child_process';
import { collectImages, materialise, describeImages } from './images.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { createInterface } from 'node:readline';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { translateEvent, finalChunks, renderPrompt } from './translate.js';

export const name = 'claude-cli-provider';
export const inject = ['llm'];

export const PROVIDER = 'claude-cli';
export const SETTINGS_NS = 'llm-claude-cli';

const DEFAULT_MODELS = [
  { id: 'claude-opus-5[1m]', name: 'Claude Opus 5 (1M context)', contextWindow: 1_000_000 },
  { id: 'claude-opus-5', name: 'Claude Opus 5', contextWindow: 200_000 },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', contextWindow: 200_000 },
  { id: 'claude-fable-5', name: 'Claude Fable 5', contextWindow: 200_000 },
];

class ClaudeCliAdapter extends LlmAdapter {
  constructor(options, deps = {}) {
    super();
    this.options = options;
    // Supplied by apply(): reads bytes for an ImageAttachmentRef. Without it, images
    // are reported as unavailable rather than silently dropped.
    this.readImage = deps.readImage;
  }

  providerInfo(provider) {
    return { id: provider, name: 'Claude (local CLI, subscription)' };
  }

  async listModels() {
    return this.options.models.map((m) => ({
      id: m.id,
      name: m.name,
      contextWindow: m.contextWindow,
      modalities: ['text'],
    }));
  }

  async *stream(options) {
    const trace = process.env.CLAUDE_CLI_TRACE
      ? (m) => { try { require('node:fs').appendFileSync(process.env.CLAUDE_CLI_TRACE, `${Date.now()} ${m}\n`); } catch {} }
      : () => {};
    const { command, timeoutMs, cwd, extraArgs, isolateTools } = this.options;
    // `claude -p` is itself an agent: left alone it runs ITS OWN tool loop with
    // ITS OWN MCP servers, ignoring the tool schemas dsh passed us. That produces
    // confusing "Claude requested permissions to use mcp__..." failures inside a
    // dsh turn. So by default we strip Claude's tooling and use it as a pure
    // reasoning/text tier; dsh's own runtime (DeepSeek et al) owns tool execution.
    // Per-call wins over adapter config; adapter config is what a profile actually sets.
    // (These were read from the wrong object until 2026-08-20, so the adapter setting was
    // silently ignored and Claude always kept its own tools.)
    const isolated = options.isolateTools ?? isolateTools;
    const isolate = isolated
      ? ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']
      : [];
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',                       // required with -p + stream-json
      '--model', options.model,
      ...isolate,
      ...extraArgs,
    ];

    // Images arrive as opaque attachment refs; claude -p takes text. Write the bytes to a
    // private per-turn directory and name the paths in the prompt — Claude Code reads image
    // files with its own tools, which is exactly the non-isolated mode.
    const media = await materialise(collectImages(options.messages), this.readImage);
    if (media.files.length || media.failed) {
      trace(`images: ${media.files.length} materialised, ${media.failed} unreadable`);
    }

    trace(`isolated=${isolated} optionsIsolate=${options.isolateTools} adapterIsolate=${isolateTools} tools=${(options.tools||[]).length}`);
    trace(`spawn ${args.join(' ').slice(0,160)}`);
    const child = spawn(command, args, {
      cwd: cwd || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      // Strip any API key so a stray env var cannot silently switch this to metered billing.
      env: { ...process.env, ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '' },
    });

    const state = { nextIndex: 0, usage: undefined, stopReason: undefined, sawResult: false, errorText: undefined , ownsToolLoop: isolated };
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += String(d); });

    const timer = timeoutMs
      ? setTimeout(() => child.kill('SIGKILL'), timeoutMs)
      : undefined;

    // one-shot prompt on stdin, then EOF
    const described = describeImages(media.files, media.failed);
    child.stdin.end(renderPrompt(options.messages, options.system) + (described ? `\n\n${described}` : ''));

    const exited = new Promise((resolve) => child.on('close', (code) => resolve(code)));

    try {
      const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed || trimmed[0] !== '{') continue;
        let event;
        try { event = JSON.parse(trimmed); } catch { continue; }  // tolerate non-JSON noise
        trace(`recv ${event.type}${event.subtype ? '/' + event.subtype : ''}`);
        for (const chunk of translateEvent(event, state)) { trace(`emit ${chunk.type}`); yield chunk; }
      }

      const code = await exited;
      if (state.errorText) throw new Error(`claude CLI: ${state.errorText}`);
      if (code !== 0) {
        throw new Error(`claude CLI exited ${code}${stderr ? `: ${stderr.slice(-500)}` : ''}`);
      }
      for (const chunk of finalChunks(state)) yield chunk;
    } finally {
      await media.cleanup();
      if (timer) clearTimeout(timer);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }
}

export function resolveOptions(config = {}) {
  return {
    command: config.command ?? 'claude',
    timeoutMs: config.timeoutMs ?? 600_000,
    cwd: config.cwd ?? '',
    isolateTools: config.isolateTools ?? true,
    extraArgs: config.extraArgs ?? [],
    models: config.models?.length ? config.models : DEFAULT_MODELS,
  };
}

export function apply(ctx, config) {
  const options = resolveOptions(config);
  // The attachment service is resolved lazily: it is composed by the host and may register
  // after this plugin. Resolving per call also means a deployment without attachments simply
  // reports images as unavailable instead of failing to mount.
  const readImage = async (ref) => {
    const store = ctx.get('attachments');
    if (!store?.readImage) throw new Error('no attachment service');
    const out = await store.readImage(ref);
    return out?.data ?? out;
  };
  const adapter = new ClaudeCliAdapter(options, { readImage });

  // Shape is fixed by dsh-llm's commit(): provider/displayName/settingsNs/settingsPath,
  // each non-empty. (Not {id,name,models} — that throws INVALID_DIRECTORY.)
  ctx.llm.registerConfigurableProviders?.([
    {
      provider: PROVIDER,
      displayName: 'Claude (local CLI, subscription)',
      settingsNs: SETTINGS_NS,
      settingsPath: [],
    },
  ]);
  ctx.llm.registerAdapter([PROVIDER], adapter);
}

export { ClaudeCliAdapter, DEFAULT_MODELS };
