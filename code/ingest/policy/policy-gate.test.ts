import { describe, expect, it } from "vitest";

import type {
  DataRightsPolicyProfile,
  SnapshotId,
  SourceUnitId,
} from "../../domain/ingest/index.js";

import {
  createInMemoryPolicyApprovalStore,
  createPolicyService,
} from "./index.js";
import { createPolicyGate } from "./policy-gate.js";
import type { UnitAccessRecord } from "./policy-gate.js";
import {
  createFakeAttestationAuthority,
  createFakeUnitAccessResolver,
} from "./testing.js";

const HUMAN = "alex.review-1";
const PRINCIPAL = "session:analyst-7";
const APPROVED_AT = "2026-07-19T08:30:00.000Z";
const SNAPSHOT = `snap-${"a".repeat(52)}` as SnapshotId;
const OTHER_SNAPSHOT = `snap-${"b".repeat(52)}` as SnapshotId;

const baseProfileFields = {
  schemaVersion: 1,
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
  cache: ["profileId", "principalId", "snapshotId"],
  accessClass: "project-members",
  licenceRestrictions: ["no-redistribution"],
  publication: "forbidden",
  maxQuoteBytes: 0,
  maxFiles: 1_000,
  maxFileBytes: 10_000_000,
  maxExpandedBytes: 100_000_000,
} as const;

function profile(
  id: string,
  overrides: Partial<DataRightsPolicyProfile> = {},
): DataRightsPolicyProfile {
  return { ...baseProfileFields, id, ...overrides } as DataRightsPolicyProfile;
}

// The gate resolves a unit to its repository binding: which snapshot it belongs
// to, which policy governs that snapshot, and its logical path for include /
// exclude matching.
function unit(
  logicalPath: string,
  overrides: Partial<UnitAccessRecord> = {},
): UnitAccessRecord {
  return {
    snapshotId: SNAPSHOT,
    policyId: "policy-docs",
    logicalPath,
    ...overrides,
  };
}

function receipt(
  selectedIds: readonly string[],
  candidateIds: readonly string[],
) {
  return {
    schemaVersion: 1 as const,
    id: `rcpt-${"c".repeat(26)}`,
    snapshotId: SNAPSHOT,
    indexVersion: "lexical-1",
    indexedRepresentationsSha256: "d".repeat(64),
    query: "example",
    filters: {},
    candidateIds,
    selectedIds,
    failures: [],
  };
}

function response(selected: readonly string[], candidate: readonly string[]) {
  return {
    selectedIds: selected as readonly SourceUnitId[],
    candidateIds: candidate as readonly SourceUnitId[],
    hits: selected.map((unitId) => ({
      unitId: unitId as SourceUnitId,
      score: 1,
    })),
    receipt: receipt(selected, candidate),
  };
}

async function approve(
  profileValue: DataRightsPolicyProfile,
  eligible: (actor: string) => boolean = (actor) => actor === HUMAN,
) {
  const service = createPolicyService({
    store: createInMemoryPolicyApprovalStore(),
    authority: createFakeAttestationAuthority({
      authorityId: "authority-1",
      eligible,
    }),
    now: () => APPROVED_AT,
  });
  const result = await service.approve({
    profile: profileValue,
    actor: HUMAN,
    reason: "Reviewed for gate tests.",
  });
  if (!result.ok) throw new Error(`approve failed: ${result.code}`);
  return service;
}

function gate(
  service: Awaited<ReturnType<typeof approve>>,
  records: ReadonlyMap<string, UnitAccessRecord>,
) {
  const resolver = createFakeUnitAccessResolver(records);
  return {
    instance: createPolicyGate({ policyService: service, units: resolver }),
    resolver,
  };
}

const RUN_PROFILE = profile("policy-docs");

async function readyGate(records: ReadonlyMap<string, UnitAccessRecord>) {
  return gate(await approve(RUN_PROFILE), records);
}

describe("filterRetrieval drops units before any text is opened", () => {
  it("removes a unit excluded by the profile path rules", async () => {
    const records = new Map<string, UnitAccessRecord>([
      ["u-allowed", unit("docs/guide.md")],
      ["u-private", unit("docs/private/secret.md")],
    ]);
    const { instance } = await readyGate(records);
    const filtered = await instance.filterRetrieval({
      response: response(
        ["u-allowed", "u-private"],
        ["u-allowed", "u-private"],
      ),
      profileId: RUN_PROFILE.id,
      principalId: PRINCIPAL,
    });
    expect(filtered.ok).toBe(true);
    if (!filtered.ok) return;
    expect(filtered.value.selectedIds).toEqual(["u-allowed"]);
    expect(filtered.value.candidateIds).not.toContain("u-private");
    expect(
      filtered.value.hits.map((h: { unitId: SourceUnitId }) => h.unitId),
    ).toEqual(["u-allowed"]);
  });

  it("denies a unit whose snapshot does not match the response receipt", async () => {
    const records = new Map<string, UnitAccessRecord>([
      ["u-foreign", unit("docs/guide.md", { snapshotId: OTHER_SNAPSHOT })],
    ]);
    const { instance } = await readyGate(records);
    const filtered = await instance.filterRetrieval({
      response: response(["u-foreign"], ["u-foreign"]),
      profileId: RUN_PROFILE.id,
      principalId: PRINCIPAL,
    });
    expect(filtered.ok).toBe(true);
    if (!filtered.ok) return;
    expect(filtered.value.selectedIds).toEqual([]);
  });

  it("denies a unit whose snapshot is governed by a different policy", async () => {
    const records = new Map<string, UnitAccessRecord>([
      ["u-otherpolicy", unit("docs/guide.md", { policyId: "policy-other" })],
    ]);
    const { instance } = await readyGate(records);
    const filtered = await instance.filterRetrieval({
      response: response(["u-otherpolicy"], ["u-otherpolicy"]),
      profileId: RUN_PROFILE.id,
      principalId: PRINCIPAL,
    });
    expect(filtered.ok).toBe(true);
    if (!filtered.ok) return;
    expect(filtered.value.selectedIds).toEqual([]);
  });

  it("drops a unit the resolver does not know rather than passing it through", async () => {
    const { instance } = await readyGate(new Map());
    const filtered = await instance.filterRetrieval({
      response: response(["u-unknown"], ["u-unknown"]),
      profileId: RUN_PROFILE.id,
      principalId: PRINCIPAL,
    });
    expect(filtered.ok).toBe(true);
    if (!filtered.ok) return;
    expect(filtered.value.selectedIds).toEqual([]);
  });

  it("fails closed, distinctly, when unit metadata is unavailable", async () => {
    const records = new Map<string, UnitAccessRecord>([
      ["u-allowed", unit("docs/guide.md")],
    ]);
    const { instance, resolver } = await readyGate(records);
    resolver.setUnavailable(true);
    const filtered = await instance.filterRetrieval({
      response: response(["u-allowed"], ["u-allowed"]),
      profileId: RUN_PROFILE.id,
      principalId: PRINCIPAL,
    });
    // Infrastructure outage is not a policy decision, and it is not an empty
    // allow-set either.
    expect(filtered.ok).toBe(false);
    if (filtered.ok) return;
    expect(filtered.code).toBe("UNIT_METADATA_UNAVAILABLE");
  });

  it("returns an empty selection, not a synthetic no-answer, when everything is denied", async () => {
    const records = new Map<string, UnitAccessRecord>([
      ["u-private", unit("docs/private/secret.md")],
    ]);
    const { instance } = await readyGate(records);
    const filtered = await instance.filterRetrieval({
      response: response(["u-private"], ["u-private"]),
      profileId: RUN_PROFILE.id,
      principalId: PRINCIPAL,
    });
    expect(filtered.ok).toBe(true);
    if (!filtered.ok) return;
    expect(filtered.value.selectedIds).toEqual([]);
    // The result is a filtered response, never a T-21 critic verdict.
    expect(filtered.value).not.toHaveProperty("verdict");
    expect(filtered.value).not.toHaveProperty("no_supported_answer");
  });

  it("does not mutate the input response", async () => {
    const records = new Map<string, UnitAccessRecord>([
      ["u-allowed", unit("docs/guide.md")],
      ["u-private", unit("docs/private/secret.md")],
    ]);
    const { instance } = await readyGate(records);
    const input = response(
      ["u-allowed", "u-private"],
      ["u-allowed", "u-private"],
    );
    const snapshot = JSON.stringify(input);
    await instance.filterRetrieval({
      response: input,
      profileId: RUN_PROFILE.id,
      principalId: PRINCIPAL,
    });
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("returns a deep-frozen filtered response", async () => {
    const records = new Map<string, UnitAccessRecord>([
      ["u-allowed", unit("docs/guide.md")],
    ]);
    const { instance } = await readyGate(records);
    const filtered = await instance.filterRetrieval({
      response: response(["u-allowed"], ["u-allowed"]),
      profileId: RUN_PROFILE.id,
      principalId: PRINCIPAL,
    });
    expect(filtered.ok).toBe(true);
    if (!filtered.ok) return;
    expect(Object.isFrozen(filtered.value)).toBe(true);
    expect(Object.isFrozen(filtered.value.selectedIds)).toBe(true);
  });

  it("refuses a blank principal", async () => {
    const records = new Map<string, UnitAccessRecord>([
      ["u-allowed", unit("docs/guide.md")],
    ]);
    const { instance } = await readyGate(records);
    const filtered = await instance.filterRetrieval({
      response: response(["u-allowed"], ["u-allowed"]),
      profileId: RUN_PROFILE.id,
      principalId: "   ",
    });
    expect(filtered.ok).toBe(false);
    if (filtered.ok) return;
    // A blank principal is a caller error, not a policy or authority outcome.
    expect(filtered.code).toBe("ACCESS_DENIED");
  });
});

describe("filterRetrieval requires fresh run authority", () => {
  it("fails closed when the profile was never approved", async () => {
    const service = createPolicyService({
      store: createInMemoryPolicyApprovalStore(),
      authority: createFakeAttestationAuthority({
        authorityId: "authority-1",
        eligible: () => true,
      }),
      now: () => APPROVED_AT,
    });
    const instance = createPolicyGate({
      policyService: service,
      units: createFakeUnitAccessResolver(new Map()),
    });
    const filtered = await instance.filterRetrieval({
      response: response([], []),
      profileId: "policy-never-approved",
      principalId: PRINCIPAL,
    });
    expect(filtered.ok).toBe(false);
    if (filtered.ok) return;
    expect(filtered.code).toBe("POLICY_UNAPPROVED");
  });

  it("fails closed with a distinct code when the authority is unavailable", async () => {
    const service = await approve(RUN_PROFILE);
    const authority = createFakeAttestationAuthority({
      authorityId: "authority-1",
      eligible: () => true,
    });
    authority.setUnavailable(true);
    // A gate wired to an unavailable authority must never allow a run, and the
    // outage must be distinguishable from a deliberate denial.
    const brokenService = createPolicyService({
      store: createInMemoryPolicyApprovalStore(),
      authority,
      now: () => APPROVED_AT,
    });
    const instance = createPolicyGate({
      policyService: brokenService,
      units: createFakeUnitAccessResolver(new Map()),
    });
    const filtered = await instance.filterRetrieval({
      response: response([], []),
      profileId: RUN_PROFILE.id,
      principalId: PRINCIPAL,
    });
    expect(filtered.ok).toBe(false);
    if (filtered.ok) return;
    // An outage is not equivalent to "never approved": the codes must differ so
    // a caller can tell a broken authority from a policy refusal.
    expect(filtered.code).toBe("AUTHORITY_UNAVAILABLE");
    void service;
  });
});

describe("authoriseModel gates provider, region, quote and unit membership", () => {
  const allowed = new Map<string, UnitAccessRecord>([
    ["u-allowed", unit("docs/guide.md")],
  ]);

  it("authorises an allowed provider, region and filtered unit", async () => {
    const { instance } = await readyGate(allowed);
    const result = await instance.authoriseModel({
      profileId: RUN_PROFILE.id,
      principalId: PRINCIPAL,
      provider: "provider:local-whisper",
      region: "local",
      unitIds: ["u-allowed"] as SourceUnitId[],
    });
    expect(result.ok).toBe(true);
  });

  it("denies a provider outside the allow-list", async () => {
    const { instance } = await readyGate(allowed);
    const result = await instance.authoriseModel({
      profileId: RUN_PROFILE.id,
      principalId: PRINCIPAL,
      provider: "provider:openai/gpt",
      region: "local",
      unitIds: ["u-allowed"] as SourceUnitId[],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("PROVIDER_DENIED");
  });

  it("denies a wildcard provider outright", async () => {
    const { instance } = await readyGate(allowed);
    const result = await instance.authoriseModel({
      profileId: RUN_PROFILE.id,
      principalId: PRINCIPAL,
      provider: "*",
      region: "local",
      unitIds: ["u-allowed"] as SourceUnitId[],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("PROVIDER_DENIED");
  });

  it("denies a region outside the allow-list", async () => {
    const { instance } = await readyGate(allowed);
    const result = await instance.authoriseModel({
      profileId: RUN_PROFILE.id,
      principalId: PRINCIPAL,
      provider: "provider:local-whisper",
      region: "us-east-1",
      unitIds: ["u-allowed"] as SourceUnitId[],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("REGION_DENIED");
  });

  it("denies a unit id outside the filtered allow-set", async () => {
    const records = new Map<string, UnitAccessRecord>([
      ["u-allowed", unit("docs/guide.md")],
      ["u-private", unit("docs/private/secret.md")],
    ]);
    const { instance } = await readyGate(records);
    const result = await instance.authoriseModel({
      profileId: RUN_PROFILE.id,
      principalId: PRINCIPAL,
      provider: "provider:local-whisper",
      region: "local",
      unitIds: ["u-private"] as SourceUnitId[],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("ACCESS_DENIED");
  });

  it("denies quote bytes beyond the profile budget", async () => {
    const { instance } = await readyGate(allowed);
    // maxQuoteBytes is 0 on the confidential profile: no text may be quoted.
    const result = await instance.authoriseModel({
      profileId: RUN_PROFILE.id,
      principalId: PRINCIPAL,
      provider: "provider:local-whisper",
      region: "local",
      unitIds: ["u-allowed"] as SourceUnitId[],
      quoteBytes: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("QUOTE_DENIED");
  });

  it("refuses an empty unit set rather than silently authorising a provider", async () => {
    const { instance } = await readyGate(allowed);
    const result = await instance.authoriseModel({
      profileId: RUN_PROFILE.id,
      principalId: PRINCIPAL,
      provider: "provider:local-whisper",
      region: "local",
      unitIds: [] as SourceUnitId[],
    });
    expect(result.ok).toBe(false);
  });

  it("fails closed for an unapproved profile before any provider check", async () => {
    const service = createPolicyService({
      store: createInMemoryPolicyApprovalStore(),
      authority: createFakeAttestationAuthority({
        authorityId: "authority-1",
        eligible: () => true,
      }),
      now: () => APPROVED_AT,
    });
    const instance = createPolicyGate({
      policyService: service,
      units: createFakeUnitAccessResolver(allowed),
    });
    const result = await instance.authoriseModel({
      profileId: "policy-never-approved",
      principalId: PRINCIPAL,
      provider: "provider:local-whisper",
      region: "local",
      unitIds: ["u-allowed"] as SourceUnitId[],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("POLICY_UNAPPROVED");
  });

  it("never leaks a unit id or provider token in a denial message", async () => {
    const { instance } = await readyGate(allowed);
    const result = await instance.authoriseModel({
      profileId: RUN_PROFILE.id,
      principalId: PRINCIPAL,
      provider: "provider:secret-egress-endpoint",
      region: "local",
      unitIds: ["u-allowed"] as SourceUnitId[],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).not.toContain("secret-egress-endpoint");
  });
});

describe("policyNamespace binds the full canonical tuple", () => {
  it("derives a stable namespace for identical inputs", async () => {
    const service = await approve(RUN_PROFILE);
    const { instance } = gate(service, new Map());
    const first = await instance.policyNamespace({
      profileId: RUN_PROFILE.id,
      principalId: PRINCIPAL,
      snapshotId: SNAPSHOT,
    });
    const second = await instance.policyNamespace({
      profileId: RUN_PROFILE.id,
      principalId: PRINCIPAL,
      snapshotId: SNAPSHOT,
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value).toBe(first.value);
  });

  it("produces distinct namespaces for different principals", async () => {
    const service = await approve(RUN_PROFILE);
    const { instance } = gate(service, new Map());
    const a = await instance.policyNamespace({
      profileId: RUN_PROFILE.id,
      principalId: "session:analyst-7",
      snapshotId: SNAPSHOT,
    });
    const b = await instance.policyNamespace({
      profileId: RUN_PROFILE.id,
      principalId: "session:analyst-8",
      snapshotId: SNAPSHOT,
    });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value).not.toBe(b.value);
  });

  it("produces distinct namespaces for different snapshots", async () => {
    const service = await approve(RUN_PROFILE);
    const { instance } = gate(service, new Map());
    const a = await instance.policyNamespace({
      profileId: RUN_PROFILE.id,
      principalId: PRINCIPAL,
      snapshotId: SNAPSHOT,
    });
    const b = await instance.policyNamespace({
      profileId: RUN_PROFILE.id,
      principalId: PRINCIPAL,
      snapshotId: OTHER_SNAPSHOT,
    });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value).not.toBe(b.value);
  });

  it("produces distinct namespaces for two different profiles at the same id-shape", async () => {
    const serviceA = await approve(profile("policy-docs"));
    const serviceB = await approve(
      profile("policy-docs", { retentionDays: 30 }),
    );
    const a = await gate(serviceA, new Map()).instance.policyNamespace({
      profileId: "policy-docs",
      principalId: PRINCIPAL,
      snapshotId: SNAPSHOT,
    });
    const b = await gate(serviceB, new Map()).instance.policyNamespace({
      profileId: "policy-docs",
      principalId: PRINCIPAL,
      snapshotId: SNAPSHOT,
    });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    // Different profile content (digest) must not share a namespace even under
    // the same id, principal and snapshot.
    expect(a.value).not.toBe(b.value);
  });

  it("carries no raw text or query in the namespace token", async () => {
    const service = await approve(RUN_PROFILE);
    const { instance } = gate(service, new Map());
    const result = await instance.policyNamespace({
      profileId: RUN_PROFILE.id,
      principalId: PRINCIPAL,
      snapshotId: SNAPSHOT,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatch(/^[0-9a-z-]+$/u);
    expect(result.value).not.toContain("example");
  });

  it("fails closed for an unapproved profile", async () => {
    const service = createPolicyService({
      store: createInMemoryPolicyApprovalStore(),
      authority: createFakeAttestationAuthority({
        authorityId: "authority-1",
        eligible: () => true,
      }),
      now: () => APPROVED_AT,
    });
    const { instance } = gate(service, new Map());
    const result = await instance.policyNamespace({
      profileId: "policy-never-approved",
      principalId: PRINCIPAL,
      snapshotId: SNAPSHOT,
    });
    expect(result.ok).toBe(false);
  });
});

describe("projectUnitPreview respects access labels and quote budgets", () => {
  it("returns metadata only when the profile permits no quotes", async () => {
    const records = new Map<string, UnitAccessRecord>([
      ["u-allowed", unit("docs/guide.md")],
    ]);
    const { instance } = await readyGate(records);
    const preview = await instance.projectUnitPreview({
      profileId: RUN_PROFILE.id,
      principalId: PRINCIPAL,
      unitId: "u-allowed" as SourceUnitId,
      text: "Confidential body that must not appear in the projection.",
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    // maxQuoteBytes is 0, so the projection is metadata only.
    expect(JSON.stringify(preview.value)).not.toContain("Confidential body");
  });

  it("truncates preview text to the profile quote budget", async () => {
    const quotable = profile("policy-public", {
      dataRightsClass: "public",
      publication: "internal-only",
      licenceRestrictions: [],
      maxQuoteBytes: 8,
    });
    const service = await approve(quotable);
    const records = new Map<string, UnitAccessRecord>([
      ["u-pub", unit("docs/guide.md", { policyId: "policy-public" })],
    ]);
    const { instance } = gate(service, records);
    const preview = await instance.projectUnitPreview({
      profileId: "policy-public",
      principalId: PRINCIPAL,
      unitId: "u-pub" as SourceUnitId,
      text: "0123456789abcdef",
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(JSON.stringify(preview.value)).not.toContain("9abcdef");
  });

  it("denies a preview for a unit outside the run policy", async () => {
    const records = new Map<string, UnitAccessRecord>([
      ["u-otherpolicy", unit("docs/guide.md", { policyId: "policy-other" })],
    ]);
    const { instance } = await readyGate(records);
    const preview = await instance.projectUnitPreview({
      profileId: RUN_PROFILE.id,
      principalId: PRINCIPAL,
      unitId: "u-otherpolicy" as SourceUnitId,
      text: "should not matter",
    });
    expect(preview.ok).toBe(false);
    if (preview.ok) return;
    expect(preview.code).toBe("ACCESS_DENIED");
  });
});

describe("the gate surface is hostile-input safe", () => {
  it("rejects an unknown key on the filter request", async () => {
    const records = new Map<string, UnitAccessRecord>([
      ["u-allowed", unit("docs/guide.md")],
    ]);
    const { instance } = await readyGate(records);
    const filtered = await instance.filterRetrieval({
      response: response(["u-allowed"], ["u-allowed"]),
      profileId: RUN_PROFILE.id,
      principalId: PRINCIPAL,
      force: true,
    } as never);
    expect(filtered.ok).toBe(false);
  });
});

describe("River RED-map additions: fresh authority on every method", () => {
  async function staleGate(records: ReadonlyMap<string, UnitAccessRecord>) {
    // Approve under a fake authority, then rotate it so the attestation the
    // ledger holds is no longer current. A gate that re-verifies on every call
    // must now refuse; a gate that trusted issue-time eligibility would not.
    const authority = createFakeAttestationAuthority({
      authorityId: "authority-1",
      eligible: (actor) => actor === HUMAN,
    });
    const service = createPolicyService({
      store: createInMemoryPolicyApprovalStore(),
      authority,
      now: () => APPROVED_AT,
    });
    const approved = await service.approve({
      profile: RUN_PROFILE,
      actor: HUMAN,
      reason: "Reviewed for gate tests.",
    });
    if (!approved.ok) throw new Error(`approve failed: ${approved.code}`);
    return { ...gate(service, records), authority };
  }

  it("authoriseModel refuses after mid-session authority rotation", async () => {
    const records = new Map<string, UnitAccessRecord>([
      ["u-allowed", unit("docs/guide.md")],
    ]);
    const { instance, authority } = await staleGate(records);
    authority.rotate();
    const result = await instance.authoriseModel({
      profileId: RUN_PROFILE.id,
      principalId: PRINCIPAL,
      provider: "provider:local-whisper",
      region: "local",
      unitIds: ["u-allowed"] as SourceUnitId[],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("APPROVAL_NOT_AUTHENTIC");
  });

  it("filterRetrieval refuses after mid-session actor revocation", async () => {
    const records = new Map<string, UnitAccessRecord>([
      ["u-allowed", unit("docs/guide.md")],
    ]);
    const { instance, authority } = await staleGate(records);
    authority.revoke(HUMAN);
    const filtered = await instance.filterRetrieval({
      response: response(["u-allowed"], ["u-allowed"]),
      profileId: RUN_PROFILE.id,
      principalId: PRINCIPAL,
    });
    expect(filtered.ok).toBe(false);
    if (filtered.ok) return;
    expect(filtered.code).toBe("APPROVAL_NOT_AUTHENTIC");
  });

  it("policyNamespace fails closed distinctly for outage vs never-approved", async () => {
    const authority = createFakeAttestationAuthority({
      authorityId: "authority-1",
      eligible: () => true,
    });
    const service = createPolicyService({
      store: createInMemoryPolicyApprovalStore(),
      authority,
      now: () => APPROVED_AT,
    });
    const unapproved = await gate(service, new Map()).instance.policyNamespace({
      profileId: "policy-never-approved",
      principalId: PRINCIPAL,
      snapshotId: SNAPSHOT,
    });
    expect(unapproved.ok).toBe(false);
    if (unapproved.ok) return;
    expect(unapproved.code).toBe("POLICY_UNAPPROVED");

    const withApproval = await approve(RUN_PROFILE);
    const authority2 = createFakeAttestationAuthority({
      authorityId: "authority-1",
      eligible: () => true,
    });
    authority2.setUnavailable(true);
    const outageService = createPolicyService({
      store: createInMemoryPolicyApprovalStore(),
      authority: authority2,
      now: () => APPROVED_AT,
    });
    const outage = await gate(
      outageService,
      new Map(),
    ).instance.policyNamespace({
      profileId: RUN_PROFILE.id,
      principalId: PRINCIPAL,
      snapshotId: SNAPSHOT,
    });
    expect(outage.ok).toBe(false);
    if (outage.ok) return;
    expect(outage.code).toBe("AUTHORITY_UNAVAILABLE");
    void withApproval;
  });

  it("projectUnitPreview fails closed for an unapproved profile", async () => {
    const authority = createFakeAttestationAuthority({
      authorityId: "authority-1",
      eligible: () => true,
    });
    const service = createPolicyService({
      store: createInMemoryPolicyApprovalStore(),
      authority,
      now: () => APPROVED_AT,
    });
    const preview = await gate(service, new Map()).instance.projectUnitPreview({
      profileId: "policy-never-approved",
      principalId: PRINCIPAL,
      unitId: "u-x" as SourceUnitId,
    });
    expect(preview.ok).toBe(false);
    if (preview.ok) return;
    expect(preview.code).toBe("POLICY_UNAPPROVED");
  });

  // A helper that approves a profile, then hands the gate a broken authority
  // over an empty ledger. Fail-closed ordering means an unavailable authority
  // must surface as an outage regardless of what the ledger holds.
  async function outageGate(records: ReadonlyMap<string, UnitAccessRecord>) {
    const approved = await approve(RUN_PROFILE);
    const authority = createFakeAttestationAuthority({
      authorityId: "authority-1",
      eligible: () => true,
    });
    authority.setUnavailable(true);
    const brokenService = createPolicyService({
      store: createInMemoryPolicyApprovalStore(),
      authority,
      now: () => APPROVED_AT,
    });
    return {
      instance: createPolicyGate({
        policyService: brokenService,
        units: createFakeUnitAccessResolver(records),
      }),
      approved,
    };
  }

  it("authoriseModel fails closed with AUTHORITY_UNAVAILABLE, not a policy code", async () => {
    const { instance } = await outageGate(
      new Map([["u-allowed", unit("docs/guide.md")]]),
    );
    const result = await instance.authoriseModel({
      profileId: RUN_PROFILE.id,
      principalId: PRINCIPAL,
      provider: "provider:local-whisper",
      region: "local",
      unitIds: ["u-allowed"] as SourceUnitId[],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // An unavailable authority must never read as PROVIDER_DENIED / ACCESS_DENIED.
    expect(result.code).toBe("AUTHORITY_UNAVAILABLE");
  });

  it("projectUnitPreview fails closed with AUTHORITY_UNAVAILABLE, not a policy code", async () => {
    const { instance } = await outageGate(
      new Map([["u-allowed", unit("docs/guide.md")]]),
    );
    const preview = await instance.projectUnitPreview({
      profileId: RUN_PROFILE.id,
      principalId: PRINCIPAL,
      unitId: "u-allowed" as SourceUnitId,
      text: "Confidential body that must not appear in any outage path.",
    });
    expect(preview.ok).toBe(false);
    if (preview.ok) return;
    expect(preview.code).toBe("AUTHORITY_UNAVAILABLE");
  });

  it("policyNamespace re-verifies every call: a fresh namespace turns unauthentic after rotation", async () => {
    const { instance, authority } = await staleGate(new Map());
    const first = await instance.policyNamespace({
      profileId: RUN_PROFILE.id,
      principalId: PRINCIPAL,
      snapshotId: SNAPSHOT,
    });
    expect(first.ok).toBe(true);
    authority.rotate();
    const second = await instance.policyNamespace({
      profileId: RUN_PROFILE.id,
      principalId: PRINCIPAL,
      snapshotId: SNAPSHOT,
    });
    // No cached namespace allow may survive a mid-session rotation: the gate
    // must re-verify authenticity on the second call, not reuse the first.
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe("APPROVAL_NOT_AUTHENTIC");
  });

  it("projectUnitPreview re-verifies every call: a fresh preview turns unauthentic after rotation", async () => {
    const records = new Map<string, UnitAccessRecord>([
      ["u-allowed", unit("docs/guide.md")],
    ]);
    const { instance, authority } = await staleGate(records);
    const first = await instance.projectUnitPreview({
      profileId: RUN_PROFILE.id,
      principalId: PRINCIPAL,
      unitId: "u-allowed" as SourceUnitId,
      text: "body",
    });
    expect(first.ok).toBe(true);
    authority.revoke(HUMAN);
    const second = await instance.projectUnitPreview({
      profileId: RUN_PROFILE.id,
      principalId: PRINCIPAL,
      unitId: "u-allowed" as SourceUnitId,
      text: "body",
    });
    // No cached preview allow may survive a mid-session revocation.
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe("APPROVAL_NOT_AUTHENTIC");
  });
});

describe("River RED-map additions: paths, bindings, bounds, passthrough", () => {
  it("denies a unit whose path matches no include rule, not only excludes", async () => {
    const records = new Map<string, UnitAccessRecord>([
      ["u-outside", unit("src/app.ts")],
    ]);
    const { instance } = await readyGate(records);
    const filtered = await instance.filterRetrieval({
      response: response(["u-outside"], ["u-outside"]),
      profileId: RUN_PROFILE.id,
      principalId: PRINCIPAL,
    });
    expect(filtered.ok).toBe(true);
    if (!filtered.ok) return;
    expect(filtered.value.selectedIds).toEqual([]);
  });

  it("binds the policy identity block into the filtered response", async () => {
    const records = new Map<string, UnitAccessRecord>([
      ["u-allowed", unit("docs/guide.md")],
    ]);
    const { instance } = await readyGate(records);
    const filtered = await instance.filterRetrieval({
      response: response(["u-allowed"], ["u-allowed"]),
      profileId: RUN_PROFILE.id,
      principalId: PRINCIPAL,
    });
    expect(filtered.ok).toBe(true);
    if (!filtered.ok) return;
    expect(filtered.value.policy).toMatchObject({
      profileId: RUN_PROFILE.id,
      principalId: PRINCIPAL,
      snapshotId: SNAPSHOT,
    });
    expect(filtered.value.policy.profileSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("records denied units with a reason but never their text or path", async () => {
    const records = new Map<string, UnitAccessRecord>([
      ["u-allowed", unit("docs/guide.md")],
      ["u-private", unit("docs/private/secret.md")],
    ]);
    const { instance } = await readyGate(records);
    const filtered = await instance.filterRetrieval({
      response: response(
        ["u-allowed", "u-private"],
        ["u-allowed", "u-private"],
      ),
      profileId: RUN_PROFILE.id,
      principalId: PRINCIPAL,
    });
    expect(filtered.ok).toBe(true);
    if (!filtered.ok) return;
    const denied = filtered.value.deniedIds;
    expect(denied.map((d: { unitId: string }) => d.unitId)).toContain(
      "u-private",
    );
    expect(JSON.stringify(denied)).not.toContain("secret.md");
  });

  it("pins the exact code for an empty model unit set", async () => {
    const records = new Map<string, UnitAccessRecord>([
      ["u-allowed", unit("docs/guide.md")],
    ]);
    const { instance } = await readyGate(records);
    const result = await instance.authoriseModel({
      profileId: RUN_PROFILE.id,
      principalId: PRINCIPAL,
      provider: "provider:local-whisper",
      region: "local",
      unitIds: [] as SourceUnitId[],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("ACCESS_DENIED");
  });

  it("pins the exact code for a blank principal", async () => {
    const records = new Map<string, UnitAccessRecord>([
      ["u-allowed", unit("docs/guide.md")],
    ]);
    const { instance } = await readyGate(records);
    const result = await instance.authoriseModel({
      profileId: RUN_PROFILE.id,
      principalId: "  ",
      provider: "provider:local-whisper",
      region: "local",
      unitIds: ["u-allowed"] as SourceUnitId[],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("ACCESS_DENIED");
  });

  it("distinguishes a missing model unit (ACCESS_DENIED) from a metadata outage", async () => {
    const { instance, resolver } = await readyGate(new Map());
    const missing = await instance.authoriseModel({
      profileId: RUN_PROFILE.id,
      principalId: PRINCIPAL,
      provider: "provider:local-whisper",
      region: "local",
      unitIds: ["u-gone"] as SourceUnitId[],
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.code).toBe("ACCESS_DENIED");

    resolver.setUnavailable(true);
    const outage = await instance.authoriseModel({
      profileId: RUN_PROFILE.id,
      principalId: PRINCIPAL,
      provider: "provider:local-whisper",
      region: "local",
      unitIds: ["u-gone"] as SourceUnitId[],
    });
    expect(outage.ok).toBe(false);
    if (outage.ok) return;
    expect(outage.code).toBe("UNIT_METADATA_UNAVAILABLE");
  });

  it("rejects a model unit-id list beyond the bound", async () => {
    const { instance } = await readyGate(new Map());
    const huge = Array.from(
      { length: 100_000 },
      (_v, i) => `u-${i}`,
    ) as SourceUnitId[];
    const result = await instance.authoriseModel({
      profileId: RUN_PROFILE.id,
      principalId: PRINCIPAL,
      provider: "provider:local-whisper",
      region: "local",
      unitIds: huge,
    });
    expect(result.ok).toBe(false);
  });

  it("does not read a filter response through hostile array accessors", async () => {
    const records = new Map<string, UnitAccessRecord>([
      ["u-allowed", unit("docs/guide.md")],
    ]);
    const { instance } = await readyGate(records);
    const hostile = response(["u-allowed"], ["u-allowed"]);
    // A getter on the array must not be invoked to smuggle an id past the copy.
    let touched = false;
    Object.defineProperty(hostile.selectedIds as unknown[], 99, {
      enumerable: true,
      get() {
        touched = true;
        return "u-smuggled";
      },
    });
    await instance.filterRetrieval({
      response: hostile,
      profileId: RUN_PROFILE.id,
      principalId: PRINCIPAL,
    });
    expect(touched).toBe(false);
  });
});

describe("search failures are the caller's to pass through, not the gate's", () => {
  it("the gate filters only successful responses and never sees an index outage", async () => {
    // Contract test for River point 3: INDEX_UNAVAILABLE lives on the retrieval
    // Result, outside SearchResponse. The gate receives only a successful
    // response, so a search error must short-circuit BEFORE the gate is called.
    // This models the intended orchestration: on a failed search, filter is not
    // invoked and the original error is preserved unchanged.
    const searchResult = {
      ok: false as const,
      code: "INDEX_UNAVAILABLE" as const,
      message: "index unavailable",
    };
    const records = new Map<string, UnitAccessRecord>();
    const { instance } = await readyGate(records);
    let filterCalled = false;
    const filterIfSearchOk = async () => {
      if (!searchResult.ok) return searchResult;
      filterCalled = true;
      return instance.filterRetrieval({
        response: response([], []),
        profileId: RUN_PROFILE.id,
        principalId: PRINCIPAL,
      });
    };
    const outcome = await filterIfSearchOk();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("INDEX_UNAVAILABLE");
    expect(filterCalled).toBe(false);
  });
});
