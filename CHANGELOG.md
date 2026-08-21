# Changelog

All notable changes to `dsh-claude-cli-provider`.

## 0.2.0

The shipped default stays `isolateTools: true`. Claude is a reasoning tier here and dsh owns
the tool loop; this release is mostly about proving that default is honoured end to end, plus
two fixes that were live in `main` without a release.

### Fixed

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

### Verified

- `resolveOptions()` to `stream()` to spawned argv, traced end to end for the `isolateTools`
  setting. No break found on that path in this release.
- `npm test`: 30 tests, 30 passing.

## 0.1.0

Initial release: Claude through the local `claude` CLI as a dsh LLM provider, authenticated
by the CLI's own subscription OAuth rather than an Anthropic API key.
