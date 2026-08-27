/**
 * The model catalog, checked against the rules the harness actually enforces.
 *
 * These are copied from the validator in dsh-llm rather than invented: it discards the WHOLE
 * catalog on the first bad entry, so a single missing field means the UI lists no models for
 * this provider. That failed silently for as long as nobody opened the model picker, because
 * stream() never consults the catalog.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeCliAdapter, resolveOptions, PROVIDER } from '../src/index.js';

/** The harness's own acceptance test, verbatim in behaviour. */
function harnessWouldAccept(models, provider) {
  const seen = new Set();
  for (const m of models) {
    if (typeof m.provider !== 'string' || m.provider !== provider) return `provider: ${m.id}`;
    if (typeof m.id !== 'string' || m.id.length === 0) return 'id';
    if (typeof m.name !== 'string' || m.name.length === 0) return `name: ${m.id}`;
    if (m.description !== undefined && typeof m.description !== 'string') return `description: ${m.id}`;
    if (seen.has(m.id)) return `duplicate: ${m.id}`;
    seen.add(m.id);
  }
  return null;
}

test('the catalog is one the harness will accept', async () => {
  const adapter = new ClaudeCliAdapter(resolveOptions({}));
  const models = await adapter.listModels(PROVIDER);
  assert.ok(models.length > 0, 'a provider with no models is invisible');
  assert.equal(harnessWouldAccept(models, PROVIDER), null);
});

test('every entry names the route it was asked about, not a hardcoded one', async () => {
  const adapter = new ClaudeCliAdapter(resolveOptions({}));
  const models = await adapter.listModels('some-other-route');
  assert.equal(harnessWouldAccept(models, 'some-other-route'), null,
    'the harness compares against the provider it passed in');
});

test('images are declared, because this provider materialises them', async () => {
  const adapter = new ClaudeCliAdapter(resolveOptions({}));
  const [first] = await adapter.listModels(PROVIDER);
  // The key is inputModalities: `modalities` is silently ignored, which is how this shipped
  // claiming text-only while the Telegram path was sending it photos and video frames.
  assert.deepEqual(first.inputModalities, ['text', 'image']);
});

test('a configured model list is passed through, still validly', async () => {
  const adapter = new ClaudeCliAdapter(resolveOptions({
    models: [{ id: 'custom-1', name: 'Custom One', contextWindow: 1000 }],
  }));
  const models = await adapter.listModels(PROVIDER);
  assert.equal(models.length, 1);
  assert.equal(harnessWouldAccept(models, PROVIDER), null);
});

test('duplicate ids would be rejected — the check that names this bug', () => {
  const dupes = [
    { provider: 'claude-cli', id: 'x', name: 'X' },
    { provider: 'claude-cli', id: 'x', name: 'X again' },
  ];
  assert.match(harnessWouldAccept(dupes, 'claude-cli'), /duplicate/);
});
