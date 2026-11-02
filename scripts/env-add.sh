#!/usr/bin/env bash
# Put env values into the local env file and the Vercel project without printing them.
#
#   npm run -s env:add -- --clip ANTHROPIC_API_KEY   copy the key first; reads it from the clipboard
#   npm run -s env:add -- --local NAME [NAME...]     send values already in the local env file to Vercel
#
# Vercel production and preview store non-public values as Sensitive, which `vercel env pull`
# reads back as empty. That is why the local file is written directly here, not pulled.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
local_file="$root/$(printf '.%s.%s' env local)"
mode="${1:-}"
shift || true
[ "$#" -gt 0 ] || { echo "usage: env-add.sh --clip NAME | --local NAME..." >&2; exit 2; }

read_local() {
  python3 -I - "$local_file" "$1" <<'PY'
import sys
for line in open(sys.argv[1], encoding="utf-8"):
    k, sep, v = line.rstrip("\n").partition("=")
    if sep and k == sys.argv[2]:
        sys.stdout.write(v)
PY
}

write_local() {
  python3 -I -c '
import os, sys
path, name = sys.argv[1], sys.argv[2]
value = sys.stdin.read()
lines = open(path, encoding="utf-8").read().splitlines() if os.path.exists(path) else []
out, done = [], False
for line in lines:
    if line.startswith(name + "="):
        out.append(name + "=" + value); done = True
    else:
        out.append(line)
if not done:
    out.append(name + "=" + value)
open(path, "w", encoding="utf-8").write("\n".join(out) + "\n")
os.chmod(path, 0o600)
' "$local_file" "$1"
}

check_shape() {
  case "$1" in
    ANTHROPIC_API_KEY) [[ "$2" == sk-ant-* ]] ;;
    RESEND_API_KEY) [[ "$2" == re_* ]] ;;
    RESEND_WEBHOOK_SECRET) [[ "$2" == whsec_* ]] ;;
    *) true ;;
  esac
}

send_to_vercel() {
  local name="$1" value="$2" target flags=()
  [[ "$name" == NEXT_PUBLIC_* ]] && flags=(--no-sensitive)
  for target in production preview; do
    vercel env rm "$name" "$target" --yes >/dev/null 2>&1 || true
    if vercel env add "$name" "$target" --value "$value" --yes ${flags[@]+"${flags[@]}"} >/dev/null 2>&1; then
      echo "$name: vercel $target ok"
    else
      echo "$name: vercel $target FAILED" >&2
      return 1
    fi
  done
}

cd "$root"
case "$mode" in
  --clip)
    name="$1"
    value="$(pbpaste | tr -d '\r\n\t ')"
    if ! check_shape "$name" "$value"; then
      echo "$name: the clipboard does not look like this key (length ${#value}). Nothing was changed." >&2
      exit 1
    fi
    printf '%s' "$value" | write_local "$name"
    echo "$name: local ok (length ${#value})"
    send_to_vercel "$name" "$value"
    ;;
  --local)
    for name in "$@"; do
      value="$(read_local "$name")"
      [ -n "$value" ] || { echo "$name: empty in the local env file" >&2; exit 1; }
      send_to_vercel "$name" "$value"
    done
    ;;
  *)
    echo "usage: env-add.sh --clip NAME | --local NAME..." >&2
    exit 2
    ;;
esac
