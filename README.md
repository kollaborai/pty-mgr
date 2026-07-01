# pty-mgr

PTY session manager with terminal emulation for programmatic session control.

Spawn commands in real pseudo-terminals, capture rendered screen output (not raw
bytes), and manage sessions through a persistent daemon. Single binary, no
external dependencies.

## How It Works

`Bun.spawn({ terminal })` allocates a native PTY for each session. An
`@xterm/headless` terminal emulator parses escape codes, cursor movements, and
screen redraws so `capture()` returns exactly what you'd see on screen.

Compiles to a single self-contained binary via `bun build --compile`.

## Install

### Binary (no dependencies)

```
curl -fsSL https://raw.githubusercontent.com/kollaborai/pty-mgr/main/install.sh | sh
```

Installs to `~/.pty-mgr/bin/` and adds to PATH. Works on Linux and macOS (x64, arm64).

### NPM package

```
npm install -g @mentiko/pty-mgr
```

Installs the wrapper plus the platform binary for your OS/arch.

### Bun package (for library use)

```
bun add @mentiko/pty-mgr
```

Requires [Bun](https://bun.sh) runtime.

## Quick Start

### As a library

```js
import { PtyManager } from '@mentiko/pty-mgr';

const mgr = new PtyManager();
mgr.spawn('my-session', 'zsh', [], { cols: 120, rows: 30 });
mgr.sendKeys('my-session', 'echo hello\r');

// rename a running session
mgr.rename('my-session', 'my-session-renamed');

// wait for output, then capture rendered screen
setTimeout(() => {
  console.log(mgr.capture('my-session-renamed', 5));
  mgr.kill('my-session-renamed');
}, 1000);
```

### As a CLI

```
# start the daemon (forks to background)
p daemon

# named daemon for isolated environments
p daemon @myproject

# spawn a session
# auto-incrementing session named after current directory
p wrap                    # spawns as pty-mgr-1
p wrap                    # spawns as pty-mgr-2
p wrap                    # spawns as pty-mgr-3
p spawn agent-1 claude --print

# send keystrokes
p send agent-1 "fix the login bug"

# capture rendered screen (last 20 lines)
p capture agent-1 20

# send raw text with no trailing enter
p send agent-1 --raw "partial input"

# poll whether a session is still working (diffs two captures)
p watch agent-1 4s

# attach interactively (ctrl-] to detach)
p attach agent-1

# rename a session
p rename agent-1 agent-refactored

# bulk operations with globs
p capture all 50
p kill refa*

# daemon status + config
p status

# stop daemon
p stop
```

## Command Reference

Every command (`p --help`):

| Command | Description |
|---------|-------------|
| `p daemon` | Start daemon (forks to background) |
| `p daemon @myproject` | Named daemon (isolated sessions) |
| `p status` | Daemon info + config |
| `p config` | Show current config |
| `p config screen 100x50` | Set default terminal size |
| `p config cap-on-send on\|off` | Return a capture with every send |
| `p config send-delay <ms>` | Delay before enter (default 1000) |
| `p spawn <name> [cmd] [args...]` | Create session (default `zsh`) |
| `p wrap [cmd] [args...]` | Spawn with auto-incrementing cwd name |
| `p attach <name>` | Interactive mode (ctrl-] detach) |
| `p send <name> <text>` | Send text + enter |
| `p send <name> --raw <text>` | Send text as-is (no enter) |
| `p capture <name> [lines]` | Capture rendered screen |
| `p capture all [lines]` | Capture from all sessions |
| `p capture <glob*> [lines]` | Capture matching sessions |
| `p watch <name> [interval]` | Diff two bottom-100 captures → `done`/`working` |
| `p list` | List all sessions |
| `p alive <name>` | Check if a session is alive |
| `p info <name>` | Session details |
| `p kill <name>` | Kill session |
| `p kill all` | Kill all sessions |
| `p kill <glob*>` | Kill matching sessions |
| `p rename <old> <new>` | Rename a session |
| `p remove <name\|all\|glob*>` | Kill + remove |
| `p log <name> on [jsonl\|raw\|rendered]` | Start logging |
| `p log <name> off` | Stop logging |
| `p spawn <name> --log [cmd]` | Spawn with logging (jsonl) |
| `p stop` | Stop current daemon |
| `p stop all` | Stop all daemons |
| `p setup` | Wrap CLI tools (claude, etc.) |
| `p flow list [--config file]` | List configured agent workflows |
| `p flow run <name> --task <text>` | Run a configured agent workflow |
| `p tg <message>` | Send a Telegram notification |
| `p tg <message> --reply [--timeout N]` | Send and block for a reply |
| `p demo` | Run self-test (no daemon needed) |

`p watch <name> [interval]` captures the bottom 100 lines, waits `interval`
(default `4s`; accepts `4s`, `1000ms`, or a bare millisecond value), captures
again, and prints `done` if the screen is unchanged or `working` if it moved —
a cheap idle check for polling long-running agents.

## Agent Flows

`p flow` runs configurable agent-collaboration workflows. The workflow lives in
`pty-mgr.config.json`; the binary provides the PTY/session/log plumbing.

```
p daemon
p flow list
p flow run spec-writer --task "Create a spec for the auth rewrite."
p flow run review-loop --task "Review this repo." --max-cycles 2

# one agent implements, another reviews the real git diff, the first revises
p flow run code-review --task "Add rate limiting to the /login route" --cwd ~/dev/myapp
```

Both agents in a flow launch in the same working directory (`--cwd`, or wherever
you run the command), so a reviewer agent can open the actual files the writer
produced — not just react to its chat summary.

A flow has:

- `adapters`: how to launch each CLI and parse sent user + assistant logs.
- `agents`: named participants in a workflow, each using an adapter kind.
- `start`: which agent receives the initial task.
- `turns`: routing and steering templates between agents.

Useful run flags:

- `--goal <text>`: separate long-running goal text from the initial task.
- `--max-cycles <n>`: override the workflow's configured cycle count.
- `--watch-interval <duration>`: compare bottom-100-line captures after this
  interval to detect a stable screen (`4s`, `1000ms`, or a bare millisecond
  value; default `10s`).
- `--interval-ms <n>`: poll cadence between stability checks (default `1000`).
- `--settle-ms <n>`: wait after a stable capture before reading the transcript.
- `--timeout-ms <n>`: return incomplete instead of waiting forever.

Example steering:

```json
{
  "from": "author",
  "to": "reviewer",
  "append": "Based on this, what gaps do you see and what should change next?"
}
```

Supported template variables:

- `{task}`: the initial task passed on the CLI.
- `{goal}`: `--goal` if provided, otherwise the task.
- `{lastMessage}`: the completed assistant response being relayed.
- `{cycle}`: current cycle number.
- `{from}` / `{to}`: source and target agent names.

The shipped `pty-mgr.config.json` includes three examples for Claude/Codex:

- `spec-writer`: author drafts, reviewer critiques, author revises.
- `review-loop`: two agents trade a task back and forth.
- `code-review`: Codex implements the task, then Claude reviews the actual
  `git diff` (correctness, edge cases, security) and Codex applies the fixes.
  This is the "one agent writes code, another reviews it" workflow — run it
  with `p flow run code-review --task "..." --cwd <repo>`.

Add new adapters for Gemini, OpenCode, or another CLI by defining where that
tool stores JSONL logs and how to extract the latest sent user message and
completed assistant message.

Flow transcript lookup is bound to the exact user prompt sent to the session,
then assistant extraction starts after that prompt. That prevents one active
agent from accidentally relaying another agent's newer log.

### CLI Aliases

| Short | Full    | Short | Full    |
|-------|---------|-------|---------|
| n/new  | spawn   | w/wrap  | wrap    |
| s      | send    | k       | kill    |
| c/cap  | capture | l/ls    | list    |
| a      | attach  | r/rm    | remove  |
| st     | status  | mv/ren  | rename  |
| i      | info    | d       | daemon  |
| cfg    | config  | x       | stop    |

## Managed CLI Sessions

Wrap any CLI tool (claude, codex, gemini, etc.) in managed PTY sessions.
Run the interactive setup:

```
pty-mgr setup
```

It asks which commands to wrap, then adds shell functions to your rc file.
After that, just type `claude` like normal. What you get:

- Claude runs inside a managed PTY session named `<folder>-1`
- If you open another claude in the same folder, it gets `<folder>-2`
- `ctrl-]` to detach -- Claude keeps running in the background
- `p attach <name>` to jump back in
- `p capture <name> 50` to check on it from another terminal
- `p list` to see all your Claude sessions across all projects

```
$ cd ~/dev/my-app
$ claude                     # spawns as my-app-1, attaches
  ctrl-]                     # detach
$ claude                     # spawns as my-app-2
  ctrl-]
$ p list
my-app-1  pid=1234  120x40  alive  claude
my-app-2  pid=1235  120x40  alive  claude
$ p capture my-app-1 20      # peek at what agent 1 is doing
$ p attach my-app-1          # jump back into agent 1
```

### Programmatic (parallel agents)

```js
import { PtyManager } from '@mentiko/pty-mgr';

const mgr = new PtyManager();

// launch 3 Claude agents in parallel
const agents = ['auth-fix', 'api-tests', 'docs-update'];
for (const name of agents) {
  mgr.spawn(name, 'claude', ['--print'], { cols: 120, rows: 40 });
}

mgr.sendKeys('auth-fix', 'fix the login bug in src/auth.ts\r');
mgr.sendKeys('api-tests', 'write tests for the /users endpoint\r');
mgr.sendKeys('docs-update', 'update the API docs in README.md\r');

// poll until all agents finish
for (const name of agents) {
  await mgr.waitFor(name, /[✔✓]|completed|done/i, 120000);
  console.log(`${name} done:\n${mgr.capture(name, 10)}\n`);
}

mgr.destroyAll();
```

## Telegram Remote Control

Drive your sessions from Telegram — check on agents, capture output, send input,
and get notified when a task needs you, all from your phone.

Set two env vars before starting the daemon:

```
export TELEGRAM_BOT_TOKEN=<token from @BotFather>
export TELEGRAM_CHAT_ID=<your chat id>
p daemon
```

When `TELEGRAM_BOT_TOKEN` is set, the daemon starts a bot poller automatically.
Only messages from `TELEGRAM_CHAT_ID` are honored. Bot commands:

| Command | Description |
|---------|-------------|
| `/list` (`/ls`) | List sessions |
| `/capture <name> [lines]` (`/cap`, `/c`) | Capture output (defaults to last used session) |
| `/send <name> <text>` (`/s`) | Send text + enter, then auto-capture once the session settles |
| `/kill <name>` (`/k`) | Kill a session |
| `/spawn <name> [cmd]` (`/n`) | Spawn a session |
| `/status` | Daemon info |
| `/help` (`/start`) | List commands |

`/capture` and `/send` remember the last session you touched, so you can omit
the name on follow-ups.

From inside a session (or a script), push notifications the other direction with
the `tg` command:

```
p tg "build finished, needs review"          # fire-and-forget notification
p tg "approve deploy? (y/n)" --reply          # block until you reply, print it
p tg "still there?" --reply --timeout 120     # wait up to 120s (default 60)
```

`--reply` blocks the caller until you answer in Telegram and prints your reply to
stdout — useful for human-in-the-loop gates inside an agent flow. The `tg` sender
uses `PTY_MGR_SESSION` (set automatically in wrapped/managed sessions) to tag
which session is asking.

## Daemon Protocol

The daemon listens on a Unix socket at `~/.pty-manager/<name>.sock`.
Communication is newline-delimited JSON:

```json
{"cmd": "spawn", "name": "agent-1", "args": {"cmd": "zsh"}}
{"cmd": "wrap", "args": {"cmd": "zsh", "cwd": "/Users/you/dev/myproject"}}
{"cmd": "send", "name": "agent-1", "args": {"text": "echo hi\r"}}
{"cmd": "capture", "name": "agent-1", "args": {"lines": 20}}
{"cmd": "resize", "name": "agent-1", "args": {"cols": 120, "rows": 40}}
{"cmd": "list"}
{"cmd": "info", "name": "agent-1"}
{"cmd": "alive", "name": "agent-1"}
{"cmd": "status"}
{"cmd": "config", "args": {"key": "screen", "value": "120x40"}}
{"cmd": "log", "name": "agent-1", "args": {"action": "on", "format": "jsonl"}}
{"cmd": "kill", "name": "agent-1"}
{"cmd": "remove", "name": "agent-1"}
{"cmd": "rename", "name": "agent-1", "args": {"newName": "agent-refactored"}}
{"cmd": "tg-send", "args": {"message": "done"}}
{"cmd": "shutdown"}
```

The `attach` command switches the connection to raw streaming mode for
interactive use.

## Configuration

```
p status                     # daemon info + current config
p config                     # show current config
p config screen 120x40       # default terminal size for new sessions
p config cap-on-send on      # return capture with every send command
p config send-delay 500      # ms to wait before the trailing enter (default 1000)
```

Config persists in the daemon and applies to new sessions.

## Logging

```
p spawn agent-1 --log claude   # spawn with auto-logging (jsonl)
p log agent-1 on jsonl         # start logging an existing session
p log agent-1 off              # stop logging
```

Formats: `jsonl` (timestamped events), `raw` (PTY bytes), `rendered` (screen snapshots).

## Build

```
bun run build    # compiles to dist/pty-mgr (single binary, ~60MB)
```

## License

MIT
