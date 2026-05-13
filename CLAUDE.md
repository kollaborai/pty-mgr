# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

pty-mgr is a PTY session manager for programmatic terminal control. It spawns
commands in real pseudo-terminals, emulates the screen buffer with xterm, and
exposes session management via a daemon over Unix sockets.

Single-file architecture in `lib/pty-manager.mjs` (~1400 lines). Contains:
- `PtySession` class: wraps a `Bun.spawn({ terminal })` process + `@xterm/headless`
  Terminal. Bun's native PTY allocates the pseudo-terminal directly (no Python, no
  native addons). The xterm emulator parses escape codes so `capture()` returns
  rendered screen state.
- `PtyManager` class: session registry. spawn/sendKeys/capture/kill/waitFor/waitForExit.
  Exported for library use: `import { PtyManager } from 'pty-mgr'`
- Daemon: Unix socket server (JSON-over-newline protocol). Holds sessions persistently.
  Socket at `~/.pty-manager/<name>.sock`. Supports `attach` (raw streaming mode).
- CLI: full command parser with aliases. Entry point `bin/pty-mgr` (also `p`).

Requires Bun runtime (not Node.js). Compiles to a single self-contained binary
via `bun build --compile`.

## Commands

```
bun install                          # install deps (@xterm/headless)
bun bin/pty-mgr.mjs demo             # self-test, no daemon needed
bun run demo                         # same
bun run build                        # compile to dist/pty-mgr (single binary)
```

No test framework is set up. The `demo` command is the current smoke test.

## CLI Usage (after `npm link` or direct)

```
p daemon                             # start daemon (forks to background)
p daemon @myproject                  # named daemon (isolated sessions)
p spawn <name> [cmd] [args...]       # create session
p send <name> <text>                 # send text + enter
p capture <name> [lines]             # get rendered screen
p attach <name>                      # interactive mode (ctrl-] detach)
p list                               # list sessions
p kill <name|all|glob*>              # kill sessions
p stop [all]                         # stop daemon(s)
```

Aliases: n/new=spawn, s=send, c/cap=capture, k=kill, l/ls=list,
a=attach, st=status, r/rm=remove, d=daemon, cfg=config, x=stop

## Key Design Decisions

- Single .mjs file for all logic. No build step for dev, just `bun run`.
- Bun's native PTY via `Bun.spawn({ terminal })`: no Python, no native addons,
  no external dependencies beyond `@xterm/headless`. Compiles to one binary.
- `@xterm/headless` does terminal emulation so capture() returns what you'd see on
  screen, not raw bytes. Scrollback default 5000 lines.
- Daemon uses newline-delimited JSON over Unix socket. `attach` command switches
  connection to raw streaming mode (bidirectional).
- Session names support glob patterns for bulk operations: `kill refa*`, `capture all`.
- `cap-on-send` config: when enabled, every `send` command returns a capture after 1s delay.
- Env var whitelist in daemon spawn to prevent injection (PATH, HOME, API keys, etc).
- Socket permissions set to 0o600 (owner-only).
- ESM throughout (`"type": "module"` in package.json).

## Distribution

Compiled binary via `bun build --compile`. Published to npm with
platform-specific optionalDependencies (esbuild pattern):

  npm install -g @mentiko/pty-mgr  # downloads binary for your OS/arch
  curl ... | sh              # alternative: install.sh from GH releases

Platform packages: @mentiko/pty-mgr-linux-x64,
@mentiko/pty-mgr-linux-arm64, @mentiko/pty-mgr-darwin-x64,
@mentiko/pty-mgr-darwin-arm64

Release flow: bump version -> `npm run version:sync` -> tag -> push
CI builds all 4 binaries, publishes to npm + GH releases.

## Git

remote: https://github.com/kollaborai/pty-mgr.git
gh cli is authed as kollaborai, push directly.
