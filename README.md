# remarkable-mcp

Write-only MCP server that lets Claude.ai push PDFs to a reMarkable tablet.
Runs on Cloudflare Workers, deployed at `https://remarkable.mcgaughey.dev`.

## What it does

Exposes two MCP tools over Streamable HTTP (JSON-RPC 2.0):

- `upload_pdf(content_base64, filename, folder="/Inbox")`
- `create_folder(path)` *(stub — coming in v0.2)*

No read, no delete, no update. A stolen bearer token only grants the ability
to add PDFs to the owner's reMarkable cloud, bounded by a daily byte cap.

## Architecture

```
Claude.ai ──HTTPS── remarkable.mcgaughey.dev ──HTTPS── reMarkable cloud
                    (Cloudflare Worker)
                    ├── src/index.ts        auth + routing
                    ├── src/mcp.ts          JSON-RPC handler
                    ├── src/remarkable/     cloud client (v4 schema)
                    ├── src/tools/          MCP tool definitions
                    └── src/ratelimit.ts    daily byte cap
```

Pairing with the reMarkable cloud happens **once** on a local machine via
`rmapi`. The resulting long-lived device token lives in Cloudflare secrets;
the Worker mints a fresh short-lived user token and caches it in KV for
~23 hours.

## Setup (one-time)

Prerequisites:

- A Cloudflare account with `mcgaughey.dev` as an active zone
- `wrangler` authenticated: `wrangler login`
- A paired `rmapi` on the same machine (see the project root's setup notes)

Deploy:

```bash
npm install
wrangler kv namespace create TOKEN_CACHE   # paste id into wrangler.toml
wrangler kv namespace create RATE_LIMIT    # paste id into wrangler.toml
./scripts/bootstrap.sh                     # device token + MCP bearer → secrets
wrangler deploy
```

After `wrangler deploy`, add the custom domain route either in the Cloudflare
dashboard or by uncommenting the `[[routes]]` block in `wrangler.toml` and
redeploying.

Then in Claude.ai → Settings → Connectors → Add custom connector:

- URL: `https://remarkable.mcgaughey.dev/mcp`
- Auth: Bearer, paste the token `bootstrap.sh` printed

## Replicating on another machine

The Worker itself is already deployed once. To edit or redeploy from a
different machine: clone the repo, `wrangler login`, make changes,
`wrangler deploy`. Secrets stay in Cloudflare — no local state needed.

To stand up a **second, independent** instance (e.g. a different user):
run `bootstrap.sh` against that user's paired `rmapi`, use a separate
Worker name, and register its URL with their Claude.ai.

## License

MIT
