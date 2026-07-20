import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createOAuthState, createPkcePair } from "./pkce.js";

const BASE64URL = /^[A-Za-z0-9_-]+$/u;

function challengeFromVerifier(verifier: string): string {
  return createHash("sha256")
    .update(verifier)
    .digest("base64")
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");
}

describe("createPkcePair", () => {
  it("returns a base64url verifier and matching S256 challenge without padding", () => {
    const pair = createPkcePair();
    expect(pair.verifier).toMatch(BASE64URL);
    expect(pair.challenge).toMatch(BASE64URL);
    expect(pair.verifier).not.toMatch(/[=+/]/u);
    expect(pair.challenge).not.toMatch(/[=+/]/u);
    expect(pair.challenge).toBe(challengeFromVerifier(pair.verifier));
    // 32 random bytes → 43 base64url chars
    expect(pair.verifier.length).toBe(43);
  });

  it("produces unique values across calls", () => {
    const a = createPkcePair();
    const b = createPkcePair();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });
});

describe("createOAuthState", () => {
  it("returns 32 hex characters and unique values", () => {
    const a = createOAuthState();
    const b = createOAuthState();
    expect(a).toMatch(/^[0-9a-f]{32}$/u);
    expect(b).toMatch(/^[0-9a-f]{32}$/u);
    expect(a).not.toBe(b);
  });
});
