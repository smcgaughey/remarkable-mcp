#!/bin/bash
# One-time setup: pull the reMarkable device token from local rmapi config and
# push it plus a freshly minted MCP bearer token to Cloudflare Workers secrets.
#
# Re-running this script rotates the MCP_BEARER_TOKEN. You'll need to update
# the Claude.ai Custom Connector with the new value if that happens.
set -euo pipefail

# rmapi stores its config in the platform's user-config dir:
#   macOS: ~/Library/Application Support/rmapi/rmapi.conf
#   Linux: ~/.config/rmapi/rmapi.conf
CANDIDATES=(
  "$HOME/Library/Application Support/rmapi/rmapi.conf"
  "$HOME/.config/rmapi/rmapi.conf"
)

RMAPI_CONF=""
for c in "${CANDIDATES[@]}"; do
  if [ -f "$c" ]; then
    RMAPI_CONF="$c"
    break
  fi
done

if [ -z "$RMAPI_CONF" ]; then
  echo "ERROR: rmapi.conf not found. Looked in:" >&2
  for c in "${CANDIDATES[@]}"; do echo "  $c" >&2; done
  echo "Pair rmapi first: run 'rmapi' and enter a code from https://my.remarkable.com/device/desktop/connect" >&2
  exit 1
fi

echo "==> Using $RMAPI_CONF"

DEVICE_TOKEN=$(grep '^devicetoken:' "$RMAPI_CONF" | awk '{print $2}')
if [ -z "${DEVICE_TOKEN:-}" ]; then
  echo "ERROR: no 'devicetoken' key found in $RMAPI_CONF" >&2
  exit 1
fi

cd "$(dirname "$0")/.."

echo "==> Uploading REMARKABLE_DEVICE_TOKEN..."
printf '%s' "$DEVICE_TOKEN" | npx wrangler secret put REMARKABLE_DEVICE_TOKEN

MCP_TOKEN=$(uuidgen)
echo "==> Uploading MCP_BEARER_TOKEN..."
printf '%s' "$MCP_TOKEN" | npx wrangler secret put MCP_BEARER_TOKEN

cat <<EOF

========================================================================
Bearer token (paste into Claude.ai Custom Connector):

  $MCP_TOKEN

========================================================================

Next steps:
  1. wrangler kv namespace create TOKEN_CACHE
  2. wrangler kv namespace create RATE_LIMIT
  3. Paste the two ids into wrangler.toml
  4. wrangler deploy
  5. In Claude.ai → Settings → Connectors → Add custom connector:
        URL:  https://remarkable.mcgaughey.dev/mcp
        Auth: Bearer, paste the token above
EOF
