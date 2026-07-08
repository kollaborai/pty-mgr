# Changelog

## 1.4.3 - 2026-07-07

### Fixed

- `p attach` now sizes the session to the attaching client's terminal instead of
  resizing the client to the session. The old app-driven CSI-8 resize is ignored
  inside tmux/iTerm panes (or resizes the whole window), so a session viewed in a
  smaller pane kept its default winsize — which made a full-frame TUI (e.g. Claude
  Code) flicker its status line and pushed its bottom row off-screen. The client
  now sends its size in the attach request and the daemon resizes the session
  (SIGWINCHing the child) to match.

### Added

- Live-resize while attached: when the client's terminal changes size, the
  session (and its child) resize to follow. The client sends an out-of-band APC
  control frame that the daemon strips from the raw input stream, so it never
  reaches the pty as keystrokes.

## 1.4.2 - 2026-07-07

### Changed

- Internal refactor of `lib/pty-manager.mjs`: the two near-identical socket
  clients collapse into one `requestSocket`, and the terminal-size clamps,
  `--log` wiring, telegram send, capture-stability check, and transcript
  listing move to shared helpers. No behavior or public API change.

### Fixed

- Hardened error handling on three paths that could take the daemon down: the
  socket client now turns a malformed or truncated reply into a rejection
  instead of an uncaught throw in its data handler; the log write stream gets an
  `error` listener (a disk-full / permission error drops logging instead of
  crashing); and attach-mode input is guarded so a keystroke sent to a
  just-exited session no longer throws in the socket handler.

## 1.4.1 - 2026-07-07

### Fixed

- `p attach` replays the session's full terminal state via the xterm
  serialize-addon (scrollback, colors, cursor, modes). Normal-buffer sessions
  (a shell, Claude Code, …) are no longer forced into the alternate screen —
  which had discarded scrollback — so history stays scrollable in the client.
  Alt-screen TUIs still get the alt-screen switch, and the client pops back to
  its normal screen on detach.

## 1.4.0 - 2026-07-07

### Added

- `p attach` replays full scrollback history on connect, not just the visible
  screen.
- Layered flow config resolution: flows merge from the packaged defaults, the
  XDG user config, and a project `pty-mgr.config.json` (project overrides user
  overrides default). `p flow list` tags each flow with its source layer,
  `p flow new [--global]` scaffolds a project (or user) flow, and `p open
  config` opens the config directory.

## 1.3.1 - 2026-07-02

### Fixed

- macOS binaries are now compiled on a macOS runner and ad-hoc code-signed, so
  they carry a valid signature and Apple Silicon (AMFI) no longer SIGKILLs them
  on launch (`killed`). They were previously cross-compiled on Linux, whose
  embedded linker signature is rejected by macOS. The `curl | sh` installer also
  re-signs the binary on download as a fallback for older releases.

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
