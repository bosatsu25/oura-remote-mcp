/**
 * GitHub as the identity provider. We request *no* scopes: the public profile
 * (`/user`) is enough to compare the immutable numeric id against the allow-list.
 */

import { GITHUB, UPSTREAM_TIMEOUT_MS } from "../config";
import type { Env } from "../env";

export class IdentityError extends Error {
  override readonly name = "IdentityError";
}

export function githubAuthorizeUrl(env: Env, state: string): string {
  const url = new URL(GITHUB.AUTHORIZE_URL);
  url.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  url.searchParams.set("redirect_uri", `${env.PUBLIC_BASE_URL}/callback`);
  url.searchParams.set("state", state);
  url.searchParams.set("scope", ""); // public profile only
  url.searchParams.set("allow_signup", "false");
  return url.toString();
}

export interface GitHubIdentity {
  id: number;
  login: string;
}

/** Exchange the code, fetch the profile, and enforce the allow-list. The GitHub token is discarded. */
export async function verifyGitHubIdentity(env: Env, code: string, fetchFn: typeof fetch = fetch): Promise<GitHubIdentity> {
  const tokenRes = await fetchFn(GITHUB.TOKEN_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": GITHUB.USER_AGENT,
    },
    body: new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${env.PUBLIC_BASE_URL}/callback`,
    }),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!tokenRes.ok) throw new IdentityError("GitHub code exchange failed");
  const tokenJson = (await tokenRes.json()) as { access_token?: string };
  if (typeof tokenJson.access_token !== "string") throw new IdentityError("GitHub did not return a token");

  const userRes = await fetchFn(GITHUB.USER_URL, {
    headers: {
      authorization: `Bearer ${tokenJson.access_token}`,
      accept: "application/vnd.github+json",
      "user-agent": GITHUB.USER_AGENT,
    },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!userRes.ok) throw new IdentityError("GitHub profile lookup failed");
  const user = (await userRes.json()) as { id?: number; login?: string };
  if (typeof user.id !== "number" || typeof user.login !== "string") {
    throw new IdentityError("GitHub profile payload malformed");
  }
  assertAllowed(env, { id: user.id, login: user.login });
  return { id: user.id, login: user.login };
}

/** Both the immutable id and the current login must match. */
export function assertAllowed(env: Pick<Env, "ALLOWED_GITHUB_USER_ID" | "ALLOWED_GITHUB_LOGIN">, who: GitHubIdentity): void {
  const allowedId = Number(env.ALLOWED_GITHUB_USER_ID);
  if (!Number.isInteger(allowedId) || allowedId <= 0) {
    throw new IdentityError("ALLOWED_GITHUB_USER_ID is not configured");
  }
  if (who.id !== allowedId || who.login.toLowerCase() !== env.ALLOWED_GITHUB_LOGIN.toLowerCase()) {
    throw new IdentityError("account not allowed");
  }
}
