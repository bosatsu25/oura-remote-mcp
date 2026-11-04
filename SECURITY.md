# Security design

Personal, single-user, read-only bridge between Claude and the Oura API. **Not affiliated with Oura.**
This document is the threat model and the list of controls that implement it. Every control has a
test or a config line referenced next to it.

## 1. What is protected

| Asset | Where it lives | Impact if lost |
|---|---|---|
| Oura refresh token | Durable Object `OuraTokenVault`, AES-256-GCM encrypted | Attacker can read all Oura data until revoked |
| Oura access token | Same vault; handed to the Worker per request only | ~30-day read access until revoked |
| MCP access/refresh tokens | `OAUTH_KV` (stored as hashes by workers-oauth-provider) | Attacker can call the read-only tools |
| GitHub/Oura/Cloudflare client secrets | Worker secrets (`wrangler secret put`) | Impersonation of this app at the IdP |
| Health data | **Never stored.** Passes through the Worker in memory only | — |

The design goal: the only thing worth stealing from this service is a token that can be revoked in
under a minute (see `docs/runbook.md`).

## 2. Threat model and controls

### T1. Anyone on the internet calls `/mcp`
- Bearer token required; validated by workers-oauth-provider with RFC 8707 audience check
  (`resourceMetadata.resource = <base>/mcp`). — `src/index.ts`, test `perimeter › 401`
- Tools re-verify the grant identity against the allow-list on every call (defense in depth), so a grant
  issued before the allow-list changed stops working. — `src/mcp/server.ts requireOwner`, tests `refuses a grant whose identity is no longer allow-listed`, `refuses grants with a different id, a different login, or no identity at all`
- Per-IP rate limit (60 / 60 s, shared across) `/mcp`, `/oauth/*`, `/authorize`, `/callback`, `/oura/*`; `/healthz` is exempt. — `wrangler.jsonc ratelimits`, test `limits each client IP to 60 requests per minute`

### T2. Someone else tries to authorize their own Claude against this server
- `/authorize` redirects to GitHub; completion requires the GitHub **numeric id** *and* login to match
  `ALLOWED_GITHUB_USER_ID` / `ALLOWED_GITHUB_LOGIN`. Numeric id defeats login recycling. — `src/auth/github.ts`, test `GitHub allow-list`
- Allow-list fails closed when unconfigured. — test `fails closed`
- DCR (`/oauth/register`) stays open because Claude registers itself, but a registered client gains
  nothing without a grant, and registration is rate-limited.

### T3. Open redirect / CSRF / state replay in the OAuth legs
- Every flow is keyed by a 256-bit random `state` stored **server-side** in the Durable Object with a
  10-minute TTL and **single use**; nothing sensitive travels in URLs or cookies. Expired states are
  garbage-collected by the DO alarm. — `src/do/token-vault.ts putFlow/takeFlow/alarm`, tests `flow state is single-use`, `rejects a state older than FLOW_TTL_MS`, `garbage-collects expired states`
- Flow *kind* is bound to the state so a `/callback` for one flow cannot complete another. — `takeFlow(kind)`
- PKCE S256 on the Oura leg; PKCE enforced on the MCP leg by the provider. — `src/auth/handlers.ts`
- `AuthorizationError` is rendered locally (400), never redirected. — test `no open redirect`

### T4. Single-use Oura refresh token gets spent twice (lockout)
- All refreshes run under `blockConcurrencyWhile` inside one DO instance; the rotated refresh token is
  persisted before the access token is returned. — `src/core/token-vault-core.ts`, test `refreshes once under concurrency`
- A failed refresh leaves the previous pair intact for retry. — test `surfaces refresh failures`

### T5. Durable Object storage or KV is exfiltrated
- Token pair is encrypted with AES-256-GCM, fresh 96-bit IV, AAD bound to a version label; key is a
  Worker secret never written to storage. — `src/core/crypto.ts`, test `crypto`
- Stored blob contains no plaintext token, checked both on the core and on the real Durable Object storage. — tests `stores tokens encrypted at rest`, `stores no plaintext token in Durable Object storage`

### T6. SSRF / request smuggling to a different upstream
- Oura and GitHub URLs are compile-time constants; only the resource name and allow-listed query
  parameters are variable. `next_token` and dates are validated against strict patterns. — `src/config.ts`, `src/core/validate.ts`, test `only ever calls the fixed Oura base URL`
- `allowedHostnames` on the MCP handler pins the Host header (DNS rebinding); a missing Host is refused,
  and a browser Origin from another site gets 403 `Invalid Origin` even with a valid token. Note that
  workers-oauth-provider reflects the request Origin in CORS headers on API responses; the MCP handler's
  Origin check is the control, so nothing is served cross-site. Localhost-class Origins stay allowed for
  MCP Inspector. — `src/index.ts`, test `serves a valid token only on the configured host`

### T7. Secrets or health data leak via logs
- Logging goes through an allow-list of keys; strings are regex-redacted and truncated. No payloads
  or request bodies are ever passed to the logger. — `src/core/redact.ts`, test `redact`
- End to end, a full connect → link → tool calls → refresh → upstream 401 → forged bearer → disconnect run
  logs no token, refresh token, client secret, encryption key or authorization code. — test `logs nothing secret`
- Upstream error bodies are never included in thrown errors. — tests `never leaks the body`

### T8. Dependency / supply-chain compromise
- Minimal dependency set; `npm ci --ignore-scripts` in CI; lockfile committed.
- Dependabot weekly for npm and GitHub Actions; CodeQL; gitleaks; `npm audit --audit-level=high`.
- **Action:** pin third-party actions to commit SHAs once the repo exists (Dependabot will then bump the SHAs).
- Enable on GitHub: secret scanning + push protection, branch protection on `main` (require CI), signed commits.

### T9. Account takeover (GitHub / Cloudflare / Oura)
- This is the most likely real-world path. Use passkeys or hardware 2FA on all three accounts.
- The Cloudflare API token used by `deploy.yml` is scoped to Workers Scripts + KV for this account only.

### T10. Loss of the kill switch
- `KILL_SWITCH=1` short-circuits every request before any handler runs. — `src/index.ts`, test `honours the kill switch`

## 3. Accepted risks (read before deploying)

1. **Data reaches Claude.** Whatever the tools return becomes part of a Claude conversation. The server
   cannot protect data after it has been returned. Mitigation: tools return shaped summaries, not raw
   payloads, and ranges are capped (31 days; 3 days for heart rate).
2. **MCP access token = read access.** Token lifetime is the provider default (short) with refresh;
   compromise window is bounded by `revokeGrant` / kill switch.
3. **No consent screen.** Because exactly one GitHub account can complete authorization, the GitHub
   login *is* the consent step. If this ever becomes multi-user, add an explicit consent page with CSRF
   protection before `completeAuthorization`.
4. **Oura revocation is best-effort.** If `/oauth/revoke` fails, the local copy is still deleted; revoke
   the app from the Oura account page as well (runbook).

## 4. Reporting

This is a private, personal repository. If you found it anyway and see a problem, open a private
security advisory on GitHub rather than a public issue.
