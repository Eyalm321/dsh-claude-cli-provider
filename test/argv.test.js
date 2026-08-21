/**
 * The isolateTools default, asserted against the argv that is actually spawned.
 *
 * Booleans are not enough here. The resolved `isolated` flag has been correct while the argv
 * it produced was wrong (once because stream() read the per-call object only, so adapter
 * config was ignored; once because the ternary was inverted). So these tests run the real
 * adapter against a stub `claude` binary that records its own argv, and assert on that.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCliAdapter, resolveOptions } from '../src/index.js';

const MCP_FLAGS = ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'];

/**
 * A stand-in for the `claude` binary: dumps its argv to a file, drains stdin, then emits a
 * minimal but valid stream-json turn and exits 0 so stream() completes normally.
 */
function stubSource(argvFile) {
  return `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => {
  const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  say({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' } });
  say({ type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } });
  process.exit(0);
});
`;
}

/** Run one real stream() against the stub and return the argv it was spawned with. */
async function spawnedArgv(config = {}, callOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-claude-argv-'));
  const argvFile = join(dir, 'argv.json');
  const stub = join(dir, 'fake-claude.mjs');
  await writeFile(stub, stubSource(argvFile));
  await chmod(stub, 0o755);

  const adapter = new ClaudeCliAdapter(resolveOptions({ ...config, command: stub }));
  const chunks = [];
  try {
    for await (const chunk of adapter.stream({
      model: 'claude-opus-5',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      ...callOptions,
    })) {
      chunks.push(chunk);
    }
    return { argv: JSON.parse(await readFile(argvFile, 'utf8')), chunks };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** True when argv carries the full MCP-stripping flag sequence, adjacent and in order. */
function stripsMcp(argv) {
  for (let i = 0; i + MCP_FLAGS.length <= argv.length; i += 1) {
    if (MCP_FLAGS.every((flag, k) => argv[i + k] === flag)) return true;
  }
  return false;
}

test('shipped default strips Claude\'s own MCP tooling from the spawned argv', async () => {
  const { argv, chunks } = await spawnedArgv();
  assert.ok(stripsMcp(argv), `expected MCP-stripping flags in argv: ${JSON.stringify(argv)}`);
  assert.ok(argv.includes('-p'));
  assert.equal(argv[argv.indexOf('--model') + 1], 'claude-opus-5');
  assert.ok(chunks.some((c) => c.type === 'finish'), 'stream completed');
});

test('isolateTools:false leaves Claude its own tooling, so no MCP flags in argv', async () => {
  const { argv } = await spawnedArgv({ isolateTools: false });
  assert.ok(!stripsMcp(argv), `expected no MCP-stripping flags: ${JSON.stringify(argv)}`);
  assert.ok(!argv.includes('--strict-mcp-config'));
  assert.ok(!argv.includes('--mcp-config'));
  assert.ok(!argv.includes('{"mcpServers":{}}'));
});

test('per-call isolateTools overrides adapter config in both directions', async () => {
  const off = await spawnedArgv({ isolateTools: true }, { isolateTools: false });
  assert.ok(!stripsMcp(off.argv), 'per-call false must win over adapter true');

  const on = await spawnedArgv({ isolateTools: false }, { isolateTools: true });
  assert.ok(stripsMcp(on.argv), 'per-call true must win over adapter false');
});

test('extraArgs are appended after the isolation flags', async () => {
  const { argv } = await spawnedArgv({ extraArgs: ['--dangerously-skip-permissions'] });
  assert.ok(stripsMcp(argv));
  assert.equal(argv.at(-1), '--dangerously-skip-permissions');
  assert.ok(argv.indexOf('--strict-mcp-config') < argv.indexOf('--dangerously-skip-permissions'));
});
