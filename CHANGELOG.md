# Changelog

## 1.3.0 - 2026-07-02

### Added

- `p view <name1> <name2> [interval]` — live, read-only side-by-side session
  viewer. Renders two sessions in split panes with a divider and name headers,
  refreshes on an interval (default `500ms`), handles terminal resizes, and
  exits cleanly on `q` / `Ctrl-C`. Requires at least 21 terminal columns.
- `p flow show <name>` — prints a single configured flow in detail: agents and
  their adapter kinds, the start target, each turn's routing and steering text,
  and cycle/interval/settle settings. Errors on unknown flow names.
- `p flow list --verbose` — shows each flow's agents, adapter kinds, start
  target, and maxCycles alongside the flow name.
- `code-review` flow added to the shipped `pty-mgr.config.json`: Codex writes,
  Claude reviews the actual `git diff` on disk, and Codex applies the fixes.

### Fixed

- Flow prompt submission: sending a prompt to a freshly booted TUI could leave
  the text typed but un-submitted (Enter races startup), so no transcript was
  ever created and the flow waited out the full timeout with zero turns. Now
  confirms the sent message appears in the agent's transcript and nudges with a
  bare Enter if not; a stranded start fails fast with a clear reason.
- Waits for the agent CLI to boot before sending the first prompt.

## 1.2.11 - 2026-06-06

### Fixed

- Made the standalone `p demo` command exit explicitly after cleanup so
  linux PTY handles cannot keep Bun alive after the demo prints complete.

## 1.2.10 - 2026-06-06

### Fixed

- Replaced the demo smoke test's interactive shell prompt dependency with a
  deterministic scripted PTY shell reader.
- Added a CI timeout around the demo smoke step so future PTY hangs fail loudly
  instead of parking the workflow.

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
