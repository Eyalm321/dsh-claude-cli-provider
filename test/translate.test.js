import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translateEvent, finalChunks, usageOf, finishReasonOf, renderPrompt } from '../src/translate.js';

const fresh = () => ({ nextIndex: 0 });

test('system/init and hook events produce no chunks', () => {
  const s = fresh();
  assert.deepEqual(translateEvent({ type: 'system', subtype: 'init', model: 'claude-fable-5' }, s), []);
  assert.deepEqual(translateEvent({ type: 'system', subtype: 'hook_started' }, s), []);
  assert.equal(s.nextIndex, 0);
});

test('assistant text block -> start/delta/end with stable index', () => {
  const s = fresh();
  const out = translateEvent({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'DSH-CLAUDE-OK' }], stop_reason: 'end_turn' },
  }, s);
  assert.deepEqual(out.map((c) => c.type), ['block-start', 'text-delta', 'block-end']);
  assert.equal(out[0].blockType, 'text');
  assert.equal(out[1].text, 'DSH-CLAUDE-OK');
  assert.equal(out[2].block.text, 'DSH-CLAUDE-OK');
  assert.ok(out.every((c) => c.index === 0));
  assert.equal(s.stopReason, 'end_turn');
});

test('thinking block maps to reasoning, and empty thinking is skipped', () => {
  const s = fresh();
  const out = translateEvent({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }] } }, s);
  assert.deepEqual(out.map((c) => c.type), ['block-start', 'reasoning-delta', 'block-end']);
  assert.equal(out[0].blockType, 'reasoning');
  const s2 = fresh();
  assert.deepEqual(translateEvent({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '' }] } }, s2), []);
});

test('tool_use block serialises arguments', () => {
  const s = fresh();
  const out = translateEvent({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { cmd: 'ls' } }] },
  }, s);
  assert.equal(out[0].blockType, 'tool-call');
  assert.equal(out[1].argumentsDelta, '{"cmd":"ls"}');
  assert.equal(out[2].block.name, 'Bash');
});

test('multiple blocks get distinct increasing indices', () => {
  const s = fresh();
  const out = translateEvent({
    type: 'assistant',
    message: { content: [{ type: 'thinking', thinking: 'a' }, { type: 'text', text: 'b' }] },
  }, s);
  assert.deepEqual([...new Set(out.map((c) => c.index))], [0, 1]);
});

test('usage folds cache tokens into input (real shape from claude -p)', () => {
  assert.deepEqual(
    usageOf({ input_tokens: 2, cache_creation_input_tokens: 23184, cache_read_input_tokens: 16030, output_tokens: 7 }),
    { inputTokens: 39216, outputTokens: 7 },
  );
});

test('finish reasons map to dsh vocabulary', () => {
  assert.equal(finishReasonOf('end_turn'), 'stop');
  assert.equal(finishReasonOf('max_tokens'), 'length');
  assert.equal(finishReasonOf('tool_use'), 'tool-calls');
  assert.equal(finishReasonOf(undefined), 'stop');
});

test('result event records error and usage', () => {
  const s = fresh();
  translateEvent({ type: 'result', is_error: true, result: 'boom', usage: { input_tokens: 1, output_tokens: 2 } }, s);
  assert.equal(s.errorText, 'boom');
  assert.deepEqual(s.usage, { inputTokens: 1, outputTokens: 2 });
});

test('finalChunks emits usage then finish', () => {
  const out = finalChunks({ usage: { inputTokens: 1, outputTokens: 2 }, stopReason: 'end_turn' });
  assert.deepEqual(out.map((c) => c.type), ['usage', 'finish']);
  assert.equal(out[1].reason, 'stop');
});

test('renderPrompt includes system and assistant turns', () => {
  const p = renderPrompt(
    [{ role: 'user', content: [{ type: 'text', text: 'hi' }] },
     { role: 'assistant', content: [{ type: 'text', text: 'yo' }] }],
    'be terse',
  );
  assert.match(p, /<system>\nbe terse\n<\/system>/);
  assert.match(p, /<assistant>\nyo\n<\/assistant>/);
  assert.match(p, /hi/);
});

test('tool results render their content, never "[object Object]"', async () => {
  const { renderToolResult, blockText, renderPrompt } = await import('../src/translate.js');
  assert.equal(renderToolResult([{ type: 'text', text: 'files: 7' }]), 'files: 7');
  assert.equal(renderToolResult('plain'), 'plain');
  assert.equal(renderToolResult(null), '');
  assert.equal(renderToolResult([{ type: 'image', data: 'x' }]), '{"type":"image","data":"x"}');
  assert.equal(blockText({ type: 'tool-result', content: [{ type: 'text', text: 'ok' }] }), 'ok');

  const out = renderPrompt([{ role: 'user', content: [{ type: 'tool-result', content: [{ type: 'text', text: 'RESULT' }] }] }]);
  assert.match(out, /RESULT/);
  assert.doesNotMatch(out, /\[object Object\]/);
});

test('a circular tool result degrades to empty rather than throwing', async () => {
  const { renderToolResult } = await import('../src/translate.js');
  const loop = { a: 1 }; loop.self = loop;
  assert.equal(renderToolResult(loop), '');
});

test('a tool call is forwarded when the harness owns the tool loop', async () => {
  const { translateEvent } = await import('../src/translate.js');
  const state = { nextIndex: 0, ownsToolLoop: true };
  const out = translateEvent({ type: 'assistant', message: { content: [
    { type: 'tool_use', id: 't1', name: 'read', input: { path: '/x' } },
  ] } }, state);
  assert.ok(out.some((c) => c.type === 'block-start' && c.blockType === 'tool-call'));
});

test('a tool call is SWALLOWED when Claude owns the loop — it already ran it', async () => {
  const { translateEvent } = await import('../src/translate.js');
  const state = { nextIndex: 0, ownsToolLoop: false };
  const out = translateEvent({ type: 'assistant', message: { content: [
    { type: 'tool_use', id: 't1', name: 'mcp__dsh__dsh_tasks_list', input: {} },
  ] } }, state);
  assert.deepEqual(out, [], 'forwarding it makes the harness wait for a result that never comes');
});

test('text still flows while tool calls are swallowed', async () => {
  const { translateEvent } = await import('../src/translate.js');
  const state = { nextIndex: 0, ownsToolLoop: false };
  const out = translateEvent({ type: 'assistant', message: { content: [
    { type: 'tool_use', id: 't1', name: 'x', input: {} },
    { type: 'text', text: '2 open tasks.' },
  ] } }, state);
  assert.equal(out.filter((c) => c.type === 'text-delta')[0].text, '2 open tasks.');
  assert.ok(!out.some((c) => c.blockType === 'tool-call'));
});
