/**
 * Unprotected HTTP routes (served as workers-oauth-provider's `defaultHandler`):
 *
 *   GET  /authorize        MCP client (Claude) starts authorization -> redirect to GitHub
 *   GET  /callback         GitHub returns -> allow-list check -> complete MCP grant or Oura link
 *   GET  /oura/connect     Owner links the Oura account (GitHub login first, then Oura OAuth+PKCE)
 *   GET  /oura/callback    Oura returns -> exchange code -> store encrypted tokens
 *   GET  /oura/disconnect  Owner revokes + deletes stored Oura tokens (GitHub login first)
 *   GET  /healthz          Liveness only; no data
 *
 * Flow state is kept server-side in the Durable Object keyed by a 256-bit
 * random `state`; nothing sensitive is placed in URLs or cookies.
 */

import { AuthorizationError } from "@cloudflare/workers-oauth-provider";
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { MCP_SCOPE_READ, OURA } from "../config";
import { createPkcePair, randomToken } from "../core/crypto";
import { log, safeErrorMessage } from "../core/redact";
import { exchangeOuraCode, revokeOuraToken } from "../core/token-vault-core";
import { vault } from "../do/token-vault";
import type { Env, GrantProps } from "../env";
import { githubAuthorizeUrl, IdentityError, verifyGitHubIdentity } from "./github";

const SECURITY_HEADERS: Record<string, string> = {
  "content-type": "text/plain; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
};

function text(status: number, body: string): Response {
  return new Response(body, { status, headers: SECURITY_HEADERS });
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}

export async function handleDefault(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const route = `${request.method} ${url.pathname}`;

  // `return await` (not bare `return`) so async rejections land in the catch below.
  try {
    switch (route) {
      case "GET /healthz":
        return text(200, "ok");
      case "GET /":
        return text(200, "oura-remote-mcp: private MCP endpoint at /mcp");
      case "GET /authorize":
        return await startMcpAuthorize(request, env);
      case "GET /callback":
        return await githubCallback(request, env);
      case "GET /oura/connect":
        return await startOuraLink(env);
      case "GET /oura/callback":
        return await ouraCallback(request, env);
      case "GET /oura/disconnect":
        return await startOuraDisconnect(env);
      default:
        return text(404, "not found");
    }
  } catch (err) {
    if (err instanceof AuthorizationError) {
      // Expected OAuth validation failure (bad client/redirect/PKCE): render locally, never redirect.
      log.warn({ event: "authorize_rejected", route: url.pathname, reason: safeErrorMessage(err) });
      return text(400, "invalid authorization request");
    }
    if (err instanceof IdentityError) {
      log.warn({ event: "identity_rejected", route: url.pathname, reason: safeErrorMessage(err) });
      return text(403, "forbidden");
    }
    log.error({ event: "handler_error", route: url.pathname, reason: safeErrorMessage(err) });
    return text(500, "internal error");
  }
}

// ---------- MCP authorization (Claude -> this server) ----------

async function startMcpAuthorize(request: Request, env: Env): Promise<Response> {
  // Throws AuthorizationError for unknown client / bad redirect / missing PKCE.
  const authRequest: AuthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  const client = await env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
  // No redirectUri on the error: the handler renders it locally and never redirects.
  if (!client) throw new AuthorizationError("unauthorized_client", { description: "unknown client" });

  const state = randomToken();
  await vault(env).putFlow(state, { kind: "mcp_authorize", authRequest });
  return redirect(githubAuthorizeUrl(env, state));
}

async function githubCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state || !/^[A-Za-z0-9_-]{43}$/.test(state)) return text(400, "bad request");

  // The same /callback serves every GitHub-initiated flow; the stored kind decides what happens next.
  const v = vault(env);
  const flow = await v.takeFlow(state, "any");
  if (!flow) return text(400, "expired or unknown state");

  const who = await verifyGitHubIdentity(env, code); // throws IdentityError unless allow-listed

  if (flow.kind === "oura_unlink") return finishOuraDisconnect(env);

  if (flow.kind === "mcp_authorize") {
    if (!flow.authRequest) return text(400, "expired or unknown state");
    const props: GrantProps = { userId: who.id, login: who.login };
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: flow.authRequest,
      userId: String(who.id),
      metadata: { label: `GitHub:${who.login}` },
      scope: [MCP_SCOPE_READ],
      props,
    });
    log.info({ event: "mcp_grant_issued", user_id: who.id });
    return redirect(redirectTo);
  }

  // oura_link: identity verified; now hand off to Oura with PKCE.
  // A second-stage link flow (already carrying a verifier) must only ever reach /oura/callback.
  if (flow.codeVerifier) return text(400, "bad request");
  const { verifier, challenge } = await createPkcePair();
  const ouraState = randomToken();
  await v.putFlow(ouraState, { kind: "oura_link", codeVerifier: verifier, userId: who.id, login: who.login });

  const authz = new URL(OURA.AUTHORIZE_URL);
  authz.searchParams.set("response_type", "code");
  authz.searchParams.set("client_id", env.OURA_CLIENT_ID);
  authz.searchParams.set("redirect_uri", `${env.PUBLIC_BASE_URL}/oura/callback`);
  authz.searchParams.set("scope", OURA.SCOPES.join(" "));
  authz.searchParams.set("state", ouraState);
  authz.searchParams.set("code_challenge", challenge);
  authz.searchParams.set("code_challenge_method", "S256");
  return redirect(authz.toString());
}

// ---------- Oura linking (owner only) ----------

async function startOuraLink(env: Env): Promise<Response> {
  // Step 1 is always a GitHub login; the Oura redirect happens in githubCallback.
  const state = randomToken();
  await vault(env).putFlow(state, { kind: "oura_link" });
  return redirect(githubAuthorizeUrl(env, state));
}

async function ouraCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state || !/^[A-Za-z0-9_-]{43}$/.test(state)) return text(400, "bad request");

  const v = vault(env);
  const flow = await v.takeFlow(state, "oura_link");
  if (!flow?.codeVerifier || !flow.userId) return text(400, "expired or unknown state");

  const tokens = await exchangeOuraCode(
    fetch,
    { clientId: env.OURA_CLIENT_ID, clientSecret: env.OURA_CLIENT_SECRET },
    { code, redirectUri: `${env.PUBLIC_BASE_URL}/oura/callback`, codeVerifier: flow.codeVerifier },
  );
  await v.storeTokens(tokens);
  log.info({ event: "oura_linked", user_id: flow.userId });
  return text(200, "Oura account linked. You can close this tab.");
}

async function startOuraDisconnect(env: Env): Promise<Response> {
  // Disconnect also requires a fresh GitHub login. A dedicated flow kind means
  // a stray /callback for a link or MCP flow can never be replayed into it.
  const state = randomToken();
  await vault(env).putFlow(state, { kind: "oura_unlink" });
  return redirect(githubAuthorizeUrl(env, state));
}

async function finishOuraDisconnect(env: Env): Promise<Response> {
  const v = vault(env);
  try {
    const token = await v.getAccessToken();
    await revokeOuraToken(fetch, token);
  } catch {
    /* not linked, or refresh impossible: local deletion still proceeds */
  }
  await v.clearTokens();
  log.info({ event: "oura_unlinked" });
  return text(200, "Oura tokens revoked and deleted. Re-link via /oura/connect if needed.");
}
