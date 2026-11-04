/**
 * Oura token vault — runtime-agnostic core.
 *
 * Responsibilities
 *  - Persist the Oura token pair encrypted (AES-256-GCM) in an injected KV-like store.
 *  - Serialize refresh so two concurrent callers can never both spend the
 *    single-use refresh token (Oura invalidates it on first use).
 *  - Persist the *new* refresh token before anything else is allowed to proceed.
 *  - Never expose the refresh token outside this module.
 *
 * The Durable Object in src/do/token-vault.ts is a thin adapter around this.
 */

import { OURA, REFRESH_SKEW_MS, UPSTREAM_TIMEOUT_MS } from "../config";
import { open, seal, type SealedBox } from "./crypto";
import type { AsyncLock } from "./lock";

export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface OuraTokenSet {
  accessToken: string;
  refreshToken: string;
  /** epoch ms */
  expiresAt: number;
  scope: string;
  linkedAt: number;
}

export interface OuraClientCredentials {
  clientId: string;
  clientSecret: string;
}

export interface VaultDeps {
  store: KeyValueStore;
  lock: AsyncLock;
  key: CryptoKey;
  fetchFn: typeof fetch;
  now?: () => number;
}

const TOKEN_KEY = "oura:tokens:v1";
const AAD = "oura-remote-mcp:token-vault:v1";

export type VaultErrorCode = "not_linked" | "refresh_failed" | "upstream";

export class VaultError extends Error {
  constructor(
    message: string,
    readonly code: VaultErrorCode,
  ) {
    super(message);
    this.name = "VaultError";
  }
}

interface OuraTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type?: string;
  scope?: string;
}

export class TokenVaultCore {
  private readonly now: () => number;

  constructor(private readonly deps: VaultDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  private async read(): Promise<OuraTokenSet | undefined> {
    const box = await this.deps.store.get<SealedBox>(TOKEN_KEY);
    if (!box) return undefined;
    try {
      return JSON.parse(await open(this.deps.key, box, AAD)) as OuraTokenSet;
    } catch {
      // Wrong key (TOKEN_ENCRYPTION_KEY rotated, see docs/runbook.md) or a tampered blob.
      // Either way the pair is unusable: report "not linked" so the owner is told to re-link,
      // and the next store() overwrites it.
      return undefined;
    }
  }

  private async write(tokens: OuraTokenSet): Promise<void> {
    const box = await seal(this.deps.key, JSON.stringify(tokens), AAD);
    await this.deps.store.put(TOKEN_KEY, box);
  }

  /** Store a freshly exchanged token pair (initial link or re-link). */
  async store(tokens: Omit<OuraTokenSet, "linkedAt">): Promise<void> {
    await this.deps.lock.run(async () => {
      await this.write({ ...tokens, linkedAt: this.now() });
    });
  }

  async clear(): Promise<void> {
    await this.deps.lock.run(() => this.deps.store.delete(TOKEN_KEY));
  }

  /** Non-secret status for diagnostics. */
  async status(): Promise<{ linked: boolean; expiresAt?: number; scope?: string; linkedAt?: number }> {
    const t = await this.read();
    if (!t) return { linked: false };
    return { linked: true, expiresAt: t.expiresAt, scope: t.scope, linkedAt: t.linkedAt };
  }

  /**
   * Return a valid access token, refreshing under the lock if needed.
   * Only the access token leaves the vault.
   */
  async getAccessToken(creds: OuraClientCredentials): Promise<string> {
    const current = await this.read();
    if (!current) throw new VaultError("Oura account is not linked", "not_linked");
    if (current.expiresAt - this.now() > REFRESH_SKEW_MS) return current.accessToken;

    return this.deps.lock.run(async () => {
      // Re-read inside the lock: another caller may have refreshed meanwhile.
      const latest = await this.read();
      if (!latest) throw new VaultError("Oura account is not linked", "not_linked");
      if (latest.expiresAt - this.now() > REFRESH_SKEW_MS) return latest.accessToken;

      const refreshed = await this.refresh(latest.refreshToken, creds);
      const next: OuraTokenSet = {
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token,
        expiresAt: this.now() + refreshed.expires_in * 1000,
        scope: refreshed.scope ?? latest.scope,
        linkedAt: latest.linkedAt,
      };
      // Persist the rotated refresh token BEFORE returning; losing it means re-linking.
      await this.write(next);
      return next.accessToken;
    });
  }

  private async refresh(refreshToken: string, creds: OuraClientCredentials): Promise<OuraTokenResponse> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    });
    const res = await this.deps.fetchFn(OURA.TOKEN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        "user-agent": OURA.USER_AGENT,
      },
      body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!res.ok) {
      // Do not include the body: it may echo parameters.
      throw new VaultError(`Oura token refresh failed (HTTP ${res.status})`, "refresh_failed");
    }
    const json = (await res.json()) as Partial<OuraTokenResponse>;
    if (
      typeof json.access_token !== "string" ||
      typeof json.refresh_token !== "string" ||
      typeof json.expires_in !== "number"
    ) {
      throw new VaultError("Oura token refresh returned an unexpected payload", "refresh_failed");
    }
    return json as OuraTokenResponse;
  }
}

/** Exchange an authorization code (PKCE) for the initial token pair. Pure function; no storage. */
export async function exchangeOuraCode(
  fetchFn: typeof fetch,
  creds: OuraClientCredentials,
  params: { code: string; redirectUri: string; codeVerifier: string },
): Promise<Omit<OuraTokenSet, "linkedAt">> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    code_verifier: params.codeVerifier,
  });
  const res = await fetchFn(OURA.TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      "user-agent": OURA.USER_AGENT,
    },
    body,
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!res.ok) throw new VaultError(`Oura code exchange failed (HTTP ${res.status})`, "upstream");
  const json = (await res.json()) as Partial<OuraTokenResponse>;
  if (
    typeof json.access_token !== "string" ||
    typeof json.refresh_token !== "string" ||
    typeof json.expires_in !== "number"
  ) {
    throw new VaultError("Oura code exchange returned an unexpected payload", "upstream");
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + json.expires_in * 1000,
    scope: json.scope ?? "",
  };
}

/** Best-effort revocation at Oura. Errors are swallowed; local deletion is what matters. */
export async function revokeOuraToken(fetchFn: typeof fetch, accessToken: string): Promise<void> {
  try {
    const url = new URL(OURA.REVOKE_URL);
    url.searchParams.set("access_token", accessToken);
    await fetchFn(url.toString(), {
      method: "POST",
      headers: { "user-agent": OURA.USER_AGENT },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    /* ignore */
  }
}
