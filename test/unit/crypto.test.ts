import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPkcePair, importAesKey, open, randomToken, seal, timingSafeEqual, toBase64Url, fromBase64Url } from "../../src/core/crypto";

const KEY = Buffer.alloc(32, 7).toString("base64");

describe("crypto", () => {
  it("round-trips AES-GCM with AAD", async () => {
    const key = await importAesKey(KEY);
    const box = await seal(key, '{"refreshToken":"abc"}', "aad-v1");
    assert.equal(box.v, 1);
    assert.equal(fromBase64Url(box.iv).length, 12);
    assert.equal(await open(key, box, "aad-v1"), '{"refreshToken":"abc"}');
  });

  it("uses a fresh IV per encryption", async () => {
    const key = await importAesKey(KEY);
    const a = await seal(key, "same", "aad");
    const b = await seal(key, "same", "aad");
    assert.notEqual(a.iv, b.iv);
    assert.notEqual(a.ct, b.ct);
  });

  it("rejects tampered ciphertext and wrong AAD", async () => {
    const key = await importAesKey(KEY);
    const box = await seal(key, "secret", "aad-v1");
    const tampered = { ...box, ct: box.ct.slice(0, -2) + (box.ct.endsWith("AA") ? "BB" : "AA") };
    await assert.rejects(open(key, tampered, "aad-v1"));
    await assert.rejects(open(key, box, "aad-v2"));
  });

  it("rejects keys that are not 32 bytes", async () => {
    await assert.rejects(importAesKey(Buffer.alloc(16, 1).toString("base64")), /32 bytes/);
  });

  it("produces 43-char base64url state tokens", () => {
    const t = randomToken();
    assert.match(t, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(t, randomToken());
  });

  it("creates PKCE S256 pairs within RFC 7636 bounds", async () => {
    const { verifier, challenge } = await createPkcePair();
    assert.ok(verifier.length >= 43 && verifier.length <= 128);
    assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
  });

  it("base64url round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    assert.deepEqual(Array.from(fromBase64Url(toBase64Url(bytes))), Array.from(bytes));
  });

  it("timingSafeEqual compares correctly", () => {
    assert.equal(timingSafeEqual("abc", "abc"), true);
    assert.equal(timingSafeEqual("abc", "abd"), false);
    assert.equal(timingSafeEqual("abc", "abcd"), false);
  });
});
