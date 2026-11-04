/**
 * Fixed, non-configurable constants.
 *
 * Upstream URLs are hard-coded on purpose: nothing from a request or from
 * configuration may change where this Worker sends tokens (SSRF guard).
 */

export const OURA = {
  AUTHORIZE_URL: "https://cloud.ouraring.com/oauth/authorize",
  TOKEN_URL: "https://api.ouraring.com/oauth/token",
  REVOKE_URL: "https://api.ouraring.com/oauth/revoke",
  API_BASE: "https://api.ouraring.com/v2/usercollection",
  /** Least privilege: `daily` covers sleep/readiness summaries and sleep periods, `heartrate` the HR series. */
  SCOPES: ["daily", "heartrate"] as const,
  /** Oura returns 403 on requests without a User-Agent. */
  USER_AGENT: "oura-remote-mcp/0.1 (+personal; read-only)",
} as const;

export const GITHUB = {
  AUTHORIZE_URL: "https://github.com/login/oauth/authorize",
  TOKEN_URL: "https://github.com/login/oauth/access_token",
  USER_URL: "https://api.github.com/user",
  USER_AGENT: "oura-remote-mcp/0.1",
} as const;

/** Scope presented to MCP clients. Read-only by construction; there is no write scope. */
export const MCP_SCOPE_READ = "oura:read";

/** Pending OAuth flows (state + PKCE verifier) expire after this many ms. */
export const FLOW_TTL_MS = 10 * 60 * 1000;

/** Refresh the Oura access token when fewer than this many ms remain. */
export const REFRESH_SKEW_MS = 5 * 60 * 1000;

/** Maximum date range (days) a single tool call may request. */
export const MAX_RANGE_DAYS = 31;
export const MAX_HEARTRATE_RANGE_DAYS = 3;

/** Upper bound on Oura pages fetched per tool call (defensive against runaway pagination). */
export const MAX_PAGES = 10;

/** Upstream fetch timeout. */
export const UPSTREAM_TIMEOUT_MS = 10_000;
