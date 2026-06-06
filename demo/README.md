# pagent demo

Run the full demo:

```sh
./demo/demo.sh
```

That launches a Claude worker and Codex planner in managed PTY sessions, waits
for them to initialize, then runs one `pduo` cycle.

Or source the shell functions manually:

```sh
source demo/pagent.sh
```

Launch managed agents:

```sh
pclaude
pcodex
```

Detach from either PTY with `ctrl-]`, then list sessions:

```sh
pty-mgr list
```

Relay the newest assistant response from one session into another:

```sh
prelay <from-session> <to-session>
```

Run the worker/planner loop:

```sh
pduo <claude-session> <codex-session> --task "Notice any issues with this codebase."
```

Use existing sessions with the full script:

```sh
./demo/demo.sh --claude <claude-session> --codex <codex-session>
```

Flow:

1. `pduo` sends the task to Claude.
2. `pduo` runs `p watch <claude-session> <interval>` until Claude's bottom 100
   captured lines are stable, waits the settle delay, then checks stability again.
3. `pduo` reads Claude's newest completed assistant response and sends it to
   Codex with: `What should I fix first and how?`
4. Codex reviews Claude's findings and replies with direction.
5. `pduo` runs `p watch <codex-session> <interval>` with the same settle check.
6. `pduo` sends Codex's direction back to Claude with:
   `Do the work now. When finished, report what changed...`
7. On the next Claude completion, `pduo` sends the result back to Codex with:
   `What should we do next?`

By default `pduo` runs one full Claude -> Codex -> Claude cycle. Use
`--max-cycles N` to keep the loop going. Use `--watch-interval 10s` to change
the stability interval, and `--settle-ms 1500` to change the post-watch delay.

Inspect the latest parsed assistant response for one managed session:

```sh
plast <session>
```

State is written under `demo/.pagent/`.

## Adapter config

Agent log parsing is driven by `wrap.config` adapters. Each adapter defines:

- `command`: CLI command to launch.
- `defaultArgs`: unattended/default args for demo launchers.
- `roots`: JSONL transcript roots. Supports `${projectKey}`, `${cwd}`, and `${home}`.
- `sessionTimestampPaths`: JSON paths used to match logs created after launch.
- `assistant.where`: JSON path equality checks that identify assistant message rows.
- `assistant.complete`: optional JSON path equality checks for completed rows.
- `assistant.text`: JSON paths or filtered arrays that extract assistant text.

After `p watch <session> <interval>` returns `done`, the relay scans the matched
JSONL log backward from the bottom and sends the first completed assistant text
row that matches `assistant.where`, optional `assistant.complete`, and
`assistant.text`.
It does not require a hardcoded `final_answer` phase.
