#!/usr/bin/env bash
# PostToolUse(Edit|Write) for Otodoke: lint the file that was just edited.
# Exit 2 feeds the eslint output back to Claude so it fixes the file right away.
set -u
payload="$(cat)"
file="$(printf '%s' "$payload" | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin); print(d.get("tool_input",{}).get("file_path",""))
except Exception:
    print("")' 2>/dev/null)"
case "$file" in
  *.ts|*.tsx|*.js|*.jsx|*.mjs) ;;
  *) exit 0 ;;
esac
[ -f "$file" ] || exit 0
root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
out="$(cd "$root" && npx --no-install eslint --no-warn-ignored "$file" 2>&1)"
status=$?
if [ $status -ne 0 ]; then
  printf 'eslint (%s):\n%s\n' "$file" "$out" >&2
  exit 2
fi
exit 0
