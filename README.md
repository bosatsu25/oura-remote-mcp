# oura-remote-mcp

**Personal, single-user, read-only remote MCP server** that lets Claude (claude.ai, mobile, desktop,
Claude Code) read sleep, readiness and heart-rate data from an Oura Ring via the official Oura API v2.

> Not affiliated with or endorsed by Oura. Not a medical device. Private project.

## Architecture

```
Claude ──OAuth 2.1 (DCR + PKCE)──▶ this Worker ──OAuth 2.0 + PKCE──▶ Oura API v2
                                      │
                      GitHub login = identity gate (one allow-listed account)
                                      │
                       Durable Object "OuraTokenVault"
                       (AES-256-GCM encrypted tokens, serialized refresh)
```

- **Runtime:** Cloudflare Workers, TypeScript, `agents/mcp/server` (`createMcpHandler`, Streamable HTTP),
  MCP SDK v2 (`@modelcontextprotocol/server`), `@cloudflare/workers-oauth-provider`.
- **Two OAuth layers:** Claude → server (so only you can connect) and server → Oura (so the server can read your data).
- **No health data at rest.** Only the Oura token pair is stored, encrypted. See [SECURITY.md](SECURITY.md).

## Tools (all read-only)

| Tool | Scope at Oura | Returns |
|---|---|---|
| `oura_status` | – | linked?, token expiry, scope |
| `get_sleep` | `daily` | per-night bedtime start/end, total sleep, efficiency, latency, stages, avg HRV, lowest/avg HR |
| `get_sleep_scores` | `daily` | daily sleep score + contributors |
| `get_readiness` | `daily` | daily readiness score + contributors (resting HR, HRV balance, temperature …) |
| `get_heart_rate` | `heartrate` | hourly min/avg/max bpm (max 3 days) |

Quirks handled for you: Oura's `/sleep` treats `end_date` as exclusive (we widen by one day and
re-filter), and returns several periods per day (`long_sleep`, `late_nap`, `rest`); the main night is
returned unless `include_all_periods: true`.

## Setup

### 0. Prerequisites
Node ≥ 22, a Cloudflare account, a GitHub account, an Oura account with membership.

### 1. Clone and install
```bash
npm ci
```

### 2. Decide the public URL
`https://oura-remote-mcp.<your-subdomain>.workers.dev` (or a custom domain). Put it in `wrangler.jsonc → vars.PUBLIC_BASE_URL`.

### 3. GitHub OAuth App (identity gate)
GitHub → Settings → Developer settings → OAuth Apps → New.
- Homepage: `<base>` Callback: `<base>/callback`
- Note the client id and generate a client secret.
- Find your numeric user id: `curl https://api.github.com/users/<login> | jq .id` → `wrangler.jsonc → vars.ALLOWED_GITHUB_USER_ID`.

### 4. Oura application
https://developer.ouraring.com/applications → New application.
- Redirect URI: `<base>/oura/callback`
- Scopes used: `daily`, `heartrate` (least privilege; nothing else is requested).

### 5. Cloudflare resources and secrets
```bash
wrangler kv namespace create OAUTH_KV      # paste the id into wrangler.jsonc
npm run keygen                             # prints a 32-byte base64 key
wrangler secret put TOKEN_ENCRYPTION_KEY
wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET
wrangler secret put OURA_CLIENT_ID
wrangler secret put OURA_CLIENT_SECRET
```

### 6. Deploy and link Oura
```bash
npm run typecheck && npm test
npm run deploy
```
Open `<base>/oura/connect` → GitHub login → Oura consent. Done once.

### 7. Connect Claude
claude.ai → Settings → Connectors → *Add custom connector* → URL `<base>/mcp`. Leave client id/secret
empty (Claude registers itself). Approve the GitHub login. On mobile the connector appears automatically.

## Operations
- Kill switch, rotation, incident steps: [docs/runbook.md](docs/runbook.md)
- Threat model and controls: [SECURITY.md](SECURITY.md)
- Local dev: copy `.dev.vars.example` → `.dev.vars`, then `npm run dev` (use `mcp-remote` or Claude Code to test).

## Tests
- `npm run test:unit` — dependency-free core (crypto, vault concurrency, validation, redaction, shaping). Runs on plain Node.
- `npm run test:workers` — perimeter tests on the Workers runtime (401, metadata, kill switch, open-redirect, DO single-use state).

## License
Private. All rights reserved.

## Dependency notes
- `agents` requires `@modelcontextprotocol/client` as a **non-optional** peer even for server-only use; it is pinned to the exact version `agents` expects, together with `@modelcontextprotocol/server`.
- Workers tests use `@cloudflare/vitest-plugin` (the renamed, maintained successor of `@cloudflare/vitest-pool-workers`). It pins its own `wrangler`/`miniflare`; keep root `wrangler` on the same version so only one copy is installed, and let Dependabot's `cloudflare` group (which also covers `vitest`) bump them together.
- `package-lock.json` is committed; install with `npm ci`. Resolving the tree from scratch with npm 10 (Node 22) can crash with `Cannot read properties of null (reading 'edgesOut')` (an npm arborist bug); regenerate the lockfile with npm 11 if needed.
