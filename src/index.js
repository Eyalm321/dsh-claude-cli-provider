/**
 * dsh-claude-cli-provider — Claude through the local `claude` CLI.
 *
 * Auth is the CLI's own subscription OAuth: this plugin never reads a credential
 * file and never sends an API key. That is the whole point — it is the dsh
 * equivalent of OpenClaw's `claude-cli` agentRuntime, so a Claude planning/review
 * tier costs subscription usage instead of metered API tokens.
 */
import { spawn } from 'node:child_process';
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
  constructor(options) {
    super();
    this.options = options;
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
    const { command, timeoutMs, cwd, extraArgs } = this.options;
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',                       // required with -p + stream-json
      '--model', options.model,
      ...extraArgs,
    ];

    const child = spawn(command, args, {
      cwd: cwd || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      // Strip any API key so a stray env var cannot silently switch this to metered billing.
      env: { ...process.env, ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '' },
    });

    const state = { nextIndex: 0, usage: undefined, stopReason: undefined, sawResult: false, errorText: undefined };
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += String(d); });

    const timer = timeoutMs
      ? setTimeout(() => child.kill('SIGKILL'), timeoutMs)
      : undefined;

    // one-shot prompt on stdin, then EOF
    child.stdin.end(renderPrompt(options.messages, options.system));

    const exited = new Promise((resolve) => child.on('close', (code) => resolve(code)));

    try {
      const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed || trimmed[0] !== '{') continue;
        let event;
        try { event = JSON.parse(trimmed); } catch { continue; }  // tolerate non-JSON noise
        for (const chunk of translateEvent(event, state)) yield chunk;
      }

      const code = await exited;
      if (state.errorText) throw new Error(`claude CLI: ${state.errorText}`);
      if (code !== 0) {
        throw new Error(`claude CLI exited ${code}${stderr ? `: ${stderr.slice(-500)}` : ''}`);
      }
      for (const chunk of finalChunks(state)) yield chunk;
    } finally {
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
    extraArgs: config.extraArgs ?? [],
    models: config.models?.length ? config.models : DEFAULT_MODELS,
  };
}

export function apply(ctx, config) {
  const options = resolveOptions(config);
  const adapter = new ClaudeCliAdapter(options);

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
