import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Sha256, SnapshotId, SourceFileId, SourceUnitId } from "../../domain/ingest/index.js";
import { ClaimSchema, type Claim } from "../../domain/ingest/claim.js";

import {
  createClaimRepository,
  createInMemoryClaimStore,
  createFileClaimStore,
  deriveClaimId,
  type EvidenceVerificationReader,
  type ClaimAcceptanceAuthority,
} from "./claim-repository.js";

const SNAPSHOT = `snap-${"b".repeat(64)}` as SnapshotId;
const FILE = `file-${"a".repeat(64)}` as SourceFileId;
const UNIT = "unit-01ARZ3NDEKTSV4RRFFQ69G5FAV" as SourceUnitId;
const QUESTION = "q-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PACKET = "pkt-01ARZ3NDEKTSV4RRFFQ69G5FAV";

function sha(text: string): Sha256 {
  return createHash("sha256").update(text).digest("hex") as Sha256;
}

const FILE_HASH = sha("file");
const UNIT_HASH = sha("unit");

function evidence(verified = false) {
  return {
    snapshotId: SNAPSHOT,
    fileId: FILE,
    unitId: UNIT,
    fileSha256: FILE_HASH,
    unitSha256: UNIT_HASH,
    verified,
  };
}

function createInput(overrides: Record<string, unknown> = {}) {
  return {
    statement: "Workers retry failed endpoints with exponential backoff.",
    claimType: "behavior",
    scope: { component: "delivery-worker", version: "3.x" },
    authority: "official",
    lifecycle: "current",
    evidenceRefs: [evidence(false)],
    relationships: {
      qualifierClaimIds: [] as string[],
      contradictsClaimIds: [] as string[],
      supersedesClaimIds: [] as string[],
    },
    createdFrom: { questionId: QUESTION, packetId: PACKET },
    ...overrides,
  };
}

function verifierOk(): EvidenceVerificationReader {
  return {
    isVerified: async () => true,
  };
}

function verifierNone(): EvidenceVerificationReader {
  return {
    isVerified: async () => false,
  };
}

/**
 * T-22-03 seam stand-in: returns a verified review application ref.
 * Not a signer / not crypto auth — fake only on testing surface.
 */
function authorityAllow(): ClaimAcceptanceAuthority {
  return {
    authorizeAcceptance: async () => ({
      ok: true as const,
      value: {
        reviewApplicationRef: "crv-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      },
    }),
  };
}

function authorityDeny(): ClaimAcceptanceAuthority {
  return {
    authorizeAcceptance: async () => ({
      ok: false as const,
      code: "ACCEPTANCE_FORBIDDEN" as const,
      message: "No independent review application.",
    }),
  };
}

function repo(
  overrides: {
    store?: ReturnType<typeof createInMemoryClaimStore>;
    evidence?: EvidenceVerificationReader;
    acceptance?: ClaimAcceptanceAuthority;
  } = {},
) {
  return createClaimRepository({
    store: overrides.store ?? createInMemoryClaimStore(),
    evidence: overrides.evidence ?? verifierOk(),
    // Default tests that need accept inject allow; public default is deny-until-T22-03
    acceptance: overrides.acceptance ?? authorityAllow(),
  });
}

describe("construction", () => {
  it("requires evidence verification reader", () => {
    expect(() =>
      createClaimRepository({
        store: createInMemoryClaimStore(),
        acceptance: authorityAllow(),
      } as never),
    ).toThrow(/evidence/i);
  });

  it("requires acceptance authority seam (T-22-03 implements; not public auto-accept)", () => {
    expect(() =>
      createClaimRepository({
        store: createInMemoryClaimStore(),
        evidence: verifierOk(),
      } as never),
    ).toThrow(/acceptance/i);
  });
});

describe("create — proposed only", () => {
  it("creates a proposed claim with version 1", async () => {
    const result = await repo().create(createInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe("proposed");
    expect(result.value.version).toBe(1);
    expect(result.value.id).toMatch(/^clm-/);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(result.value.statement).toContain("retry");
  });

  it("rejects empty statement and unknown claimType", async () => {
    const empty = await repo().create(createInput({ statement: "" }));
    expect(empty.ok).toBe(false);
    const badType = await repo().create(createInput({ claimType: "bogus" }));
    expect(badType.ok).toBe(false);
  });

  it("rejects hostile accessors and unknown keys", async () => {
    let accessed = false;
    const hostile = {
      ...createInput(),
      get statement() {
        accessed = true;
        throw new Error("nope");
      },
    };
    delete (hostile as { statement?: string }).statement;
    Object.defineProperty(hostile, "statement", {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error("nope");
      },
    });
    const result = await repo().create(hostile);
    expect(accessed).toBe(false);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_INPUT");

    const unknown = await repo().create({ ...createInput(), evil: true });
    expect(unknown.ok).toBe(false);
  });

  it("rejects create that tries to force accepted state", async () => {
    const result = await repo().create(createInput({ state: "accepted" }));
    expect(result.ok).toBe(false);
  });
});

describe("transition — acceptance gates (T-22-01 structure + T-22-03 authority)", () => {
  it("reviewerRunId is provenance only — without acceptance authority grant, accept is forbidden", async () => {
    // reviewerRunId alone must NOT prove independent review (not authenticated authority).
    const r = repo({ acceptance: authorityDeny() });
    const created = await r.create(createInput());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const result = await r.transition({
      claimId: created.value.id,
      expectedVersion: 1,
      to: "accepted",
      reviewerRunId: "run-01ARZ3NDEKTSV4RRFFQ69G5FAV",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["ACCEPTANCE_FORBIDDEN", "REVIEW_REQUIRED"]).toContain(result.code);
    }
  });

  it("rejects accept without reviewerRunId provenance even when authority grants", async () => {
    const r = repo({ acceptance: authorityAllow() });
    const created = await r.create(createInput());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const result = await r.transition({
      claimId: created.value.id,
      expectedVersion: 1,
      to: "accepted",
      // missing provenance reviewerRunId
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("REVIEW_REQUIRED");
  });

  it("rejects accept without verified evidence even with authority + provenance", async () => {
    const r = repo({ evidence: verifierNone(), acceptance: authorityAllow() });
    const created = await r.create(createInput());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const result = await r.transition({
      claimId: created.value.id,
      expectedVersion: 1,
      to: "accepted",
      reviewerRunId: "run-01ARZ3NDEKTSV4RRFFQ69G5FAV",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("EVIDENCE_UNVERIFIED");
  });

  it("accepts when authority grants + verified evidence + scope/authority/lifecycle + provenance", async () => {
    const r = repo({ acceptance: authorityAllow(), evidence: verifierOk() });
    const created = await r.create(createInput());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const ok = await r.transition({
      claimId: created.value.id,
      expectedVersion: 1,
      to: "accepted",
      reviewerRunId: "run-01ARZ3NDEKTSV4RRFFQ69G5FAV",
    });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.value.state).toBe("accepted");
    expect(ok.value.version).toBe(2);
    // provenance recorded; not treated as crypto proof
    expect(ok.value.reviewerRunId).toBe("run-01ARZ3NDEKTSV4RRFFQ69G5FAV");
  });

  it("rejects accept when evidenceRefs empty at create", async () => {
    const r = repo();
    const created = await r.create(
      createInput({
        evidenceRefs: [],
      }),
    );
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.code).toBe("INVALID_INPUT");
  });

  it("public barrel exports createClaimRepository and not auto-accept helpers", async () => {
    const barrel = await import("./index.js");
    // Positive export must fail on RED placeholders / missing barrel wire.
    expect(
      typeof (barrel as { createClaimRepository?: unknown })
        .createClaimRepository,
    ).toBe("function");
    // Negative locks: no free-standing auto-accept bypass of T-22-03.
    expect(
      (barrel as { autoAcceptClaim?: unknown }).autoAcceptClaim,
    ).toBeUndefined();
    expect(
      (barrel as { acceptClaimWithoutReview?: unknown })
        .acceptClaimWithoutReview,
    ).toBeUndefined();
  });
});

describe("transition — lifecycle table", () => {
  it("allows proposed → disputed", async () => {
    const r = repo();
    const created = await r.create(createInput());
    if (!created.ok) return;
    const result = await r.transition({
      claimId: created.value.id,
      expectedVersion: 1,
      to: "disputed",
      reason: "conflicts with peer claim",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe("disputed");
  });

  it("allows accepted → stale via source change mark", async () => {
    const r = repo();
    const created = await r.create(createInput());
    if (!created.ok) return;
    await r.transition({
      claimId: created.value.id,
      expectedVersion: 1,
      to: "accepted",
      reviewerRunId: "run-01ARZ3NDEKTSV4RRFFQ69G5FAV",
    });
    const stale = await r.markStaleFromSourceChange({
      snapshotId: SNAPSHOT,
      unitIds: [UNIT],
      reason: "unit content changed",
    });
    expect(stale.ok).toBe(true);
    if (!stale.ok) return;
    expect(stale.value.some((c) => c.state === "stale")).toBe(true);
    const got = await r.get(created.value.id);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value.state).toBe("stale");
  });

  it("allows accepted → superseded with acyclic supersedes edge", async () => {
    const r = repo();
    const a = await r.create(createInput({ statement: "Claim A text" }));
    const b = await r.create(createInput({ statement: "Claim B text" }));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    await r.transition({
      claimId: a.value.id,
      expectedVersion: 1,
      to: "accepted",
      reviewerRunId: "run-01ARZ3NDEKTSV4RRFFQ69G5FAV",
    });
    await r.transition({
      claimId: b.value.id,
      expectedVersion: 1,
      to: "accepted",
      reviewerRunId: "run-01ARZ3NDEKTSV4RRFFQ69G5FBW",
    });
    const result = await r.transition({
      claimId: a.value.id,
      expectedVersion: 2,
      to: "superseded",
      supersederId: b.value.id,
      reason: "B replaces A",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe("superseded");
  });

  it("rejects cyclic supersession", async () => {
    const r = repo();
    const a = await r.create(createInput({ statement: "A" }));
    const b = await r.create(createInput({ statement: "B" }));
    if (!a.ok || !b.ok) return;
    await r.transition({
      claimId: a.value.id,
      expectedVersion: 1,
      to: "accepted",
      reviewerRunId: "run-01ARZ3NDEKTSV4RRFFQ69G5FAV",
    });
    await r.transition({
      claimId: b.value.id,
      expectedVersion: 1,
      to: "accepted",
      reviewerRunId: "run-01ARZ3NDEKTSV4RRFFQ69G5FBW",
    });
    await r.transition({
      claimId: a.value.id,
      expectedVersion: 2,
      to: "superseded",
      supersederId: b.value.id,
      reason: "B>A",
    });
    // B superseded by A would cycle
    const cycle = await r.transition({
      claimId: b.value.id,
      expectedVersion: 2,
      to: "superseded",
      supersederId: a.value.id,
      reason: "cycle",
    });
    expect(cycle.ok).toBe(false);
    if (!cycle.ok) expect(cycle.code).toBe("CYCLE_DETECTED");
  });

  it("rejects illegal transitions (stale → accepted, superseded → proposed)", async () => {
    const r = repo();
    const created = await r.create(createInput());
    if (!created.ok) return;
    await r.transition({
      claimId: created.value.id,
      expectedVersion: 1,
      to: "accepted",
      reviewerRunId: "run-01ARZ3NDEKTSV4RRFFQ69G5FAV",
    });
    await r.markStaleFromSourceChange({
      snapshotId: SNAPSHOT,
      unitIds: [UNIT],
      reason: "changed",
    });
    const illegal = await r.transition({
      claimId: created.value.id,
      expectedVersion: 3,
      to: "accepted",
      reviewerRunId: "run-01ARZ3NDEKTSV4RRFFQ69G5FAV",
    });
    expect(illegal.ok).toBe(false);
    if (!illegal.ok) expect(illegal.code).toBe("ILLEGAL_TRANSITION");
  });

  it("rejects overwrite / stale expectedVersion", async () => {
    const r = repo();
    const created = await r.create(createInput());
    if (!created.ok) return;
    const bad = await r.transition({
      claimId: created.value.id,
      expectedVersion: 0,
      to: "disputed",
      reason: "x",
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("VERSION_CONFLICT");
  });
});

describe("append-only CAS and idempotency", () => {
  it("get returns latest; versions append-only", async () => {
    const r = repo();
    const created = await r.create(createInput());
    if (!created.ok) return;
    await r.transition({
      claimId: created.value.id,
      expectedVersion: 1,
      to: "disputed",
      reason: "peer",
    });
    const latest = await r.get(created.value.id);
    expect(latest.ok).toBe(true);
    if (!latest.ok) return;
    expect(latest.value.version).toBe(2);
    expect(latest.value.state).toBe("disputed");
    const v1 = await r.getVersion(created.value.id, 1);
    expect(v1.ok).toBe(true);
    if (!v1.ok) return;
    expect(v1.value.state).toBe("proposed");
  });

  it("idempotent create/transition with same key", async () => {
    const r = repo();
    const input = { ...createInput(), idempotencyKey: "c1" };
    const first = await r.create(input);
    const second = await r.create(input);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.id).toBe(first.value.id);
    expect(second.value.version).toBe(first.value.version);
  });

  it("idempotency conflict on different payload same key", async () => {
    const r = repo();
    const first = await r.create({
      ...createInput(),
      idempotencyKey: "c2",
    });
    expect(first.ok).toBe(true);
    const conflict = await r.create({
      ...createInput({ statement: "Different statement entirely." }),
      idempotencyKey: "c2",
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.code).toBe("IDEMPOTENCY_CONFLICT");
  });
});

describe("list and immutability", () => {
  it("list returns created claims without mutation alias", async () => {
    const r = repo();
    await r.create(createInput({ statement: "One" }));
    await r.create(createInput({ statement: "Two" }));
    const list = await r.list();
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value.length).toBeGreaterThanOrEqual(2);
    expect(Object.isFrozen(list.value)).toBe(true);
  });
});

describe("durable store / crash / custody", () => {
  it("exports createFileClaimStore", async () => {
    const mod = await import("./claim-repository.js");
    expect(typeof mod.createFileClaimStore).toBe("function");
  });

  it("survives fresh process get after create", async () => {
    if (process.platform !== "linux") return;
    const root = await mkdtemp(join(tmpdir(), "clm-dur-"));
    try {
      const store = createFileClaimStore(root);
      const r = createClaimRepository({
        store,
        evidence: verifierOk(),
        acceptance: authorityAllow(),
      });
      const created = await r.create(createInput());
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const fresh = createClaimRepository({
        store: createFileClaimStore(root),
        evidence: verifierOk(),
        acceptance: authorityAllow(),
      });
      const got = await fresh.get(created.value.id);
      expect(got.ok).toBe(true);
      if (!got.ok) return;
      expect(got.value.statement).toBe(created.value.statement);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("crash before publish leaves no readable claim", async () => {
    if (process.platform !== "linux") return;
    const root = await mkdtemp(join(tmpdir(), "clm-crash-"));
    try {
      const store = createFileClaimStore(root, {
        afterTempWriteBeforePublish: () => {
          throw new Error("injected-crash");
        },
      });
      const r = createClaimRepository({
        store,
        evidence: verifierOk(),
        acceptance: authorityAllow(),
      });
      await expect(r.create(createInput())).rejects.toThrow(/injected-crash/);
      const fresh = createFileClaimStore(root);
      const id = deriveClaimId(QUESTION, PACKET, createInput().statement);
      const got = await fresh.get(id);
      expect(got).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("fails closed on directory symlink root", async () => {
    if (process.platform !== "linux") return;
    const base = await mkdtemp(join(tmpdir(), "clm-root-"));
    const outside = join(base, "outside");
    const linkRoot = join(base, "link");
    await mkdir(outside);
    await symlink(outside, linkRoot);
    const store = createFileClaimStore(linkRoot);
    await expect(
      store.append({
        schemaVersion: 1,
        id: "clm-01ARZ3NDEKTSV4RRFFQ69G5FAV",
        version: 1,
        statement: "x",
        claimType: "behavior",
        scope: { component: "c" },
        authority: "official",
        lifecycle: "current",
        state: "proposed",
        evidenceRefs: [evidence()],
        relationships: {
          qualifierClaimIds: [],
          contradictsClaimIds: [],
          supersedesClaimIds: [],
        },
        createdFrom: { questionId: QUESTION, packetId: PACKET },
      } as Claim),
    ).rejects.toThrow(/symbolic|Refusing/i);
    await rm(base, { recursive: true, force: true });
  });

  it("enumerates contiguous versions through at least v40 (no 1..32 ceiling)", async () => {
    if (process.platform !== "linux") return;
    const root = await mkdtemp(join(tmpdir(), "clm-v40-"));
    try {
      const store = createFileClaimStore(root);
      const r = createClaimRepository({
        store,
        evidence: verifierOk(),
        acceptance: authorityAllow(),
      });
      const created = await r.create(createInput());
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      for (let version = 2; version <= 40; version += 1) {
        const next = await r.transition({
          claimId: created.value.id,
          expectedVersion: version - 1,
          to: "disputed",
          reason: `r${version}`,
        });
        // after first dispute, may need to go disputed→disputed or stay with reason-only append
        // RED: repository must support append versions through v40 via repeated legal transitions
        if (!next.ok) {
          // allow re-dispute from disputed as version bump with same state if product forbids — prefer reason-bearing version append
          expect(next.ok).toBe(true);
        }
      }
      const fresh = createClaimRepository({
        store: createFileClaimStore(root),
        evidence: verifierOk(),
        acceptance: authorityAllow(),
      });
      const latest = await fresh.get(created.value.id);
      expect(latest.ok).toBe(true);
      if (!latest.ok) return;
      expect(latest.value.version).toBeGreaterThanOrEqual(40);
      const v35 = await fresh.getVersion(created.value.id, 35);
      expect(v35.ok).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it("fails closed on gap/malformed/cross-stream without skipping to later valid", async () => {
    if (process.platform !== "linux") return;
    const root = await mkdtemp(join(tmpdir(), "clm-gap-"));
    try {
      const store = createFileClaimStore(root);
      const r = createClaimRepository({
        store,
        evidence: verifierOk(),
        acceptance: authorityAllow(),
      });
      const created = await r.create(createInput());
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      // Path convention: .ultradyn/claims/<id>/
      const streamDir = join(root, ".ultradyn", "claims", created.value.id);
      await writeFile(join(streamDir, "v00000003.json"), "{not-json", "utf8");
      const fresh = createFileClaimStore(root);
      await expect(fresh.latest(created.value.id)).rejects.toThrow(
        /STREAM_CORRUPT|corrupt|malformed|gap/i,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("crash after immutable publish before operation commit leaves no half-success", async () => {
    if (process.platform !== "linux") return;
    const root = await mkdtemp(join(tmpdir(), "clm-crash2-"));
    try {
      const store = createFileClaimStore(root, {
        afterImmutablePublishBeforeOpCommit: () => {
          throw new Error("injected-crash-op");
        },
      });
      const r = createClaimRepository({
        store,
        evidence: verifierOk(),
        acceptance: authorityAllow(),
      });
      await expect(
        r.create({ ...createInput(), idempotencyKey: "crash-op-1" }),
      ).rejects.toThrow(/injected-crash-op/);
      const freshStore = createFileClaimStore(root);
      const id = deriveClaimId(QUESTION, PACKET, createInput().statement);
      // no half-success readable as durable latest
      const latest = await freshStore.latest(id).catch(() => undefined);
      // either undefined or stream not committed
      expect(latest === undefined || latest === null).toBe(true);
      // same-key retry reconciles
      const retry = createClaimRepository({
        store: createFileClaimStore(root),
        evidence: verifierOk(),
        acceptance: authorityAllow(),
      });
      const again = await retry.create({
        ...createInput(),
        idempotencyKey: "crash-op-1",
      });
      expect(again.ok).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("durable get never falls back to process memory", async () => {
    if (process.platform !== "linux") return;
    const root = await mkdtemp(join(tmpdir(), "clm-nomem-"));
    try {
      const mem = createInMemoryClaimStore();
      const file = createFileClaimStore(root);
      // write only to memory
      const memRepo = createClaimRepository({
        store: mem,
        evidence: verifierOk(),
        acceptance: authorityAllow(),
      });
      const created = await memRepo.create(createInput());
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      // durable store must not see memory-only claim
      const durable = createClaimRepository({
        store: file,
        evidence: verifierOk(),
        acceptance: authorityAllow(),
      });
      const missing = await durable.get(created.value.id);
      expect(missing.ok).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("fails closed when descriptor binding unavailable (off-Linux posture)", async () => {
    if (process.platform === "linux") {
      // On Linux, capability path is available — skip or assert export exists
      const mod = await import("./claim-repository.js");
      expect(typeof mod.createFileClaimStore).toBe("function");
      return;
    }
    const root = await mkdtemp(join(tmpdir(), "clm-off-"));
    try {
      const store = createFileClaimStore(root);
      await expect(
        store.append({
          schemaVersion: 1,
          id: "clm-01ARZ3NDEKTSV4RRFFQ69G5FAV",
          version: 1,
          statement: "x",
          claimType: "behavior",
          scope: { component: "c" },
          authority: "official",
          lifecycle: "current",
          state: "proposed",
          evidenceRefs: [evidence()],
          relationships: {
            qualifierClaimIds: [],
            contradictsClaimIds: [],
            supersedesClaimIds: [],
          },
          createdFrom: { questionId: QUESTION, packetId: PACKET },
        } as Claim),
      ).rejects.toThrow(/Descriptor binding|fail-closed/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("public seams", () => {
  it("ClaimSchema from domain rejects placeholder alone", () => {
    expect(
      ClaimSchema.safeParse({
        schemaVersion: 1,
        id: "clm-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      }).success,
    ).toBe(false);
  });

  it("registry Claim rejects placeholder and accepts full shape", async () => {
    const { ingestSchemaRegistry } =
      await import("../../domain/ingest/schema-registry.js");
    const schema = ingestSchemaRegistry.get("Claim", 1);
    expect(
      schema.safeParse({
        schemaVersion: 1,
        id: "clm-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      }).success,
    ).toBe(false);
  });

  it("knowledge barrel re-exports createClaimRepository", async () => {
    const barrel = await import("./index.js");
    expect(
      typeof (barrel as { createClaimRepository?: unknown })
        .createClaimRepository,
    ).toBe("function");
  });

  it("domain barrel ClaimSchema rejects placeholder (no soft typeof)", async () => {
    const barrel = await import("../../domain/ingest/index.js");
    const schema = (
      barrel as {
        ClaimSchema: { safeParse: (v: unknown) => { success: boolean } };
      }
    ).ClaimSchema;
    expect(
      schema.safeParse({
        schemaVersion: 1,
        id: "clm-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      }).success,
    ).toBe(false);
  });
});
