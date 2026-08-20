/**
 * Pure translation: `claude -p --output-format stream-json` events -> dsh StreamChunks.
 * Kept free of I/O so it is unit-testable against fixtures.
 */

/** Map Claude's stop_reason onto dsh's FinishReason vocabulary. */
export function finishReasonOf(stopReason) {
  switch (stopReason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool-calls';
    default:
      return 'stop';
  }
}

/** Claude usage -> dsh TokenUsage (cache reads/writes folded into input). */
export function usageOf(u = {}) {
  const input =
    (u.input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0);
  return { inputTokens: input, outputTokens: u.output_tokens ?? 0 };
}

/**
 * Translate one parsed stream-json event into zero or more StreamChunks.
 * `state` carries the running block index across calls.
 */
export function translateEvent(event, state) {
  const out = [];
  if (!event || typeof event !== 'object') return out;

  // Only assistant turns carry model content. `system` (init/hooks) is noise here;
  // `result` closes the turn.
  if (event.type === 'assistant' && event.message) {
    const msg = event.message;
    for (const block of msg.content ?? []) {
      if (block.type === 'text' && block.text) {
        const index = state.nextIndex++;
        out.push({ type: 'block-start', index, blockType: 'text' });
        out.push({ type: 'text-delta', index, text: block.text });
        out.push({ type: 'block-end', index, block: { type: 'text', text: block.text } });
      } else if (block.type === 'thinking' && block.thinking) {
        const index = state.nextIndex++;
        out.push({ type: 'block-start', index, blockType: 'reasoning' });
        out.push({ type: 'reasoning-delta', index, text: block.thinking });
        out.push({ type: 'block-end', index, block: { type: 'reasoning', text: block.thinking } });
      } else if (block.type === 'tool_use') {
        const index = state.nextIndex++;
        const args = JSON.stringify(block.input ?? {});
        out.push({ type: 'block-start', index, blockType: 'tool-call' });
        out.push({ type: 'tool-call-delta', index, argumentsDelta: args });
        out.push({
          type: 'block-end',
          index,
          block: { type: 'tool-call', id: block.id, name: block.name, arguments: args },
        });
      }
    }
    if (msg.usage) {
      state.usage = usageOf(msg.usage);
    }
    if (msg.stop_reason) {
      state.stopReason = msg.stop_reason;
    }
  }

  if (event.type === 'result') {
    if (event.usage) state.usage = usageOf(event.usage);
    state.sawResult = true;
    if (event.is_error) state.errorText = event.result ?? 'claude CLI reported an error';
  }

  return out;
}

/** Terminal chunks emitted once the process ends cleanly. */
export function finalChunks(state) {
  const out = [];
  if (state.usage) out.push({ type: 'usage', usage: state.usage });
  out.push({ type: 'finish', reason: finishReasonOf(state.stopReason) });
  return out;
}

/** Flatten dsh Messages into a single prompt for the CLI's one-shot print mode. */
export function renderPrompt(messages = [], system) {
  const parts = [];
  if (system) parts.push(`<system>\n${system}\n</system>`);
  for (const m of messages) {
    const text = (m.content ?? [])
      .map((b) => (b.type === 'text' ? b.text : b.type === 'tool-result' ? String(b.content ?? '') : ''))
      .filter(Boolean)
      .join('\n');
    if (!text) continue;
    parts.push(m.role === 'assistant' ? `<assistant>\n${text}\n</assistant>` : text);
  }
  return parts.join('\n\n');
}
