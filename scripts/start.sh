#!/usr/bin/env bash
# Запускает сервер как фоновый процесс, отвязанный от терминала.
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG=/tmp/opencode/qwen-free-api.log
mkdir -p /tmp/opencode
if pgrep -f "node server.js" >/dev/null 2>&1; then
  echo "server already running"
else
  (cd "$DIR" && setsid nohup node server.js >"$LOG" 2>&1 < /dev/null &)
  echo "started, log: $LOG"
fi
