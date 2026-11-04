/**
 * Durable Object adapter for the token vault and for short-lived OAuth flow state.
 *
 * One instance ("primary") exists. The DO guarantees a single thread of
 * execution per instance; `blockConcurrencyWhile` additionally prevents any
 * other event from interleaving while a refresh is in flight.
 */

import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { DurableObject } from "cloudflare:workers";
import { FLOW_TTL_MS } from "../config";
import { importAesKey } from "../core/crypto";
import type { AsyncLock } from "../core/lock";
import { TokenVaultCore, VaultError, type KeyValueStore, type OuraTokenSet, type VaultErrorCode } from "../core/token-vault-core";
import type { Env } from "../env";

export type FlowKind = "mcp_authorize" | "oura_link" | "oura_unlink";

export interface PendingFlow {
  kind: FlowKind;
  createdAt: number;
  /** AuthRequest from workers-oauth-provider (mcp_authorize only). Plain data, so it survives RPC. */
  authRequest?: AuthRequest;
  /** PKCE verifier for the Oura leg (oura_link only). */
  codeVerifier?: string;
  /** GitHub identity verified at the start of the flow. */
  userId?: number;
  login?: string;
}

/**
 * Result of {@link OuraTokenVault.getAccessToken}. Workers RPC does not preserve custom error
 * classes or their properties (a thrown VaultError arrives as a plain Error without `code`),
 * so the vault reports its expected failures as data. Use {@link ouraAccessToken} from Worker code.
 */
export type AccessTokenResult = { ok: true; token: string } | { ok: false; code: VaultErrorCode };

export class OuraTokenVault extends DurableObject<Env> {
  private corePromise: Promise<TokenVaultCore> | undefined;

  private core(): Promise<TokenVaultCore> {
    if (!this.corePromise) {
      const store: KeyValueStore = {
        get: (k) => this.ctx.storage.get(k),
        put: (k, v) => this.ctx.storage.put(k, v),
        delete: async (k) => {
          await this.ctx.storage.delete(k);
        },
      };
      const lock: AsyncLock = {
        run: (fn) => this.ctx.blockConcurrencyWhile(fn),
      };
      this.corePromise = importAesKey(this.env.TOKEN_ENCRYPTION_KEY).then(
        (key) => new TokenVaultCore({ store, lock, key, fetchFn: fetch }),
      );
    }
    return this.corePromise;
  }

  // ---- Oura tokens ----

  async getAccessToken(): Promise<AccessTokenResult> {
    try {
      const token = await (await this.core()).getAccessToken({
        clientId: this.env.OURA_CLIENT_ID,
        clientSecret: this.env.OURA_CLIENT_SECRET,
      });
      return { ok: true, token };
    } catch (err) {
      if (err instanceof VaultError) return { ok: false, code: err.code };
      throw err;
    }
  }

  async storeTokens(tokens: Omit<OuraTokenSet, "linkedAt">): Promise<void> {
    await (await this.core()).store(tokens);
  }

  async clearTokens(): Promise<void> {
    await (await this.core()).clear();
  }

  async status(): Promise<{ linked: boolean; expiresAt?: number; scope?: string; linkedAt?: number }> {
    return (await this.core()).status();
  }

  // ---- Pending OAuth flows (state -> data), 10 minute TTL, single use ----

  async putFlow(state: string, flow: Omit<PendingFlow, "createdAt">): Promise<void> {
    await this.ctx.storage.put(`flow:${state}`, { ...flow, createdAt: Date.now() } satisfies PendingFlow);
    await this.ctx.storage.setAlarm(Date.now() + FLOW_TTL_MS);
  }

  /** Atomically fetch-and-delete (single use); returns undefined if missing, expired, or wrong kind. */
  async takeFlow(state: string, kind: FlowKind | "any"): Promise<PendingFlow | undefined> {
    const key = `flow:${state}`;
    const flow = await this.ctx.storage.get<PendingFlow>(key);
    if (!flow) return undefined;
    await this.ctx.storage.delete(key);
    if (kind !== "any" && flow.kind !== kind) return undefined;
    if (Date.now() - flow.createdAt > FLOW_TTL_MS) return undefined;
    return flow;
  }

  /** Garbage-collect expired flows. */
  override async alarm(): Promise<void> {
    const entries = await this.ctx.storage.list<PendingFlow>({ prefix: "flow:" });
    const now = Date.now();
    const expired: string[] = [];
    for (const [k, v] of entries) if (now - v.createdAt > FLOW_TTL_MS) expired.push(k);
    if (expired.length) await this.ctx.storage.delete(expired);
  }
}

/** Worker-side: a valid Oura access token, or a local VaultError carrying the vault's failure code. */
export async function ouraAccessToken(env: Env): Promise<string> {
  const result = await vault(env).getAccessToken();
  if (result.ok) return result.token;
  throw new VaultError(`Oura token unavailable (${result.code})`, result.code);
}

/** Accessor for the single vault instance. */
export function vault(env: Env): DurableObjectStub<OuraTokenVault> {
  return env.TOKEN_VAULT.get(env.TOKEN_VAULT.idFromName("primary"));
}
