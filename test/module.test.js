import { test } from 'node:test';
import assert from 'node:assert/strict';

test('plugin module loads and exports the cordis contract', async () => {
  const m = await import('../src/index.js');   // catches syntax/dup-declaration errors
  assert.equal(m.name, 'claude-cli-provider');
  assert.deepEqual(m.inject, ['llm']);
  assert.equal(typeof m.apply, 'function');
  assert.equal(m.PROVIDER, 'claude-cli');
  assert.ok(m.DEFAULT_MODELS.length > 0);
});

test('resolveOptions defaults are sane', async () => {
  const { resolveOptions } = await import('../src/index.js');
  const o = resolveOptions({});
  assert.equal(o.command, 'claude');
  assert.ok(o.timeoutMs >= 60_000);
  assert.ok(o.models.some((m) => m.id === 'claude-opus-5[1m]'));
});

test('adapter-level isolateTools reaches the spawned command', async () => {
  const { resolveOptions } = await import('../src/index.js');
  assert.equal(resolveOptions({}).isolateTools, true, 'isolation is the default');
  assert.equal(resolveOptions({ isolateTools: false }).isolateTools, false);
  assert.deepEqual(resolveOptions({ extraArgs: ['--x'] }).extraArgs, ['--x']);
});
