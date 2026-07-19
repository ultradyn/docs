import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { canonicalDataRightsPolicyProfile } from "../../domain/ingest/index.js";

import {
  POLICY_APPROVAL_ROOT,
  createFilePolicyApprovalStore,
  createInMemoryPolicyApprovalStore,
} from "./index.js";

/**
 * Adversarial custody suite, written against e6ed2a6 in response to the
 * independent security review. Each case corresponds to a finding that the
 * original suite missed, several because a test asserted the behaviour the
 * author intended rather than the behaviour the code had.
 */

const HUMAN = "alex.review-1";
const APPROVED_AT = "2026-07-19T07:30:00.000Z";

const baseProfile = {
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

const hostileProfile = {
  ...baseProfile,
  allowedProviders: ["provider:exfil-endpoint"],
  maxQuoteBytes: 10_000_000,
  licenceRestrictions: [],
} as const;

function digestOf(profile: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonicalDataRightsPolicyProfile(
          profile as Parameters<typeof canonicalDataRightsPolicyProfile>[0],
        ),
      ),
      "utf8",
    )
    .digest("hex");
}

function approvalFor(
  profile: unknown,
  overrides: Record<string, unknown> = {},
) {
  return {
    schemaVersion: 1 as const,
    profileId: (profile as { id: string }).id,
    profile,
    profileSha256: digestOf(profile),
    approvedBy: HUMAN,
    approvedAt: APPROVED_AT,
    reason: "Reviewed against the source licence.",
    ...overrides,
  };
}

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "policy-security-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function leafFor(profileId: string): string {
  return join(
    root,
    POLICY_APPROVAL_ROOT,
    `${createHash("sha256").update(profileId, "utf8").digest("hex")}.json`,
  );
}

describe("a record must authenticate its own contents", () => {
  it("refuses an approval whose digest does not commit to its profile", async () => {
    // Without this, the digest is a free-text field and the sole discriminator
    // between "replayed" and "conflict" proves nothing about what was approved.
    const forged = approvalFor(hostileProfile, {
      profileSha256: digestOf(baseProfile),
    });
    const store = createInMemoryPolicyApprovalStore();
    const result = await store.publish(forged as never);
    expect(result.ok).toBe(false);
  });

  it("refuses a planted on-disk record whose digest commits to another profile", async () => {
    // The attack the review found: plant a hostile profile carrying the
    // LEGITIMATE profile's digest. The human then approves the legitimate
    // profile, digests appear to match, publish reports a replay, and the
    // read-back hands the caller the attacker's payload as an approved record.
    await mkdir(join(root, POLICY_APPROVAL_ROOT), { recursive: true });
    await writeFile(
      leafFor(baseProfile.id),
      JSON.stringify(
        approvalFor(hostileProfile, {
          profileId: baseProfile.id,
          profile: { ...hostileProfile, id: baseProfile.id },
          profileSha256: digestOf(baseProfile),
        }),
      ),
    );

    const store = createFilePolicyApprovalStore({ root });
    const published = await store.publish(approvalFor(baseProfile) as never);
    if (published.ok) {
      const read = await store.read(baseProfile.id);
      expect(read.ok).toBe(true);
      if (!read.ok || !read.value) return;
      // If a replay was accepted, the stored profile must still be the
      // legitimate one, never the plant.
      expect(read.value.profile.allowedProviders).toEqual(
        baseProfile.allowedProviders,
      );
      expect(read.value.profile.maxQuoteBytes).toBe(0);
    } else {
      expect(published.code).not.toBe("APPROVAL_CONFLICT");
    }
  });
});

describe("staging cannot be pre-empted by a planted file", () => {
  it("never renames staged bytes it did not author", async () => {
    // The original guard skipped the write when a staged file already existed
    // and renamed it regardless of contents. Every component of the record is
    // predictable, so the staged name is guessable.
    await mkdir(join(root, POLICY_APPROVAL_ROOT), { recursive: true });
    const legitimate = approvalFor(baseProfile);
    const bytes = `${JSON.stringify(legitimate, null, 2)}\n`;
    const stagedName = `${leafFor(baseProfile.id)}.${createHash("sha256")
      .update(bytes, "utf8")
      .digest("hex")
      .slice(0, 16)}.staged`;

    const plant = approvalFor(hostileProfile, {
      profileId: baseProfile.id,
      profile: { ...hostileProfile, id: baseProfile.id },
    });
    await writeFile(stagedName, JSON.stringify(plant, null, 2));

    const store = createFilePolicyApprovalStore({ root });
    const published = await store.publish(legitimate as never);
    expect(published.ok).toBe(true);

    const stored = JSON.parse(await readFile(leafFor(baseProfile.id), "utf8"));
    expect(stored.profile.allowedProviders).toEqual(
      baseProfile.allowedProviders,
    );
    expect(stored.profile.maxQuoteBytes).toBe(0);
  });
});

describe("publication cannot silently overwrite an existing record", () => {
  it("refuses to replace a record already at the final path", async () => {
    // fs.rename clobbers. The read-then-rename sequence is separated by several
    // awaits, so a concurrent publisher can land between them and the second
    // write wins silently — the retargeting the store exists to prevent.
    const store = createFilePolicyApprovalStore({ root });
    const first = await store.publish(approvalFor(baseProfile) as never);
    expect(first.ok).toBe(true);

    const changed = { ...baseProfile, retentionDays: 30 };
    const second = await store.publish(approvalFor(changed) as never);
    expect(second.ok).toBe(false);

    const stored = JSON.parse(await readFile(leafFor(baseProfile.id), "utf8"));
    expect(stored.profile.retentionDays).toBe(365);
  });

  it("survives two concurrent publishes of different content", async () => {
    const store = createFilePolicyApprovalStore({ root });
    const [a, b] = await Promise.all([
      store.publish(approvalFor(baseProfile) as never),
      store.publish(
        approvalFor({ ...baseProfile, retentionDays: 30 }) as never,
      ),
    ]);
    // Exactly one may win; the loser must be refused, never silently dropped.
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const stored = JSON.parse(await readFile(leafFor(baseProfile.id), "utf8"));
    expect([365, 30]).toContain(stored.profile.retentionDays);
  });
});

describe("the record leaf itself is opened without following links", () => {
  it("refuses to read a record leaf that is genuinely a symlink", async () => {
    // The original test of this name planted a REGULAR file elsewhere and
    // asserted the legitimate record was still returned, so it exercised
    // nothing. This one plants an actual symlink at the leaf path.
    await mkdir(join(root, POLICY_APPROVAL_ROOT), { recursive: true });
    const outside = join(root, "attacker-controlled.json");
    await writeFile(
      outside,
      JSON.stringify(
        approvalFor(hostileProfile, {
          profileId: baseProfile.id,
          profile: { ...hostileProfile, id: baseProfile.id },
          profileSha256: digestOf({ ...hostileProfile, id: baseProfile.id }),
        }),
      ),
    );
    await symlink(outside, leafFor(baseProfile.id));

    const read = await createFilePolicyApprovalStore({ root }).read(
      baseProfile.id,
    );
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.code).toBe("CUSTODY_UNAVAILABLE");
  });

  it("refuses a record leaf that is not a regular file", async () => {
    await mkdir(leafFor(baseProfile.id), { recursive: true });
    const read = await createFilePolicyApprovalStore({ root }).read(
      baseProfile.id,
    );
    expect(read.ok).toBe(false);
  });
});

describe("hostile profile ids cannot reach the filesystem", () => {
  it("creates no file outside the approval directory for an escaping id", async () => {
    // The original escape test was rejected by the identity refinement, never
    // by path logic, so it asserted nothing about escape. This one checks the
    // filesystem directly.
    const store = createFilePolicyApprovalStore({ root });
    for (const hostileId of ["../escape", "a/../..", "/etc/passwd"]) {
      await store.publish(
        approvalFor({ ...baseProfile, id: hostileId }) as never,
      );
    }
    // Only the approval directory may exist beneath the root.
    expect((await readdir(root)).sort()).toEqual(["ingest"]);
    const leaves = await readdir(join(root, POLICY_APPROVAL_ROOT));
    for (const leaf of leaves) {
      expect(leaf).toMatch(/^[0-9a-f]{64}\.json$/u);
    }
  });

  it("keys a hostile id by hash and proves identity from the record", async () => {
    const hostileId = "../../etc/passwd";
    const store = createFilePolicyApprovalStore({ root });
    const published = await store.publish(
      approvalFor({ ...baseProfile, id: hostileId }) as never,
    );
    expect(published.ok).toBe(true);
    const read = await store.read(hostileId);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value?.profileId).toBe(hostileId);
  });
});

describe("records handed out cannot be mutated at any depth", () => {
  it("refuses nested mutation of a returned approval", async () => {
    // Object.freeze is shallow. Both original immutability tests asserted only
    // Object.isFrozen on the top level, which stays true while every nested
    // array and object remains writable.
    const store = createInMemoryPolicyApprovalStore();
    await store.publish(approvalFor(baseProfile) as never);
    const read = await store.read(baseProfile.id);
    expect(read.ok).toBe(true);
    if (!read.ok || !read.value) return;

    expect(Object.isFrozen(read.value.profile)).toBe(true);
    expect(Object.isFrozen(read.value.profile.include)).toBe(true);
    expect(() => {
      (read.value!.profile.include as string[]).push("**/*");
    }).toThrow();
    expect(read.value.profile.include).toEqual(baseProfile.include);
  });
});

describe("custody failures do not disclose paths or record contents", () => {
  it("does not echo record bytes when a stored record is not JSON", async () => {
    await mkdir(join(root, POLICY_APPROVAL_ROOT), { recursive: true });
    await writeFile(
      leafFor(baseProfile.id),
      "s3cr3t-api-key-material-not-json",
    );
    const read = await createFilePolicyApprovalStore({ root }).read(
      baseProfile.id,
    );
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.message).not.toContain("s3cr3t");
  });

  it("does not disclose the absolute record path in a failure message", async () => {
    // Publish first: without an existing tree the store correctly reports
    // absence, and the failure path under test is never reached.
    await createFilePolicyApprovalStore({ root }).publish(
      approvalFor(baseProfile) as never,
    );
    const read = await createFilePolicyApprovalStore({
      root,
      capabilities: {
        readFile: async () => {
          throw Object.assign(new Error(`EACCES: open '${leafFor("x")}'`), {
            code: "EACCES",
          });
        },
      },
    }).read(baseProfile.id);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.message).not.toContain(root);
  });
});

describe("a swapped custody root is detected rather than silently obeyed", () => {
  it("reports tampering when the approval directory is removed mid-life", async () => {
    // Distinct from a fresh checkout: the root exists, so a missing approval
    // subdirectory after we have written to it is a signal, not an absence.
    const store = createFilePolicyApprovalStore({ root });
    await store.publish(approvalFor(baseProfile) as never);
    await rm(join(root, POLICY_APPROVAL_ROOT), {
      recursive: true,
      force: true,
    });
    const read = await store.read(baseProfile.id);
    expect(read.ok).toBe(false);
  });

  it("leaves no file outside the root when the leaf directory is relinked", async () => {
    const attacker = await mkdtemp(join(tmpdir(), "policy-attacker-"));
    await mkdir(join(root, "ingest"), { recursive: true });
    await symlink(attacker, join(root, POLICY_APPROVAL_ROOT));
    const published = await createFilePolicyApprovalStore({ root }).publish(
      approvalFor(baseProfile) as never,
    );
    expect(published.ok).toBe(false);
    expect(await readdir(attacker)).toEqual([]);
    expect(
      (await lstat(join(root, POLICY_APPROVAL_ROOT))).isSymbolicLink(),
    ).toBe(true);
    await rm(attacker, { recursive: true, force: true });
  });
});
