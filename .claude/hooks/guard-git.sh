#!/usr/bin/env bash
# PreToolUse(Bash) guard for Otodoke.
# Blocks: force push, committing real emails (fixtures/raw/), committing secrets (gitleaks).
# Exit 2 = block; the stderr text is shown to Claude. Exit 0 = allow.
set -u
payload="$(cat)"
cmd="$(printf '%s' "$payload" | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin); print(d.get("tool_input",{}).get("command",""))
except Exception:
    print("")' 2>/dev/null)"
[ -z "$cmd" ] && exit 0
deny() { printf 'otodoke guard: %s\n' "$1" >&2; exit 2; }

if printf '%s' "$cmd" | grep -Eq 'git[[:space:]]+push[^;&|]*([[:space:]]--force([[:space:]]|$)|[[:space:]]-f([[:space:]]|$)|--force-with-lease)'; then
  deny "force push is not allowed on this repo"
fi
if printf '%s' "$cmd" | grep -Eq '(^|[;&|[:space:]])git[[:space:]]+(add|commit)([[:space:]]|$)'; then
  if printf '%s' "$cmd" | grep -q 'fixtures/raw'; then
    deny "fixtures/raw/ holds real emails and must never be committed (anonymize into fixtures/anonymized/ first)"
  fi
  if printf '%s' "$cmd" | grep -Eq 'git[[:space:]]+commit' && command -v gitleaks >/dev/null 2>&1; then
    repo="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
    if ! (cd "$repo" && gitleaks protect --staged --redact --no-banner >/dev/null 2>&1); then
      deny "gitleaks found a possible secret in staged changes; run 'gitleaks protect --staged --redact' to see it"
    fi
  fi
fi
exit 0
