/**
 * `timeoutMs` is an IDLE timeout, and its expiry is legible.
 *
 * A live turn was SIGKILLed at exactly 600s on 2026-08-21 while it was still streaming, because
 * the timer was an absolute wall on the whole turn. Every token it had produced was discarded
 * and the user saw only `claude CLI exited null`. These tests pin both halves of the fix by
 * observable behaviour: whether a stub binary survives, and what the thrown error says.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCliAdapter, resolveOptions } from '../src/index.js';

/** Stub preamble: drain stdin like `claude -p` does, then run `body` on EOF. */
const stub = (body) => `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
${body}
});
`;

/** Emits a text chunk every `gap` ms, `count` times, then a clean result and exit 0. */
const CHATTY = stub(`
  let n = 0;
  const tick = () => {
    n += 1;
    console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'chunk ' + n }] } }));
    if (n < 6) { setTimeout(tick, 100); return; }
    console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' } }));
    console.log(JSON.stringify({ type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } }));
    process.exit(0);
  };
  setTimeout(tick, 100);
`);

/** Never writes anything; would run far past any test timeout if left alone. */
const SILENT = stub(`  setTimeout(() => process.exit(0), 5000);`);

/** One chunk at 200ms, then silence. The timer must re-arm on that chunk, not be cancelled. */
const THEN_SILENT = stub(`
  setTimeout(() => {
    console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }));
    setTimeout(() => process.exit(0), 5000);
  }, 200);
`);

/** Fails the way the real CLI does: a stderr line and a non-zero code. */
const FAILING = stub(`
  process.stderr.write('boom: credential expired\\n');
  process.exit(3);
`);

/** Run one real stream() against `source`, returning what it yielded, threw, and how long it took. */
async function run(source, config = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-claude-timeout-'));
  const bin = join(dir, 'fake-claude.mjs');
  await writeFile(bin, source);
  await chmod(bin, 0o755);

  const adapter = new ClaudeCliAdapter(resolveOptions({ timeoutMs: 300, ...config, command: bin }));
  const chunks = [];
  const started = Date.now();
  let error;
  try {
    for await (const chunk of adapter.stream({
      model: 'claude-opus-5',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) {
      chunks.push(chunk);
    }
  } catch (err) {
    error = err;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return { chunks, error, elapsed: Date.now() - started };
}

test('a turn still producing output outlives timeoutMs instead of being killed', async () => {
  const { chunks, error, elapsed } = await run(CHATTY);
  assert.equal(error, undefined, `expected completion, got: ${error?.message}`);
  assert.ok(elapsed > 300, `stub should have outlived the 300ms idle timeout, ran ${elapsed}ms`);
  assert.ok(chunks.some((c) => c.type === 'finish'), 'stream finished normally');
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text);
  assert.ok(text.includes('chunk 6'), `expected every chunk through to the last: ${text.join('|')}`);
});

test('a silent turn is killed, and the error names the idle timeout and its duration', async () => {
  const { error, elapsed } = await run(SILENT);
  assert.ok(error, 'expected a throw');
  assert.match(error.message, /idle timeout/);
  assert.match(error.message, /300ms/);
  assert.doesNotMatch(error.message, /exited null/, 'must not fall through to the raw-exit message');
  assert.ok(elapsed < 2000, `should be killed near the timeout, took ${elapsed}ms`);
});

test('output re-arms the timer rather than cancelling it: later silence still kills', async () => {
  const { chunks, error, elapsed } = await run(THEN_SILENT);
  assert.ok(chunks.some((c) => c.type === 'text-delta'), 'the one chunk was delivered');
  assert.ok(error, 'expected a throw once it went silent');
  assert.match(error.message, /idle timeout/);
  // Output landed at 200ms with a 300ms idle window, so the kill belongs at ~500ms. An absolute
  // wall would have fired at 300ms; anything under 400ms means the timer never re-armed.
  assert.ok(elapsed >= 400, `expected the timer to re-arm on output, killed after ${elapsed}ms`);
});

test('a non-zero exit still reports its code and stderr, not a timeout', async () => {
  const { error } = await run(FAILING);
  assert.ok(error, 'expected a throw');
  assert.match(error.message, /claude CLI exited 3/);
  assert.match(error.message, /boom: credential expired/);
  assert.doesNotMatch(error.message, /idle timeout/, 'a real failure must not be mislabelled');
});

test('Stop kills the CLI: an aborted turn does not leave the child running', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-claude-abort-'));
  const pidFile = join(dir, 'pid');
  const stub = join(dir, 'slow.mjs');
  await writeFile(stub, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.stdin.resume();
setInterval(() => {}, 1000);            // never finishes on its own
`);
  await chmod(stub, 0o755);

  const controller = new AbortController();
  const adapter = new ClaudeCliAdapter(resolveOptions({ command: stub, timeoutMs: 0 }));
  const stream = adapter.stream({
    model: 'claude-opus-5',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    signal: controller.signal,
  });

  const drained = (async () => { for await (const _ of stream) { /* nothing arrives */ } })();
  // Wait for the child to exist, then abort as the Stop button does.
  for (let i = 0; i < 50 && !existsSync(pidFile); i += 1) await new Promise((r) => setTimeout(r, 40));
  const pid = Number(await readFile(pidFile, 'utf8'));
  assert.ok(pid > 0, 'the stub should have started');
  controller.abort();

  // Bounded on purpose. Without the kill the stub runs forever, and an unbounded await turns a
  // regression into a hung suite instead of a failed test — which is exactly what happened once.
  const verdict = await Promise.race([
    drained.then(() => 'resolved', (e) => String(e?.message ?? e)),
    new Promise((r) => setTimeout(() => r('TIMED OUT: the turn never ended after abort'), 5000)),
  ]);
  assert.match(verdict, /aborted by caller/, 'the turn reports cancellation, not a crash');

  let alive = true;
  for (let i = 0; i < 50 && alive; i += 1) {
    await new Promise((r) => setTimeout(r, 40));
    try { process.kill(pid, 0); } catch { alive = false; }
  }
  if (alive) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  assert.equal(alive, false, 'the CLI child must not outlive the turn that was stopped');
  await rm(dir, { recursive: true, force: true });
});

test('a turn with no signal behaves exactly as before', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-claude-nosignal-'));
  const stub = join(dir, 'quick.mjs');
  await writeFile(stub, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', usage: {} }) + '\\n');
  process.exit(0);
});
`);
  await chmod(stub, 0o755);
  const adapter = new ClaudeCliAdapter(resolveOptions({ command: stub }));
  const seen = [];
  for await (const c of adapter.stream({ model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] })) seen.push(c.type);
  assert.ok(seen.includes('finish'));
  await rm(dir, { recursive: true, force: true });
});

test('a turn nobody is reading any more does not leave the CLI running', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-claude-abandon-'));
  const pidFile = join(dir, 'pid');
  const stub = join(dir, 'chatty.mjs');
  // Emits forever: only the watchdog can end this, never the child itself.
  await writeFile(stub, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.stdin.resume();
setInterval(() => {
  process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'tick' }] } }) + '\\n');
}, 50);
`);
  await chmod(stub, 0o755);

  const adapter = new ClaudeCliAdapter(resolveOptions({ command: stub, timeoutMs: 0, consumerStallMs: 300 }));
  const stream = adapter.stream({
    model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
  });
  // Take one chunk and walk away, exactly as the harness does when a turn is cancelled:
  // no return(), no abort, just nobody asking for the next chunk.
  const it = stream[Symbol.asyncIterator]();
  await it.next();
  for (let i = 0; i < 40 && !existsSync(pidFile); i += 1) await new Promise((r) => setTimeout(r, 40));
  const pid = Number(await readFile(pidFile, 'utf8'));
  assert.ok(pid > 0);

  let alive = true;
  for (let i = 0; i < 60 && alive; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
    try { process.kill(pid, 0); } catch { alive = false; }
  }
  if (alive) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  assert.equal(alive, false, 'an abandoned turn must not leave the CLI spending tokens');
  await rm(dir, { recursive: true, force: true });
});
