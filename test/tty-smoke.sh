#!/bin/bash
# Layer-2 PTY smoke test: after a migration, the interactive `claude --resume`
# picker (a real TUI in a real pseudo-terminal) must list the migrated session.
# Requires CFM_ORACLE_CFG (authenticated test config dir). Costs one haiku call.
set -euo pipefail
[ -n "${CFM_ORACLE_CFG:-}" ] || { echo "Set CFM_ORACLE_CFG"; exit 1; }
export CLAUDE_CONFIG_DIR="$CFM_ORACLE_CFG"
export CLAUDE_FOLDER_MOVE_BACKUP_DIR="${TMPDIR:-/tmp}/cfm-pty-backups"
TOOL="$(cd "$(dirname "$0")/.." && pwd)/claude-folder-move.mjs"
ROOT=$(mktemp -d /private/tmp/cfm-pty-XXXXXX)
trap 'rm -rf "$ROOT"' EXIT
mkdir -p "$ROOT/Origin Parent/pty proj" "$ROOT/Dest Parent"

echo "pty: creating session with marker title..."
( cd "$ROOT/Origin Parent/pty proj" && CLAUDE_CONFIG_DIR="$CFM_ORACLE_CFG" \
  claude -p "PTYMARKER migration smoke test. Reply exactly: OK" --model haiku < /dev/null > /dev/null )

mv "$ROOT/Origin Parent/pty proj" "$ROOT/Dest Parent/pty proj"
node "$TOOL" --apply --origin "$ROOT/Origin Parent" --dest "$ROOT/Dest Parent" \
  --projects "pty proj" --yes > /dev/null
echo "pty: migrated; opening interactive resume picker..."

OUT=$(cd "$ROOT/Dest Parent/pty proj" && CLAUDE_CONFIG_DIR="$CFM_ORACLE_CFG" expect -c '
  set timeout 30
  spawn claude --resume
  # a fresh path may show a trust dialog first; accept it, then find the session
  expect {
    -re {trust|Quick safety} { send "\r"; exp_continue }
    -re {PTYMARKER} { puts "\nPTY-FOUND"; send "\x03"; exit 0 }
    timeout { puts "\nPTY-TIMEOUT"; exit 1 }
    eof { puts "\nPTY-EOF"; exit 1 }
  }
' 2>&1) || { echo "$OUT" | tr -d "\r" | sed "s/\x1b\[[0-9;?]*[a-zA-Z]//g" | tail -6; echo "FAIL: picker did not show migrated session"; exit 1; }
echo "ok: interactive resume picker lists the migrated session"
