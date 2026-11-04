/**
 * WebCrypto helpers. Works in Cloudflare Workers and Node >= 20 (globalThis.crypto).
 *
 * Token encryption: AES-256-GCM, random 96-bit IV per encryption, AAD bound to a
 * version label so ciphertext cannot be replayed into a different slot/version.
 */

const subtle = globalThis.crypto.subtle;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type Bytes = Uint8Array<ArrayBuffer>;

export function randomBytes(length: number): Bytes {
  const out = new Uint8Array(new ArrayBuffer(length));
  globalThis.crypto.getRandomValues(out);
  return out;
}

export function toBase64Url(bytes: Bytes): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Bytes {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function fromBase64(text: string): Bytes {
  const bin = atob(text.trim());
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 256-bit random token, base64url (43 chars). Used for OAuth `state` and flow ids. */
export function randomToken(): string {
  return toBase64Url(randomBytes(32));
}

/** PKCE: verifier (43–128 chars, base64url) and S256 challenge. */
export async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = toBase64Url(randomBytes(48)); // 64 chars
  const digest = await subtle.digest("SHA-256", encoder.encode(verifier));
  return { verifier, challenge: toBase64Url(new Uint8Array(digest)) };
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await subtle.digest("SHA-256", encoder.encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time comparison for short secrets (state, nonces). */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

export interface SealedBox {
  v: 1;
  iv: string; // base64url, 12 bytes
  ct: string; // base64url, ciphertext || tag
}

export async function importAesKey(base64Key: string): Promise<CryptoKey> {
  const raw = fromBase64(base64Key);
  if (raw.length !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }
  return subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function seal(key: CryptoKey, plaintext: string, aad: string): Promise<SealedBox> {
  const iv = randomBytes(12);
  const ct = await subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(aad), tagLength: 128 },
    key,
    encoder.encode(plaintext),
  );
  return { v: 1, iv: toBase64Url(iv), ct: toBase64Url(new Uint8Array(ct)) };
}

export async function open(key: CryptoKey, box: SealedBox, aad: string): Promise<string> {
  if (box.v !== 1) throw new Error("unsupported sealed box version");
  const pt = await subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(box.iv), additionalData: encoder.encode(aad), tagLength: 128 },
    key,
    fromBase64Url(box.ct),
  );
  return decoder.decode(pt);
}
