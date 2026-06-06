#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

TASK="Notice any issues with this codebase."
WATCH_INTERVAL="10s"
MAX_CYCLES="1"
CLAUDE_SESSION=""
CODEX_SESSION=""
START_DELAY="8"
SETTLE_MS="1500"

usage() {
  cat <<'EOF'
usage:
  ./demo/demo.sh [options]

options:
  --task <text>             assignment sent to the claude worker
  --watch-interval <dur>    p watch interval, e.g. 1s or 4000ms
  --settle-ms <ms>          delay after stable watch before log parsing
  --max-cycles <n>          claude -> codex -> claude cycles
  --claude <session>        use existing claude pty session
  --codex <session>         use existing codex pty session
  --start-delay <seconds>   wait after auto-launch before pduo starts

examples:
  ./demo/demo.sh
  ./demo/demo.sh --task "Review this repo for obvious issues." --max-cycles 1
  ./demo/demo.sh --claude pty-mgr-1 --codex pty-mgr-2 --watch-interval 4s
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --task) TASK="$2"; shift 2 ;;
    --watch-interval) WATCH_INTERVAL="$2"; shift 2 ;;
    --settle-ms) SETTLE_MS="$2"; shift 2 ;;
    --max-cycles) MAX_CYCLES="$2"; shift 2 ;;
    --claude) CLAUDE_SESSION="$2"; shift 2 ;;
    --codex) CODEX_SESSION="$2"; shift 2 ;;
    --start-delay) START_DELAY="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

# shellcheck disable=SC1091
source demo/pagent.sh

echo "pagent demo"
echo

if ! command -v pty-mgr >/dev/null 2>&1; then
  echo "missing pty-mgr in PATH" >&2
  exit 1
fi

pty-mgr status >/dev/null 2>&1 || pty-mgr daemon >/dev/null

if [ -z "$CLAUDE_SESSION" ]; then
  echo "launching claude worker..."
  CLAUDE_SESSION="$(pclaude_bg)"
fi

if [ -z "$CODEX_SESSION" ]; then
  echo "launching codex planner..."
  CODEX_SESSION="$(pcodex_bg)"
fi

echo
echo "sessions:"
echo "  claude: $CLAUDE_SESSION"
echo "  codex:  $CODEX_SESSION"
echo
echo "current pty sessions:"
pty-mgr list || true
echo

if [ "$START_DELAY" != "0" ]; then
  echo "waiting ${START_DELAY}s for CLIs to initialize..."
  sleep "$START_DELAY"
fi

echo
echo "running pduo:"
echo "  task:           $TASK"
echo "  watch interval: $WATCH_INTERVAL"
echo "  settle ms:      $SETTLE_MS"
echo "  max cycles:     $MAX_CYCLES"
echo

pduo "$CLAUDE_SESSION" "$CODEX_SESSION" \
  --task "$TASK" \
  --watch-interval "$WATCH_INTERVAL" \
  --settle-ms "$SETTLE_MS" \
  --max-cycles "$MAX_CYCLES" \
  --reset-state

echo
echo "done. attach if you want to inspect:"
echo "  p attach $CLAUDE_SESSION"
echo "  p attach $CODEX_SESSION"
