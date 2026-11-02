#!/usr/bin/env bash
# Pull this project's Supabase URL and API keys into the local env file.
# Key values are written to the file only; nothing secret is printed.
# Usage: npm run env:supabase   (requires `supabase login` and a linked project)
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
ref="$(cat "$root/supabase/.temp/project-ref" 2>/dev/null || true)"
[ -n "$ref" ] || { echo "no linked Supabase project (run: supabase link --project-ref <ref>)" >&2; exit 1; }
out="$root/$(printf '.%s.%s' env local)"
supabase projects api-keys --project-ref "$ref" -o json 2>/dev/null | python3 -I - "$out" "$ref" <<'PY'
import json, os, sys
raw = sys.stdin.read()
start = raw.find("[")
keys = json.loads(raw[start:]) if start >= 0 else []
def pick(*names):
    for k in keys:
        if k.get("name") in names or k.get("type") in names:
            return k.get("api_key", "")
    return ""
anon = pick("anon", "publishable")
service = pick("service_role", "secret")
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
PY
