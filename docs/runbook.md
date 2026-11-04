# Runbook

## A. Incident: suspected token or account compromise

Do these in order. Total time: under 5 minutes.

1. **Stop everything**
   ```bash
   wrangler deploy --var KILL_SWITCH:1
   ```
   Every request now returns 503 before any handler runs. Verify: `curl -i https://<base>/healthz` → 503.

2. **Revoke at the identity providers**
   - Oura: https://cloud.ouraring.com → *Applications* → revoke `oura-remote-mcp`.
   - GitHub: *Settings → Applications → Authorized OAuth Apps* → revoke; then *Developer settings → OAuth Apps* → **Reset client secret**.
   - Cloudflare: *My Profile → API Tokens* → roll the deploy token.

3. **Rotate every secret**
   ```bash
   npm run keygen                                  # new TOKEN_ENCRYPTION_KEY
   wrangler secret put TOKEN_ENCRYPTION_KEY
   wrangler secret put GITHUB_CLIENT_SECRET
   wrangler secret put OURA_CLIENT_SECRET
   ```
   Rotating `TOKEN_ENCRYPTION_KEY` makes the stored Oura token pair undecryptable, which is intended.

4. **Wipe grants and stored tokens**
   ```bash
   # MCP grants / clients / tokens
   wrangler kv key list --binding OAUTH_KV | jq -r '.[].name' | xargs -I{} wrangler kv key delete --binding OAUTH_KV "{}"
   ```
   The Oura vault is wiped by the key rotation above; to be explicit, open `https://<base>/oura/disconnect`
   after re-enabling (it requires a GitHub login).

5. **Re-enable and re-link**
   ```bash
   wrangler deploy --var KILL_SWITCH:0
   ```
   Open `https://<base>/oura/connect`, log in with GitHub, approve at Oura.
   In Claude: *Settings → Connectors* → remove and re-add the connector.

6. **Review**: check Cloudflare Workers logs for `rate_limited`, `identity_rejected`, `authorize_rejected`
   events around the incident time. Logs contain no tokens or health data by construction.

## B. Routine: rotate secrets (every 90 days)

Steps 2–3 and 5 above, without the kill switch.

## C. Routine: Oura token refresh failing (`tool_error` with `refresh_failed`)

Usually the refresh token was revoked at Oura or expired after a long outage.
`https://<base>/oura/disconnect` then `https://<base>/oura/connect`.

## D. Routine: Claude cannot connect

1. `curl https://<base>/.well-known/oauth-protected-resource/mcp` must return JSON with `resource = <base>/mcp`.
2. `PUBLIC_BASE_URL` in `wrangler.jsonc` must exactly match the deployed hostname (no trailing slash).
3. GitHub OAuth App callback must be `<base>/callback`; Oura redirect URI must be `<base>/oura/callback`.
4. Claude's callback is `https://claude.ai/api/mcp/auth_callback`; it registers via DCR, so leave
   client id/secret empty in the connector settings.

## E. Decommission

1. `KILL_SWITCH=1`, revoke at Oura and GitHub, roll the Cloudflare token.
2. `wrangler delete` (removes the Worker and its Durable Object storage).
3. `wrangler kv namespace delete --binding OAUTH_KV`.
4. Delete the GitHub OAuth App and the Oura application.
