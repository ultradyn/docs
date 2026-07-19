import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { canonicalDataRightsPolicyProfile } from "../../domain/ingest/index.js";

import {
  createFilePolicyApprovalStore,
  createInMemoryPolicyApprovalStore,
  createPolicyService,
} from "./index.js";
import {
  createFakeAttestationAuthority,
  createFilePolicyApprovalStoreForTests,
} from "./testing.js";

const HUMAN = "alex.review-1";
const OTHER_HUMAN = "sam.review-2";
const AGENT = "agent:claude-pivot-cotton-27tq";
const APPROVED_AT = "2026-07-19T07:30:00.000Z";

const candidate = {
  schemaVersion: 1,
  id: "policy-confidential-no-publish",
  dataRightsClass: "confidential",
  include: ["docs/**"],
  exclude: ["docs/private/**"],
  allowedMediaTypes: ["text/markdown"],
  allowedProcessors: ["local-markdown"],
  allowedProviders: ["provider:local-whisper"],
  allowedStorage: ["project-repository"],
  allowedRegions: ["local"],
  retentionClass: "project-lifetime",
  retentionDays: 365,
  logging: "ids-only",
  cache: ["profileId", "principalId"],
  accessClass: "project-members",
  licenceRestrictions: ["no-redistribution"],
  publication: "forbidden",
  maxQuoteBytes: 0,
  maxFiles: 1_000,
  maxFileBytes: 10_000_000,
  maxExpandedBytes: 100_000_000,
} as const;

// The legacy frozen intake contract. It is deliberately NOT a
// DataRightsPolicyProfile: it lacks every expanded rights field, and it carries
// the self-asserted `approved: true` that this service refuses to trust.
const legacyProfile = {
  schemaVersion: 1,
  id: "policy-internal-docs",
  approved: true,
  dataClass: "internal",
  include: ["docs/**"],
  exclude: ["docs/private/**"],
  allowedMediaTypes: ["text/markdown"],
  allowedProcessors: ["local-markdown"],
  allowedStorage: ["project-repository"],
  retentionDays: 365,
  accessClass: "project-members",
  maxFiles: 1_000,
  maxFileBytes: 10_000_000,
  maxExpandedBytes: 100_000_000,
} as const;

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "policy-service-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function authorityFor(eligible?: (actor: string) => boolean) {
  return createFakeAttestationAuthority({
    authorityId: "authority-1",
    eligible:
      eligible ?? ((actor: string) => actor === HUMAN || actor === OTHER_HUMAN),
  });
}

function service(
  overrides: {
    isAuthorisedHuman?: (actor: string) => boolean;
    store?: ReturnType<typeof createInMemoryPolicyApprovalStore>;
  } = {},
) {
  return createPolicyService({
    store: overrides.store ?? createInMemoryPolicyApprovalStore(),
    authority: authorityFor(overrides.isAuthorisedHuman),
    now: () => APPROVED_AT,
  });
}

async function approved(instance = service()) {
  const result = await instance.approve({
    profile: candidate,
    actor: HUMAN,
    reason: "Reviewed against the source licence.",
  });
  return { instance, result };
}

describe("a run cannot begin without a ledger-backed approval", () => {
  it("refuses an id that was never approved", async () => {
    const result = await service().assertRunAllowed(candidate.id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("POLICY_UNAPPROVED");
  });

  it("allows the run once the profile is approved", async () => {
    const { instance, result } = await approved();
    expect(result.ok).toBe(true);
    const allowed = await instance.assertRunAllowed(candidate.id);
    expect(allowed.ok).toBe(true);
  });

  it("does not treat a self-asserted approved flag as authority", async () => {
    // The whole point of the ledger. The legacy contract pins `approved: true`
    // at parse time, so a well-formed document always looks approved. Run
    // authority must come from an approval record naming a human, not from the
    // document's claim about itself.
    const result = await service().assertRunAllowed(legacyProfile.id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("POLICY_UNAPPROVED");
  });

  it("refuses a legacy profile submitted for approval", async () => {
    // Legacy PolicyProfile is never silently upgraded into the expanded record.
    const result = await service().approve({
      profile: legacyProfile as never,
      actor: HUMAN,
      reason: "Trying to run the old contract.",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("PROFILE_NOT_RUNNABLE");
  });

  it("keeps approvals scoped to their own profile id", async () => {
    const { instance } = await approved();
    const other = await instance.assertRunAllowed("policy-public-docs");
    expect(other.ok).toBe(false);
  });
});

describe("approval is a human act, recorded with provenance", () => {
  it("binds the approving actor into the record", async () => {
    const { result } = await approved();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.approvedBy).toBe(HUMAN);
  });

  it("binds an approval timestamp from the injected clock", async () => {
    const { result } = await approved();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.approvedAt).toBe(APPROVED_AT);
  });

  it("binds the canonical content digest of what was approved", async () => {
    const { result } = await approved();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.profileSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("requires a nonblank reason", async () => {
    const result = await service().approve({
      profile: candidate,
      actor: HUMAN,
      reason: "   ",
    });
    expect(result.ok).toBe(false);
  });

  it("refuses an agent actor even when the authority seam is permissive", async () => {
    // Defence in depth: the injected authority is the control, and an
    // agent-shaped handle is refused regardless of what that seam says.
    const result = await service({ isAuthorisedHuman: () => true }).approve({
      profile: candidate,
      actor: AGENT,
      reason: "Self approval attempt.",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("APPROVER_NOT_AUTHORIZED");
  });

  it("refuses an actor the authority seam does not recognise", async () => {
    const result = await service({ isAuthorisedHuman: () => false }).approve({
      profile: candidate,
      actor: HUMAN,
      reason: "Not on the roll.",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("APPROVER_NOT_AUTHORIZED");
  });

  it("refuses to record an approval for a profile that fails its schema", async () => {
    const result = await service().approve({
      profile: { ...candidate, allowedProcessors: [] } as never,
      actor: HUMAN,
      reason: "Invalid candidate.",
    });
    expect(result.ok).toBe(false);
  });
});

describe("the approval ledger is append-only and digest-pinned", () => {
  it("returns the same digest for a re-approval of identical content", async () => {
    const instance = service();
    const first = await instance.approve({
      profile: candidate,
      actor: HUMAN,
      reason: "First pass.",
    });
    const second = await instance.approve({
      profile: { ...candidate, cache: ["principalId", "profileId"] },
      actor: HUMAN,
      reason: "Same content, different list order.",
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.profileSha256).toBe(first.value.profileSha256);
  });

  it("refuses a changed profile under an already approved id", async () => {
    // Threat T16. Last-write-wins would let a second approval silently retarget
    // a running policy id, so changed content must take a NEW id.
    const instance = service();
    await instance.approve({
      profile: candidate,
      actor: HUMAN,
      reason: "First pass.",
    });
    const conflicting = await instance.approve({
      profile: { ...candidate, retentionDays: 30 },
      actor: OTHER_HUMAN,
      reason: "Different content, same id.",
    });
    expect(conflicting.ok).toBe(false);
    if (conflicting.ok) return;
    expect(conflicting.code).toBe("APPROVAL_CONFLICT");
  });

  it("still allows the originally approved content after a rejected conflict", async () => {
    const instance = service();
    await instance.approve({
      profile: candidate,
      actor: HUMAN,
      reason: "First pass.",
    });
    await instance.approve({
      profile: { ...candidate, retentionDays: 30 },
      actor: OTHER_HUMAN,
      reason: "Different content, same id.",
    });
    const allowed = await instance.assertRunAllowed(candidate.id);
    expect(allowed.ok).toBe(true);
    if (!allowed.ok) return;
    expect(allowed.value.profile.retentionDays).toBe(365);
  });

  it("exposes no member that could revoke or delete an approval", () => {
    // Declarative policy only. Authorised deletion is T-10-04, blocked on
    // ADR 0007, ratified D9, and every capability gate.
    const instance = service() as unknown as Record<string, unknown>;
    for (const member of [
      "delete",
      "erase",
      "purge",
      "unlink",
      "revoke",
      "truncate",
    ]) {
      expect(member in instance).toBe(false);
    }
  });

  it("returns a record the caller cannot mutate into a different approval", async () => {
    const { result } = await approved();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.isFrozen(result.value)).toBe(true);
  });
});

describe("run authority survives a process restart", () => {
  function durable() {
    return createPolicyService({
      store: createFilePolicyApprovalStore({ root }),
      authority: authorityFor((actor: string) => actor === HUMAN),
      now: () => APPROVED_AT,
    });
  }

  it("allows a run from an approval a previous instance recorded", async () => {
    const first = await durable().approve({
      profile: candidate,
      actor: HUMAN,
      reason: "Approved before the restart.",
    });
    expect(first.ok).toBe(true);
    const allowed = await durable().assertRunAllowed(candidate.id);
    expect(allowed.ok).toBe(true);
    if (!allowed.ok) return;
    expect(allowed.value.approvedBy).toBe(HUMAN);
  });

  it("answers from the record alone without re-supplying the profile", async () => {
    await durable().approve({
      profile: candidate,
      actor: HUMAN,
      reason: "Approved before the restart.",
    });
    const allowed = await durable().assertRunAllowed(candidate.id);
    expect(allowed.ok).toBe(true);
    if (!allowed.ok) return;
    // The record stores the CANONICAL profile, since that is what the digest
    // commits to. Comparing against the raw candidate would assert storage
    // order rather than self-containment.
    expect(allowed.value.profile).toEqual(
      canonicalDataRightsPolicyProfile(candidate),
    );
  });

  it("still refuses an unapproved id after a restart", async () => {
    await durable().approve({
      profile: candidate,
      actor: HUMAN,
      reason: "Approved before the restart.",
    });
    const other = await durable().assertRunAllowed("policy-public-docs");
    expect(other.ok).toBe(false);
    if (other.ok) return;
    expect(other.code).toBe("POLICY_UNAPPROVED");
  });

  it("replays idempotently across instances rather than duplicating", async () => {
    await durable().approve({
      profile: candidate,
      actor: HUMAN,
      reason: "Approved before the restart.",
    });
    const again = await durable().approve({
      profile: candidate,
      actor: HUMAN,
      reason: "Approved before the restart.",
    });
    expect(again.ok).toBe(true);
  });

  it("fails closed when the durable record is unreadable", async () => {
    // An unreadable ledger must never be read as "nothing approved", which
    // would silently downgrade to denying every run, nor as permission.
    await durable().approve({
      profile: candidate,
      actor: HUMAN,
      reason: "Approved before the restart.",
    });
    const broken = createPolicyService({
      store: createFilePolicyApprovalStoreForTests({
        root,
        capabilities: {
          readFile: async () => {
            throw new Error("storage unavailable");
          },
        },
      }),
      authority: authorityFor((actor: string) => actor === HUMAN),
      now: () => APPROVED_AT,
    });
    const allowed = await broken.assertRunAllowed(candidate.id);
    expect(allowed.ok).toBe(false);
    if (allowed.ok) return;
    expect(allowed.code).not.toBe("POLICY_UNAPPROVED");
  });
});
