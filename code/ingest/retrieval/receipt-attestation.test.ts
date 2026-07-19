import { describe, expect, it } from "vitest";

import type {
  SearchReceipt,
  SearchFilters,
} from "../../domain/ingest/search-receipt.js";
import type {
  Sha256,
  SnapshotId,
  SourceUnitId,
} from "../../domain/ingest/types.js";

import {
  attestSearchReceipt,
  verifyAttestedSearchReceipt,
  isAttestedSearchReceipt,
  RECEIPT_ATTESTATION_LIMITS,
  type AttestedSearchReceipt,
  type SearchReceiptAttestationAuthority,
} from "./receipt-attestation.js";
import { createFakeReceiptAttestationAuthority } from "./testing.js";

const SNAPSHOT = "snp-01ARZ3NDEKTSV4RRFFQ69G5FAV" as SnapshotId;
const UNIT = "su-01ARZ3NDEKTSV4RRFFQ69G5FAV" as SourceUnitId;
const CORPUS = "a".repeat(64) as Sha256;

const FILTERS: SearchFilters = Object.freeze({}) as SearchFilters;

function receipt(overrides: Partial<SearchReceipt> = {}): SearchReceipt {
  return Object.freeze({
    schemaVersion: 1 as const,
    id: "srp-01ARZ3NDEKTSV4RRFFQ69G5FAV",
    snapshotId: SNAPSHOT,
    indexVersion: "lexical-v1",
    indexedRepresentationsSha256: CORPUS,
    query: "retention policy",
    filters: FILTERS,
    candidateIds: [UNIT],
    selectedIds: [UNIT],
    failures: [],
    ...overrides,
  }) as SearchReceipt;
}

// ---------------------------------------------------------------------------
// authenticity surface
// ---------------------------------------------------------------------------
describe("authenticity surface", () => {
  it("attests a receipt produced by a real invocation", async () => {
    const authority = createFakeReceiptAttestationAuthority();
    const result = await attestSearchReceipt(authority, receipt());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isAttestedSearchReceipt(result.value)).toBe(true);
    const verified = await verifyAttestedSearchReceipt(authority, result.value);
    expect(verified.ok).toBe(true);
  });

  it("REJECTS a hand-written receipt that was never attested", async () => {
    const authority = createFakeReceiptAttestationAuthority();
    // A forger can compute a structurally valid receipt: receiptIdFor is a
    // public content hash over caller-known inputs. Integrity != authenticity.
    const forged = receipt({ query: "search that never ran" });
    expect(isAttestedSearchReceipt(forged)).toBe(false);
    const verified = await verifyAttestedSearchReceipt(
      authority,
      forged as unknown as AttestedSearchReceipt,
    );
    expect(verified.ok).toBe(false);
    if (verified.ok) return;
    expect(verified.code).toBe("RECEIPT_NOT_AUTHENTIC");
  });

  it("REJECTS an attestation transplanted onto a different receipt", async () => {
    const authority = createFakeReceiptAttestationAuthority();
    const attested = await attestSearchReceipt(authority, receipt());
    expect(attested.ok).toBe(true);
    if (!attested.ok) return;

    // Same proof, different payload — the attestation must commit to THIS
    // receipt, not merely be a well-formed blob.
    const transplanted = {
      ...attested.value,
      query: "a different search entirely",
    } as AttestedSearchReceipt;
    const verified = await verifyAttestedSearchReceipt(
      authority,
      transplanted,
    );
    expect(verified.ok).toBe(false);
    if (verified.ok) return;
    expect(verified.code).toBe("RECEIPT_NOT_AUTHENTIC");
  });

  it("refuses a transplanted attestation even if the AUTHORITY would accept it", async () => {
    /**
     * The module must bind the attestation to THIS payload itself, before
     * delegating. Otherwise transplant-rejection is a caller-trusted control:
     * it would work only while every injected authority remembers to check
     * payload binding, and the first one that forgets silently reopens the hole.
     *
     * This uses a deliberately PERMISSIVE authority that accepts anything, so
     * the assertion can only be satisfied by the module's own check. Without
     * it, deleting that check leaves the suite green (verified by mutation).
     */
    const permissive: SearchReceiptAttestationAuthority = {
      async attest(payloadSha256) {
        return {
          ok: true as const,
          attestation: Object.freeze({
            version: 1 as const,
            authorityId: "permissive",
            authorityRevision: 1,
            payloadSha256,
            proof: "permissive-proof",
          }),
        };
      },
      async verify() {
        return { ok: true as const };
      },
    };

    const attested = await attestSearchReceipt(permissive, receipt());
    expect(attested.ok).toBe(true);
    if (!attested.ok) return;

    // Positive control: unmodified, the permissive authority accepts it.
    const clean = await verifyAttestedSearchReceipt(permissive, attested.value);
    expect(clean.ok).toBe(true);

    // Transplant: same proof, different payload. The authority would say yes;
    // the module must say no.
    const transplanted = {
      ...attested.value,
      query: "a different search entirely",
    } as AttestedSearchReceipt;
    const verified = await verifyAttestedSearchReceipt(
      permissive,
      transplanted,
    );
    expect(verified.ok).toBe(false);
    if (verified.ok) return;
    expect(verified.code).toBe("RECEIPT_NOT_AUTHENTIC");
  });

  it("FAILS CLOSED when the authority is unavailable — never a pass", async () => {
    const authority = createFakeReceiptAttestationAuthority();
    const attested = await attestSearchReceipt(authority, receipt());
    expect(attested.ok).toBe(true);
    if (!attested.ok) return;

    authority.setUnavailable(true);

    const issued = await attestSearchReceipt(authority, receipt());
    expect(issued.ok).toBe(false);
    if (!issued.ok) expect(issued.code).toBe("AUTHORITY_UNAVAILABLE");

    // Verification of a GENUINE attestation must also refuse, not pass, while
    // the authority cannot be consulted. An outage must never widen trust.
    const verified = await verifyAttestedSearchReceipt(
      authority,
      attested.value,
    );
    expect(verified.ok).toBe(false);
    if (verified.ok) return;
    expect(verified.code).toBe("AUTHORITY_UNAVAILABLE");
  });

  it("REJECTS an attestation from an unknown trust root", async () => {
    const issuer = createFakeReceiptAttestationAuthority({
      authorityId: "authority-1",
    });
    const other = createFakeReceiptAttestationAuthority({
      authorityId: "authority-2",
    });
    const attested = await attestSearchReceipt(issuer, receipt());
    expect(attested.ok).toBe(true);
    if (!attested.ok) return;

    const verified = await verifyAttestedSearchReceipt(other, attested.value);
    expect(verified.ok).toBe(false);
    if (verified.ok) return;
    expect(verified.code).toBe("RECEIPT_NOT_AUTHENTIC");
  });
});

// ---------------------------------------------------------------------------
// hygiene
// ---------------------------------------------------------------------------
describe("hygiene", () => {
  it("exports bounded limits and deep-freezes attested output", async () => {
    expect(RECEIPT_ATTESTATION_LIMITS).toBeDefined();
    expect(Object.isFrozen(RECEIPT_ATTESTATION_LIMITS)).toBe(true);
    const authority = createFakeReceiptAttestationAuthority();
    const attested = await attestSearchReceipt(authority, receipt());
    expect(attested.ok).toBe(true);
    if (!attested.ok) return;
    expect(Object.isFrozen(attested.value)).toBe(true);
  });

  it("does not interpolate untrusted receipt text into failure messages", async () => {
    const authority = createFakeReceiptAttestationAuthority();
    const forged = receipt({ query: "SENTINEL-INJECTED-QUERY" });
    const verified = await verifyAttestedSearchReceipt(
      authority,
      forged as unknown as AttestedSearchReceipt,
    );
    expect(verified.ok).toBe(false);
    if (verified.ok) return;
    expect(verified.message).not.toContain("SENTINEL-INJECTED-QUERY");
  });

  it("keeps the attestation authority type on the retrieval barrel but no fakes", async () => {
    const barrel = (await import("./index.js")) as Record<string, unknown>;
    expect(typeof barrel.attestSearchReceipt).toBe("function");
    expect(typeof barrel.verifyAttestedSearchReceipt).toBe("function");
    // Testing fake stays off the public barrel (T-22-01 discipline, T007).
    expect(barrel.createFakeReceiptAttestationAuthority).toBeUndefined();
  });
});

// Type-level guard: an unattested SearchReceipt must not satisfy
// AttestedSearchReceipt. If this ever compiles without the cast, the brand has
// been weakened and the whole control is decorative.
describe("structural distinction", () => {
  it("rejects a bare receipt at both the type and runtime boundary", async () => {
    const bare = receipt();

    // Compile-time half: enforced by tsc in the gate. If the brand is ever
    // weakened, @ts-expect-error becomes an unused-directive error and the
    // typecheck fails — which is the point of the brand existing at all.
    // @ts-expect-error a bare SearchReceipt is NOT an AttestedSearchReceipt
    const bad: AttestedSearchReceipt = bare;

    // Runtime half: the guard must actually reject it. Without this the test
    // passes on an unimplemented module (the type directive alone is satisfied
    // when the type does not exist), which would make it decoration inside a
    // RED rather than coverage.
    expect(isAttestedSearchReceipt(bad)).toBe(false);

    // And an attested receipt must pass the same guard, so the assertion above
    // cannot be satisfied by a guard that simply always returns false.
    const authority: SearchReceiptAttestationAuthority =
      createFakeReceiptAttestationAuthority();
    const attested = await attestSearchReceipt(authority, receipt());
    expect(attested.ok).toBe(true);
    if (!attested.ok) return;
    expect(isAttestedSearchReceipt(attested.value)).toBe(true);
  });
});
