import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { OuraTokenVault } from "./do/token-vault";

/** Bindings and configuration available to the Worker. */
export interface Env {
  // --- vars (wrangler.jsonc) ---
  PUBLIC_BASE_URL: string;
  ALLOWED_GITHUB_USER_ID: string;
  ALLOWED_GITHUB_LOGIN: string;
  KILL_SWITCH?: string;

  // --- secrets (wrangler secret put) ---
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  OURA_CLIENT_ID: string;
  OURA_CLIENT_SECRET: string;
  TOKEN_ENCRYPTION_KEY: string;

  // --- bindings ---
  OAUTH_KV: KVNamespace;
  TOKEN_VAULT: DurableObjectNamespace<OuraTokenVault>;
  RATE_LIMITER: { limit(opts: { key: string }): Promise<{ success: boolean }> };
  /** Injected by workers-oauth-provider in single-worker mode. */
  OAUTH_PROVIDER: OAuthHelpers;
}

/** Identity stored (encrypted by workers-oauth-provider) with each MCP grant. No Oura tokens here. */
export interface GrantProps extends Record<string, unknown> {
  userId: number;
  login: string;
}
