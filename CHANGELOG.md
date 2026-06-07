# Changelog

## 1.2.9 - 2026-06-06

### Fixed

- Made `waitFor` poll the rendered screen while listening for data so fast
  command output cannot be missed between spawn and listener timing.
- Made the demo smoke test exit its interactive shell cleanly and verify `kill`
  with a separate disposable process so CI cannot hang on a lingering PTY.

## 1.2.8 - 2026-06-06

### Fixed

- Made the demo smoke test spawn `zsh -f` so CI cannot be blocked by user
  startup files or compinit prompts.

## 1.2.7 - 2026-06-06

### Fixed

- Moved the demo smoke check out of the concurrent `bun test` suite; CI still
  runs it as its own dedicated step.
- Made `waitForExit` tests use a self-exiting PTY command instead of sending
  `exit` into an interactive shell before the prompt is ready.

## 1.2.6 - 2026-06-06

### Fixed

- Fixed a CI-only test race where delayed PTY test callbacks could fire after
  test cleanup destroyed their sessions.
- Supersedes the v1.2.5 tag for the same agent-flow feature set with a stable
  CI run.

## 1.2.5 - 2026-06-06

### Added

- Added `p flow list` and `p flow run <name> --task <text>` for configurable
  multi-agent workflows.
- Added `pty-mgr.config.json` with Claude and Codex adapter examples plus
  `spec-writer` and `review-loop` flow examples.
- Added config-driven transcript parsing for sent user messages and completed
  assistant messages so flows can route between CLI tools without hardcoded
  agent-specific logic.
- Added flow regression tests for competing transcripts, reused sessions, custom
  adapters, steering templates, and CLI argument handling.

### Changed

- Promoted the agent relay prototype into the main single-file implementation
  under `lib/pty-manager.mjs`.
- Removed the old demo relay harness and standardized on `pty-mgr.config.json`.
- Improved setup wrappers, daemon argument parsing, wrap shell quoting, and
  client-supplied environment filtering.

### Fixed

- Fixed flow relay log binding so `p watch` completion cannot cause the relay to
  grab another active agent's newer transcript.
- Fixed reused-session flow handling by binding to the sent prompt instead of
  filtering only by transcript start time.
- Fixed `@...` payload handling so messages like `@everyone` are not mistaken
  for daemon selectors after the command position.
