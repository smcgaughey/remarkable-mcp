#!/bin/bash
# Pre-populate the Worker's folder cache with every folder on the tablet so
# upload_pdf can target paths like "/Inbox" without blowing Cloudflare's
# subrequest budget at request time.
#
# Reads rmapi's local tree cache (refreshed on each run), walks parents to
# compute each folder's full path, and writes `folder:/Path → <uuid>` entries
# into the TOKEN_CACHE KV namespace via wrangler.
#
# Run this after creating or renaming a folder on the tablet.
set -euo pipefail

RMAPI_CACHE="$HOME/Library/Caches/rmapi/tree.cache"

if ! command -v rmapi >/dev/null 2>&1; then
  echo "ERROR: rmapi not found on PATH" >&2
  exit 1
fi

echo "==> Refreshing rmapi tree cache..."
rmapi ls >/dev/null

if [ ! -f "$RMAPI_CACHE" ]; then
  echo "ERROR: $RMAPI_CACHE not found after refresh" >&2
  exit 1
fi

cd "$(dirname "$0")/.."

# Walk folders, compute full paths (Python handles the parent-walking cleanly)
MAPPINGS=$(python3 - "$RMAPI_CACHE" <<'PY'
import json, sys
tree = json.load(open(sys.argv[1]))
folders = {
    d["DocumentID"]: d["Metadata"]
    for d in tree.get("Docs", [])
    if d.get("Metadata", {}).get("type") == "CollectionType"
    and not d["Metadata"].get("deleted", False)
}

def path_of(fid):
    segments = []
    seen = set()
    current = fid
    while current:
        if current in seen:
            return None  # cycle
        seen.add(current)
        meta = folders.get(current)
        if not meta:
            return None
        segments.insert(0, meta["visibleName"])
        current = meta.get("parent", "") or ""
    return "/" + "/".join(segments)

for fid, meta in folders.items():
    p = path_of(fid)
    if p:
        # tab-separated so shell can read it cleanly
        print(f"{p}\t{fid}")
PY
)

if [ -z "$MAPPINGS" ]; then
  echo "No folders found in tree cache. Nothing to do."
  exit 0
fi

COUNT=$(printf '%s\n' "$MAPPINGS" | wc -l | tr -d ' ')
echo "==> Writing $COUNT folder mapping(s) to TOKEN_CACHE KV..."

printf '%s\n' "$MAPPINGS" | while IFS=$'\t' read -r path uuid; do
  [ -z "$path" ] && continue
  key="folder:$path"
  echo "  $key → $uuid"
  npx wrangler kv key put --binding=TOKEN_CACHE --remote "$key" "$uuid" >/dev/null
done

echo ""
echo "==> Done. Folder cache pre-populated. Uploads targeting these paths will resolve instantly."
