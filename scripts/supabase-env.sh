#!/usr/bin/env bash
# Pull this project's Supabase URL and API keys into the local env file.
# Key values are written to the file only; nothing secret is printed.
# Usage: npm run env:supabase   (requires `supabase login` and a linked project)
#
# Test hooks (never needed in normal use):
#   SUPABASE_ENV_FAKE_JSON=<file>  read the CLI JSON from a file instead of calling the CLI
#   SUPABASE_ENV_OUT=<file>        write to this path instead of the project's local env file
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
ref="$(cat "$root/supabase/.temp/project-ref" 2>/dev/null || true)"
[ -n "$ref" ] || { echo "no linked Supabase project (run: supabase link --project-ref <ref>)" >&2; exit 1; }
out="${SUPABASE_ENV_OUT:-$root/$(printf '.%s.%s' env local)}"

if [ -n "${SUPABASE_ENV_FAKE_JSON:-}" ]; then
  json="$(cat "$SUPABASE_ENV_FAKE_JSON")"
else
  # The shell that runs this may not have Homebrew on PATH, so resolve the CLI explicitly.
  SUPABASE_BIN="$(command -v supabase 2>/dev/null || true)"
  [ -x "$SUPABASE_BIN" ] || SUPABASE_BIN=/opt/homebrew/bin/supabase
  [ -x "$SUPABASE_BIN" ] || { echo "supabase CLI not found (brew install supabase/tap/supabase)" >&2; exit 1; }
  errlog="$(mktemp)"
  if ! json="$("$SUPABASE_BIN" projects api-keys --project-ref "$ref" -o json 2>"$errlog")"; then
    echo "supabase api-keys failed:" >&2
    grep -v 'new version\|recommend' "$errlog" >&2 || true
    rm -f "$errlog"
    exit 1
  fi
  rm -f "$errlog"
fi

# The JSON goes through a temp file: the heredoc below is python's stdin, so a pipe would be lost.
tmpjson="$(mktemp)"
trap 'rm -f "$tmpjson"' EXIT
printf '%s' "$json" > "$tmpjson"
python3 -I - "$out" "$ref" "$tmpjson" <<'PY'
import json, os, re, sys

raw = open(sys.argv[3], encoding="utf-8").read()
start = raw.find("[")
keys = json.loads(raw[start:]) if start >= 0 else []
if not isinstance(keys, list) or not keys:
    print("no keys parsed from CLI output (first chars: %r)" % raw[:40].replace("\n", " "), file=sys.stderr)
    sys.exit(1)

def key_value(obj, pattern):
    # Field names differ between CLI versions, so scan every string value for a key-shaped string.
    for v in obj.values():
        if isinstance(v, str) and re.fullmatch(pattern, v):
            return v
    return ""

JWT = r"eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+"

def pick(preferred_type, legacy_name, pattern):
    for k in keys:
        if k.get("type") == preferred_type:
            v = key_value(k, pattern)
            if v:
                return v
    for k in keys:
        if k.get("name") == legacy_name:
            v = key_value(k, JWT)
            if v:
                return v
    return ""

anon = pick("publishable", "anon", r"sb_publishable_[A-Za-z0-9_\-]+")
service = pick("secret", "service_role", r"sb_secret_[A-Za-z0-9_\-]+")

out, ref = sys.argv[1], sys.argv[2]
existing = {}
if os.path.exists(out):
    for line in open(out):
        if "=" in line and not line.startswith("#"):
            k, v = line.rstrip("\n").split("=", 1)
            existing[k] = v
existing["NEXT_PUBLIC_SUPABASE_URL"] = f"https://{ref}.supabase.co"
existing["NEXT_PUBLIC_SUPABASE_ANON_KEY"] = anon
existing["SUPABASE_SERVICE_ROLE_KEY"] = service
existing.setdefault("NEXT_PUBLIC_APP_URL", "http://localhost:3015")
for k in ("ANTHROPIC_API_KEY", "RESEND_API_KEY", "RESEND_WEBHOOK_SECRET", "INBOUND_DOMAIN"):
    existing.setdefault(k, "")
with open(out, "w") as fh:
    for k, v in existing.items():
        fh.write(f"{k}={v}\n")
os.chmod(out, 0o600)

print("wrote", os.path.basename(out), "| anon:", "set" if anon else "EMPTY", "| service_role:", "set" if service else "EMPTY")
if not anon or not service:
    fields = sorted({f for k in keys for f in k.keys()})
    print("key objects have fields:", fields, "| (name, type):", [(k.get("name"), k.get("type")) for k in keys], file=sys.stderr)
    sys.exit(1)
PY
