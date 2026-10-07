# Changelog

## 1.8.1 - 2026-10-07

### Fixed

- Links and rooms went silent when the daemon was started from inside Claude
  Code (an agent running `p daemon`): every session inherited
  `CLAUDE_CODE_CHILD_SESSION`, the spawned claude saved no transcript, and its
  Stop hook had nothing to relay. `spawn` now strips Claude Code's
  session-identity markers (`CLAUDE_SESSION_MARKERS`) from the child env.
- Reclaiming an exited session's name, or the 1h corpse reap, no longer leaves
  the old session's links, hop count and dedup memory attached to the name.
- Rooms: an agent's own `p send` was labelled `[human]:`; it is now labelled as
  that agent. Slash commands and whitespace-only sends are no longer labelled,
  so `p send agent /compact` works in a room again.
- Rooms: dedup normalized only `[a-z0-9]`, so any Chinese, Cyrillic or
  emoji-only turn collapsed to an empty string and every later one from the same
  speaker was dropped as a duplicate.
- `unlink all` now clears dedup memory, so a re-armed room does not drop an
  agent's first turn as a repeat of one from before the reset.

## 1.8.0 - 2026-08-02

### Changed

- `spawn` reclaims the name of an **exited** session instead of refusing it. A
  dead session used to squat its own name, so re-running the command that
  created it — the obvious way to restart a crashed dev server or agent — failed
  with `session 'server' already exists`, and you had to know to `p remove` it
  first. Only a **live** session is a collision now. The replacement is never
  silent: the daemon returns `replacedExitCode` and the CLI prints
  `(replaced exited session, exit N)`, so a post-mortem you were about to read
  does not vanish without a word.

### Added

- Exited sessions are dropped an hour after they exit (`CORPSE_TTL_MS`, exported).
  A session is kept past its death on purpose — `capture` still renders its final
  screen, `info` still has its exit code, and `waitForExit` resolves immediately
  instead of racing — but nothing bounded that, so a long-lived daemon pinned a
  full scrollback buffer per corpse forever. `reapExpired()` runs lazily from
  `spawn` and `list` rather than on a timer: the moments that grow or read the
  registry are exactly the moments worth cleaning it. The durable record remains
  the log file (`spawn --log`), which outlives both the window and a daemon
  restart.

## 1.7.0 - 2026-07-30

### Added

- Chat rooms. `p daemon @@name` boots a daemon in room mode: every session
  spawned into it hears every other one's finished turn, prefixed with the
  speaker's session name, so three agents in one room stay tellable apart. There
  is nothing to wire — membership is being spawned there, and a session spawned
  into a room that is already talking joins it immediately, because the audience
  is derived from the live session list rather than stored. The speaker never
  hears its own turn back.

  A room is `p link` with N members instead of a named pair, not a second
  mechanism: the `turn` handler picks a different target list and everything
  else — dedup, the idle gate, the two-write send, the detached delivery — is
  shared. `@@name` selects the same daemon as `@name`; only `p daemon` acts on
  the second `@`, and it also installs the end-of-turn hook, so
  `p daemon @@name` is the only command a room needs.

  No new commands: `p link all` turns room mode on for a running daemon,
  `p unlink all` is the kill switch (leaves room mode and drops every link
  without killing the agents), `p link` lists the room with its members,
  broadcast count and last hop, and `p status` reports it. The kill switch
  matters more here than for a link — N agents each answering every message
  multiply turns in a way a two-agent ping-pong does not. Pairwise `p link a b`
  is refused while room mode is on, since everyone already hears everyone.

### Fixed

- `provisionWorkspace` in the message relay built its `git clone` command line
  with `JSON.stringify`, whose double quotes still allow `$(...)` and backtick
  command substitution under `zsh -lc`. A workspace `repo`, `branch` or `dir`
  containing a substitution ran arbitrary shell during cold-start provisioning.
  All three now go through the same `shellQuote()` the `wrap` path uses.

## 1.6.0 - 2026-07-30

### Added

- `p link <a> <b>` wires two running agents mouth-to-ear: each one's finished
  turn is typed into the other, so a review/advise loop keeps running with no
  orchestrator process babysitting it. This is the unsupervised sibling of
  `p flow` — no scripted turn order, no cycle count, and either side can still
  be talked to by hand at any time. It reuses the agent CLI's own end-of-turn
  hook rather than inventing a second mechanism: the `Stop` hook (shared with
  the message relay, installed idempotently by `p link`; codex's `notify` line
  is printed by `p relay hook install`) posts the turn-final text to the daemon,
  which looks the session up and delivers it through the ordinary `send` path.
  Links need no relay config and no chat entity.

  `--note <text>` appends steering to every relayed turn, `--max <n>` caps the
  hops per side, `--one-way` links a single direction. `p link` with no
  arguments (or `p links`) lists every link with its relay count and the status
  of its last hop; `p unlink <a|all> [b]` is the kill switch.

  Delivery is detached from the hook's request — the CLI blocks on its own hook
  — and gated on a settled screen, since a keystroke dropped into a repainting
  TUI stalls the loop with nobody watching to retry. Repeat turns, empty turns
  and dead targets are dropped rather than injected. Links are forgotten when a
  session is removed and follow it across a rename, so `p links` never reports
  a route that cannot fire.

### Fixed

- Chat focus in the message relay is now scoped per entity instead of per chat
  id. A Telegram private-chat id *is* the human's own user id, so it is
  identical across every bot they run: two entities sharing an admin stole each
  other's focus, and a bare reply to one bot resolved to the session last
  addressed on the other. Only reproduced with 2+ entities sharing a physical
  chat id; single-bot setups were unaffected.

## 1.5.0 - 2026-07-18

### Added

- `p daemons` lists every running daemon on the machine — one line per daemon
  with pid, uptime, session counts, and cwd, in the same style as `p list`. The
  currently-selected daemon (`@name` / `$PTY_DAEMON`) is marked with a leading
  `*`; a socket that no longer answers is shown as `(stale)` and one with an
  empty name as `(unnamed)`. It is read-only — unlike `p stop all` it never
  removes stale sockets. Both commands now share one socket-enumeration helper.

### Fixed

- The installer no longer reports success while an older `pty-mgr` shadows the
  freshly installed one. `install.sh` used to print `PATH is set.` once
  `~/.pty-mgr/bin` was on `PATH`, which said nothing about *which* copy answers:
  a stale binary earlier in `PATH` (e.g. a hand-placed `/usr/local/bin/pty-mgr`,
  which sits on line 1 of macOS `/etc/paths`) would win silently. The installer
  now scans every `PATH` entry after installing and prints any other `pty-mgr`
  or `p` it finds, with an exact `rm` line to remove them.

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
