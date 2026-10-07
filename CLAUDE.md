# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

pty-mgr is a PTY session manager for programmatic terminal control. It spawns
commands in real pseudo-terminals, emulates the screen buffer with xterm, and
exposes session management via a daemon over Unix sockets.

Single-file architecture in `lib/pty-manager.mjs` (~2500 lines). Contains:
- `PtySession` class: wraps a `Bun.spawn({ terminal })` process + `@xterm/headless`
  Terminal. Bun's native PTY allocates the pseudo-terminal directly (no Python, no
  native addons). The xterm emulator parses escape codes so `capture()` returns
  rendered screen state.
- `PtyManager` class: session registry. spawn/sendKeys/capture/kill/waitFor/waitForExit.
  Exported for library use: `import { PtyManager } from '@mentiko/pty-mgr'`
- Daemon: Unix socket server (JSON-over-newline protocol). Holds sessions persistently.
  Socket at `~/.pty-manager/<name>.sock`. Supports `attach` (raw streaming mode).
- CLI: full command parser with aliases. Entry point `bin/pty-mgr` (also `p`).
- Flow engine: configurable multi-agent workflows driven by
  `pty-mgr.config.json` adapters and turn steering templates.

Requires Bun runtime (not Node.js). Compiles to a single self-contained binary
via `bun build --compile`.

## Commands

```
bun install                          # install deps (@xterm/headless)
bun bin/pty-mgr.mjs demo             # self-test, no daemon needed
bun run demo                         # same
bun run build                        # compile to dist/pty-mgr (single binary)
bun test                             # run unit + daemon + flow tests
```

The `demo` command is a smoke test; `bun test` is the regression suite.

## CLI Usage (after `npm link` or direct)

```
p daemon                             # start daemon (forks to background)
p daemon @myproject                  # named daemon (isolated sessions)
p daemon @@chatroom                  # chat room: every session hears every other
p spawn <name> [cmd] [args...]       # create session
p send <name> <text>                 # send text + enter
p capture <name> [lines]             # get rendered screen
p attach <name>                      # interactive mode (ctrl-] detach)
p view <name1> <name2> [interval]    # read-only split-pane live viewer
p list                               # list sessions
p link <a> <b>                       # relay each agent's finished turn to the other
p link                               # list links + last relay status
p unlink <a|all> [b]                 # drop links
p kill <name|all|glob*>              # kill sessions
p stop [all]                         # stop daemon(s)
p flow list [--verbose]              # list configured agent workflows
p flow show <name>                   # show one flow in detail
p flow run <name> --task <text>      # run a configured agent workflow
```

Aliases: n/new=spawn, s=send, c/cap=capture, k=kill, l/ls=list,
a=attach, v=view, st=status, r/rm=remove, d=daemon, cfg=config, x=stop

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
- Env policy is user-shell-first, not a sandbox. Every session inherits the
  daemon's own environment (`...process.env`), so children see whatever env the
  daemon was started with (PATH, API keys, etc). The `SAFE_ENV_KEYS` whitelist
  (`buildSafeEnv`) only filters *client-supplied* env overlays sent over the
  socket — on both `spawn` and `wrap` — so a socket client can't inject
  arbitrary vars (LD_PRELOAD, DYLD_INSERT_LIBRARIES, …). It does not restrict
  inherited env. One exception: `PtyManager.spawn` strips Claude Code's
  session-identity markers (`CLAUDE_SESSION_MARKERS`: `CLAUDECODE`,
  `CLAUDE_CODE_CHILD_SESSION`, …). A daemon started from inside Claude Code
  inherits them, and a claude child that sees `CLAUDE_CODE_CHILD_SESSION` saves
  no transcript — so its Stop hook reads nothing and every link/room turn drops.
- `wrap` shells out via `zsh -lic`; every cmd/arg token is single-quoted with
  `shellQuote()` so shell metacharacters in args are passed literally (no
  command injection).
- Daemon selector (`@name` / `--daemon <name>`) is parsed by `splitDaemonArgs`
  from the front of argv only — leading token, or trailing a leading
  `daemon`/`d` command. Later `@`-tokens are preserved as data so payloads like
  `send agent "@everyone …"` survive.
- A chat room (`p daemon @@name`) is `p link` with N members, not a second
  mechanism: `turn` only picks a different target list (every live session but
  the speaker, derived — so spawning into a running room joins it), prefixes the
  body with the speaker's name, and reuses the same dedup, idle gate and
  delivery. `@@` is parsed by `splitDaemonArgs` and only acted on by `p daemon`;
  `CHATROOM` is a daemon-local flag that `p link all` / `p unlink all` toggle at
  runtime. Pairwise links are refused while room mode is on. Dedup matches a
  NORMALIZED form (case/punctuation/whitespace stripped) against the speaker's
  last `TURN_MEMORY` turns, not an exact hash of the previous one — measured on
  a real captured loop it drops ~1 in 4 messages, which damps re-punctuation
  ("(holding)" / "(Holding.)") but not paraphrase, so a room of agents each
  finding a NEW way to say nothing still won't dedup-stop — that's
  what `--max` guards: `p daemon @@name --max <n>` / `p link all --max <n>`
  caps total room broadcasts (mirrors `link <a> <b> --max <n>`, `p link` shows
  `broadcasts=N/max`), and `p unlink all` clears the cap along with the links.
- Room provenance: a `send` into a room is prefixed `[human]:` (`HUMAN_LABEL`),
  because an agent turn already carries `<speaker>:` while a human message used
  to arrive unlabelled — which made "the human told me to push" unfalsifiable.
  It is a ROLE derived from the transport, never a person's name. The token is
  deliberately outside `SESSION_NAME_RE` (which cannot produce `[` or `]`), so
  the grammar itself prevents a session from impersonating it — no collision
  check to forget. `sanitizeSpeaker` rewrites `[human]` to `(human)` in relayed
  agent bodies, since the daemon only prefixes line 1 and an agent could
  otherwise put the reserved label on line 2 of its own turn. `send --raw` skips
  the label, and so do slash commands and whitespace-only sends (`[human]:
  /compact` is no longer a command). A room member's own `p send` is labelled
  as that member, not `[human]`: the CLI passes `PTY_MGR_SESSION` /
  `PTY_MGR_DAEMON`, and a sender that is a session of this daemon is never the
  human. Provenance for honest agents, not a sandbox.
- `p link a b` is the unsupervised sibling of `p flow`. The agent CLI's own
  end-of-turn hook (claude `Stop` / codex `notify`, installed by
  `installClaudeHook` in `lib/msg-relay.mjs` and shared with the relay) posts
  the turn-final text to the daemon as `{cmd:"turn"}`; the daemon looks the
  session up in the in-memory `LINKS` map and types the text into the linked
  session through the ordinary `send` path. No orchestrator process, no cycle
  count. Delivery is detached from the hook's request (the CLI blocks on its
  own hook) and gated on a settled screen, since a dropped keystroke stalls the
  loop with nobody watching to retry.
- `p flow` is the agent-orchestration feature. All agent-specific behavior
  belongs in `pty-mgr.config.json`: adapters define how CLI transcripts are
  parsed for sent user messages and completed assistant messages; flows define
  agents, turn routing, and steering text. Do not hardcode review/patch modes
  in code.
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
