# Changelog

All notable changes to `dsh-claude-cli-provider`.

## 0.2.0

The shipped default stays `isolateTools: true`. Claude is a reasoning tier here and dsh owns
the tool loop, and part of this release is proving that default is honoured end to end. The
rest is the timeout behaviour change below, plus two fixes that were live in `main` without a
release.

### Changed

- **`timeoutMs` is now an IDLE timeout, not a wall on the whole turn** (behaviour change). The
  timer is re-armed on every byte the CLI writes to stdout: a turn that is still streaming is
  never killed however long it runs, while one that has genuinely hung still is after
  `timeoutMs` of silence. The option name and the `600000` default are unchanged, so no config
  needs editing, but the meaning of the number has changed.

  The reason: on 2026-08-21 a healthy agentic turn was SIGKILLed at exactly 600s while it was
  streaming normally. Chunks had arrived at 11:50:38, 11:52:21, 11:52:50 and one as it died at
  11:54:10. Any turn legitimately longer than ten minutes was unable to complete, and every
  token it had produced was thrown away.

### Fixed

- **A timeout kill is now legible.** The same incident surfaced to the user as
  `claude CLI exited null`, which names neither the cause nor the duration. Our own kill now
  throws `claude CLI killed after 600s with no output (idle timeout)`. A kill this process did
  not initiate still reports the raw exit (now including the signal) and is never labelled a
  timeout, so a crash cannot be misdiagnosed as a slow turn.
- **Claude's own tool calls are no longer forwarded to the harness** (`ab809af`). With tools
  NOT isolated, `claude -p` runs its own loop and has already executed the call. Forwarding
  the `tool_use` block asked the harness to run a tool it does not have, and the turn then
  waited for a result that never arrived. Tool-using turns hung for minutes while plain text
  turns returned in seconds. `translateEvent` now drops `tool_use` when `state.ownsToolLoop`
  is `false`, and forwards it when the harness owns the loop.
- **Image attachments are materialised for `claude -p`** (`e839f4c`). The harness passes
  images as opaque `ImageAttachmentRef`s; the CLI takes a text prompt, so `renderPrompt` was
  silently dropping every image block and the model was asked about a screenshot it could not
  see, with no error anywhere. Bytes are now written to a private per-turn directory (mode
  `0600`, removed in `finally`) and the paths named in the prompt. An unreadable image is
  reported in the prompt rather than throwing away the turn.

### Added

- **argv-level tests for both isolation states** (`test/argv.test.js`). The resolved boolean
  has been right while the argv it produced was wrong: once because `stream()` read only the
  per-call object and ignored adapter config, once because the ternary was inverted. The new
  tests run the real adapter against a stub `claude` binary that records its own argv, and
  assert that `--strict-mcp-config --mcp-config '{"mcpServers":{}}'` is present when isolated
  and absent when not, that a per-call override wins over adapter config in both directions,
  and that `extraArgs` land after the isolation flags. Verified failing under an inverted
  polarity.
- **Idle-timeout tests** (`test/timeout.test.js`). Four tests over stub binaries, asserting on
  observable behaviour rather than on the timer. A stub emitting a chunk every 100ms with a
  300ms `timeoutMs` runs to completion; a silent stub is killed and the error names the idle
  timeout and the duration; a stub that emits once and then goes quiet is still killed, which
  is what distinguishes a re-armed timer from a cancelled one; and a stub exiting non-zero
  still reports its code and stderr. Verified failing both when the timer is made absolute
  again and when the idle label is removed.

### Verified

- `resolveOptions()` to `stream()` to spawned argv, traced end to end for the `isolateTools`
  setting. No break found on that path in this release.
- `npm test`: 34 tests, 34 passing.

## 0.1.0

Initial release: Claude through the local `claude` CLI as a dsh LLM provider, authenticated
by the CLI's own subscription OAuth rather than an Anthropic API key.
