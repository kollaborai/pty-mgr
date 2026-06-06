# Source this file:
#   source demo/pagent.sh

if [ -n "${BASH_SOURCE:-}" ]; then
  _PAGENT_FILE="${BASH_SOURCE[0]}"
else
  _PAGENT_FILE="${(%):-%N}"
fi

export PAGENT_DEMO_DIR="$(cd "$(dirname "$_PAGENT_FILE")" && pwd)"
export PAGENT_STATE_DIR="$PAGENT_DEMO_DIR/.pagent"
export PAGENT_SESSION_DIR="$PAGENT_STATE_DIR/sessions"

_pagent_json_escape() {
  node -e 'process.stdout.write(JSON.stringify(process.argv[1] || ""))' "$1"
}

_pagent_record_session() {
  local kind="$1"
  local session="$2"
  local started_at_ms="$3"
  local cwd="$4"
  mkdir -p "$PAGENT_SESSION_DIR"
  {
    printf '{\n'
    printf '  "session": %s,\n' "$(_pagent_json_escape "$session")"
    printf '  "kind": %s,\n' "$(_pagent_json_escape "$kind")"
    printf '  "cwd": %s,\n' "$(_pagent_json_escape "$cwd")"
    printf '  "startedAtMs": %s,\n' "$started_at_ms"
    printf '  "startedAt": %s\n' "$(_pagent_json_escape "$(date -u +"%Y-%m-%dT%H:%M:%SZ")")"
    printf '}\n'
  } > "$PAGENT_SESSION_DIR/$session.json"
}

_pagent_start() {
  local kind="$1"
  shift
  local cmd="$1"
  shift
  local started_at_ms
  local launch_cwd
  local wrap_out
  local wrap_status
  local session

  started_at_ms="$(node -e 'process.stdout.write(String(Date.now()))')"
  launch_cwd="$PWD"

  export PAGENT_KIND="$kind"
  export PAGENT_STARTED_AT_MS="$started_at_ms"
  export PAGENT_CWD="$launch_cwd"

  wrap_out="$(pty-mgr wrap "$cmd" "$@" 2>&1)"
  wrap_status=$?
  if [ "$wrap_status" -ne 0 ]; then
    printf '%s\n' "$wrap_out" >&2
    return "$wrap_status"
  fi

  session="$(printf '%s\n' "$wrap_out" | awk '$2 ~ /^pid=[0-9]+$/ { print $1; exit }')"
  if [ -z "$session" ]; then
    printf 'pagent: could not parse pty-mgr wrap output\n%s\n' "$wrap_out" >&2
    return 1
  fi

  export PAGENT_SESSION="$session"
  _pagent_record_session "$kind" "$session" "$started_at_ms" "$launch_cwd"
  printf 'pagent: %s session %s\n' "$kind" "$session" >&2
  printf '%s\n' "$session"
}

_pagent_launch() {
  local session
  session="$(_pagent_start "$@")" || return $?
  pty-mgr attach "$session"
}

pclaude() {
  _pagent_launch claude command claude --dangerously-skip-permissions "$@"
}

pcodex() {
  _pagent_launch codex command codex --yolo "$@"
}

pclaude_bg() {
  _pagent_start claude command claude --dangerously-skip-permissions "$@"
}

pcodex_bg() {
  _pagent_start codex command codex --yolo "$@"
}

prelay() {
  node "$PAGENT_DEMO_DIR/relay.mjs" "$@"
}

pduo() {
  node "$PAGENT_DEMO_DIR/duo.mjs" "$@"
}

plast() {
  local session="$1"
  if [ -z "$session" ]; then
    printf 'usage: plast <session>\n' >&2
    return 1
  fi
  local meta="$PAGENT_SESSION_DIR/$session.json"
  if [ ! -f "$meta" ]; then
    printf 'pagent: no metadata for %s\n' "$session" >&2
    return 1
  fi
  local kind started cwd
  kind="$(node -e 'const m=require(process.argv[1]); process.stdout.write(m.kind)' "$meta")"
  started="$(node -e 'const m=require(process.argv[1]); process.stdout.write(String(m.startedAtMs))' "$meta")"
  cwd="$(node -e 'const m=require(process.argv[1]); process.stdout.write(m.cwd)' "$meta")"
  local latest
  latest="$(node "$PAGENT_DEMO_DIR/log-tail.mjs" latest --kind "$kind" --cwd "$cwd" --sinceMs "$started" | node -e 'let s=""; process.stdin.on("data", d => s += d); process.stdin.on("end", () => process.stdout.write(JSON.parse(s).file || ""));')"
  if [ -z "$latest" ]; then
    printf 'pagent: no log found for %s\n' "$session" >&2
    return 1
  fi
  node "$PAGENT_DEMO_DIR/log-tail.mjs" last --kind "$kind" --file "$latest"
}
