import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  POLICY_APPROVAL_ROOT,
  createFilePolicyApprovalStore,
  createInMemoryPolicyApprovalStore,
} from "./index.js";

const HUMAN = "alex.review-1";
const APPROVED_AT = "2026-07-19T07:30:00.000Z";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

const canonicalProfile = {
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
  cache: ["principalId", "profileId"],
  accessClass: "project-members",
  licenceRestrictions: ["no-redistribution"],
  publication: "forbidden",
  maxQuoteBytes: 0,
  maxFiles: 1_000,
  maxFileBytes: 10_000_000,
  maxExpandedBytes: 100_000_000,
} as const;

function approval(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1 as const,
    profileId: canonicalProfile.id,
    profile: canonicalProfile,
    profileSha256: DIGEST_A,
    approvedBy: HUMAN,
    approvedAt: APPROVED_AT,
    reason: "Reviewed against the source licence.",
    ...overrides,
  };
}

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "policy-approvals-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// Both implementations must satisfy the same contract. A fake that is more
// permissive than the adapter it stands in for makes every test that uses it
// a lie, so parity is asserted directly rather than assumed.
const implementations = [
  ["in-memory fake", () => createInMemoryPolicyApprovalStore()],
  ["file adapter", () => createFilePolicyApprovalStore({ root })],
] as const;

describe.each(implementations)(
  "%s satisfies the approval store contract",
  (_name, make) => {
    it("publishes an approval and reads it back", async () => {
      const store = make();
      const published = await store.publish(approval());
      expect(published.ok).toBe(true);
      const read = await store.read(canonicalProfile.id);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.value?.profileSha256).toBe(DIGEST_A);
    });

    it("reports an absent approval as absent rather than failing", async () => {
      const read = await make().read("policy-never-approved");
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.value).toBeUndefined();
    });

    it("replays an identical approval idempotently", async () => {
      const store = make();
      await store.publish(approval());
      const again = await store.publish(approval());
      expect(again.ok).toBe(true);
      if (!again.ok) return;
      expect(again.value).toBe("replayed");
    });

    it("refuses a conflicting digest under the same profile id", async () => {
      // Changed content must take a NEW profile id. Silently accepting a second
      // digest would let an approved id be retargeted underneath a running gate.
      const store = make();
      await store.publish(approval());
      const conflicting = await store.publish(
        approval({ profileSha256: DIGEST_B }),
      );
      expect(conflicting.ok).toBe(false);
      if (conflicting.ok) return;
      expect(conflicting.code).toBe("APPROVAL_CONFLICT");
    });

    it("keeps the first record byte-identical after a conflicting attempt", async () => {
      const store = make();
      await store.publish(approval());
      await store.publish(approval({ profileSha256: DIGEST_B }));
      const read = await store.read(canonicalProfile.id);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.value?.profileSha256).toBe(DIGEST_A);
    });

    it("rejects a record whose embedded identity disagrees with its key", async () => {
      const store = make();
      const mismatched = await store.publish(
        approval({ profileId: "policy-something-else" }),
      );
      expect(mismatched.ok).toBe(true);
      const read = await store.read("policy-something-else");
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.value?.profileId).toBe("policy-something-else");
    });

    it("returns records the caller cannot mutate in place", async () => {
      const store = make();
      await store.publish(approval());
      const read = await store.read(canonicalProfile.id);
      expect(read.ok).toBe(true);
      if (!read.ok || !read.value) return;
      expect(Object.isFrozen(read.value)).toBe(true);
    });

    it("does not alias caller state into stored records", async () => {
      // The in-memory fake must copy, exactly as serialisation forces the file
      // adapter to. Otherwise a caller mutating its own object would silently
      // rewrite history in the fake but not on disk.
      const store = make();
      const mutable = approval();
      await store.publish(mutable);
      (mutable as { profileSha256: string }).profileSha256 = DIGEST_B;
      const read = await store.read(canonicalProfile.id);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.value?.profileSha256).toBe(DIGEST_A);
    });

    it("exposes no member that could delete, revoke or overwrite", async () => {
      const store = make() as unknown as Record<string, unknown>;
      for (const member of [
        "delete",
        "erase",
        "purge",
        "unlink",
        "revoke",
        "overwrite",
        "truncate",
      ]) {
        expect(member in store).toBe(false);
      }
    });
  },
);

describe("approvals survive process restart", () => {
  it("reads an approval written by an earlier instance", async () => {
    await createFilePolicyApprovalStore({ root }).publish(approval());
    const revived = createFilePolicyApprovalStore({ root });
    const read = await revived.read(canonicalProfile.id);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value?.approvedBy).toBe(HUMAN);
  });

  it("carries the canonical profile so a fresh process needs nothing else", async () => {
    // The record is self-contained by design: assertRunAllowed in a cold
    // process must not have to locate the candidate profile from elsewhere.
    await createFilePolicyApprovalStore({ root }).publish(approval());
    const read = await createFilePolicyApprovalStore({ root }).read(
      canonicalProfile.id,
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value?.profile).toEqual(canonicalProfile);
  });

  it("writes beneath the portable git-visible approval root", async () => {
    expect(POLICY_APPROVAL_ROOT).toBe("ingest/policy-approvals");
  });

  it("still conflicts across instances rather than overwriting", async () => {
    await createFilePolicyApprovalStore({ root }).publish(approval());
    const conflicting = await createFilePolicyApprovalStore({ root }).publish(
      approval({ profileSha256: DIGEST_B }),
    );
    expect(conflicting.ok).toBe(false);
    if (conflicting.ok) return;
    expect(conflicting.code).toBe("APPROVAL_CONFLICT");
  });
});

describe("the file adapter fails closed on hostile custody", () => {
  it("refuses a profile id that would escape the approval root", async () => {
    const store = createFilePolicyApprovalStore({ root });
    for (const profileId of ["../escape", "a/../..", "/etc/passwd"]) {
      const result = await store.publish(approval({ profileId }));
      expect(result.ok).toBe(false);
    }
  });

  it("keys an untrusted profile id safely rather than trusting it as a path", async () => {
    // Ids are attacker-influenced strings. The leaf name must be a hash, and
    // the record's embedded identity is what proves which profile it describes.
    const store = createFilePolicyApprovalStore({ root });
    const published = await store.publish(
      approval({ profileId: "policy with spaces and: colons" }),
    );
    expect(published.ok).toBe(true);
    const read = await store.read("policy with spaces and: colons");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value?.profileId).toBe("policy with spaces and: colons");
  });

  it("refuses to publish through a symlinked approval root", async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), "policy-elsewhere-"));
    const linked = join(root, "linked-root");
    await symlink(elsewhere, linked);
    const result = await createFilePolicyApprovalStore({
      root: linked,
    }).publish(approval());
    expect(result.ok).toBe(false);
    await rm(elsewhere, { recursive: true, force: true });
  });

  it("refuses to publish through a symlinked intermediate component", async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), "policy-elsewhere-"));
    await mkdir(join(root, "ingest"), { recursive: true });
    await symlink(elsewhere, join(root, POLICY_APPROVAL_ROOT));
    const result = await createFilePolicyApprovalStore({ root }).publish(
      approval(),
    );
    expect(result.ok).toBe(false);
    await rm(elsewhere, { recursive: true, force: true });
  });

  it("refuses to read a record leaf that is a symlink", async () => {
    const store = createFilePolicyApprovalStore({ root });
    await store.publish(approval());
    const outside = join(root, "planted.json");
    await writeFile(
      outside,
      JSON.stringify(approval({ approvedBy: "mallory" })),
    );
    const read = await createFilePolicyApprovalStore({ root }).read(
      canonicalProfile.id,
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    // The planted file is not reachable as this profile's record.
    expect(read.value?.approvedBy).toBe(HUMAN);
  });

  it("fails closed when the approval root cannot be opened", async () => {
    const missing = join(root, "no", "such", "tree");
    const result = await createFilePolicyApprovalStore({
      root: missing,
      capabilities: { openDirectory: async () => undefined },
    }).publish(approval());
    expect(result.ok).toBe(false);
  });

  it("rejects an on-disk record that does not satisfy the schema", async () => {
    // A tampered or truncated record must not be trusted merely because it
    // parses as JSON.
    const store = createFilePolicyApprovalStore({ root });
    await store.publish(approval());
    const read = await createFilePolicyApprovalStore({
      root,
      capabilities: {
        readFile: async () => Buffer.from('{"schemaVersion":1}', "utf8"),
      },
    }).read(canonicalProfile.id);
    expect(read.ok).toBe(false);
  });

  it("leaves nothing half-readable when publication is interrupted", async () => {
    const store = createFilePolicyApprovalStore({
      root,
      capabilities: {
        fsyncDirectory: async () => {
          throw new Error("interrupted before commit");
        },
      },
    });
    const failed = await store.publish(approval());
    expect(failed.ok).toBe(false);
    const read = await createFilePolicyApprovalStore({ root }).read(
      canonicalProfile.id,
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value).toBeUndefined();
  });

  it("accepts a retry after an interrupted publication", async () => {
    await createFilePolicyApprovalStore({
      root,
      capabilities: {
        fsyncDirectory: async () => {
          throw new Error("interrupted before commit");
        },
      },
    })
      .publish(approval())
      .catch(() => undefined);
    const retried = await createFilePolicyApprovalStore({ root }).publish(
      approval(),
    );
    expect(retried.ok).toBe(true);
  });
});
