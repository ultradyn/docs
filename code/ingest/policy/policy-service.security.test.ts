import { describe, expect, it } from "vitest";

import {
  createInMemoryPolicyApprovalStore,
  createPolicyService,
} from "./index.js";

/**
 * Authority and contract hardening, written against e6ed2a6 in response to the
 * independent security review and the coordinator ruling on prohibited class
 * handling.
 */

const HUMAN = "alex.review-1";
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

const prohibited = {
  ...candidate,
  id: "policy-prohibited-material",
  dataRightsClass: "prohibited",
} as const;

function service(isAuthorisedHuman: (actor: string) => boolean = () => true) {
  return createPolicyService({
    store: createInMemoryPolicyApprovalStore(),
    approvalPolicy: { isAuthorisedHuman },
    now: () => APPROVED_AT,
  });
}

describe("prohibited material is declarable but never approvable", () => {
  it("parses a prohibited profile as a valid declaration", async () => {
    // Explicitly prohibited must be distinguishable from unclassified. A class
    // that cannot parse collapses the two, leaving a gate unable to report WHY
    // it refused.
    const { DataRightsPolicyProfileSchema } =
      await import("../../domain/ingest/index.js");
    expect(DataRightsPolicyProfileSchema.safeParse(prohibited).success).toBe(
      true,
    );
  });

  it("refuses to approve a prohibited profile with a distinct code", async () => {
    const result = await service().approve({
      profile: prohibited as never,
      actor: HUMAN,
      reason: "Attempting to approve prohibited material.",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("PROFILE_PROHIBITED");
  });

  it("writes no approval record for a prohibited profile", async () => {
    const instance = service();
    await instance.approve({
      profile: prohibited as never,
      actor: HUMAN,
      reason: "Attempting to approve prohibited material.",
    });
    const allowed = await instance.assertRunAllowed(prohibited.id);
    expect(allowed.ok).toBe(false);
    if (allowed.ok) return;
    expect(allowed.code).toBe("POLICY_UNAPPROVED");
  });

  it("never returns a prohibited profile as run allowed", async () => {
    const instance = service();
    await instance.approve({
      profile: prohibited as never,
      actor: HUMAN,
      reason: "Attempting to approve prohibited material.",
    });
    const allowed = await instance.assertRunAllowed(prohibited.id);
    expect(allowed.ok).toBe(false);
  });
});

describe("approver identity is normalised before it is judged or recorded", () => {
  const evasions = [
    [" agent:sneaky", "leading space"],
    ["\tbot:sneaky", "leading tab"],
    ["AGENT:sneaky", "uppercase"],
    ["agent​:sneaky", "zero width space"],
  ] as const;

  it.each(evasions)(
    "refuses %s (%s) when the seam is permissive",
    async (actor) => {
      // The prefix check is defence in depth over the authority seam, but a
      // denylist applied to an unnormalised string is defeated by whitespace and
      // invisible characters. Normalise once, then judge.
      const result = await service(() => true).approve({
        profile: candidate as never,
        actor,
        reason: "Self approval attempt.",
      });
      expect(result.ok).toBe(false);
    },
  );

  it("records the same actor string the authority was asked about", async () => {
    // A trimmed parse plus a raw persist means the recorded approver can differ
    // from the identity that was actually authorised.
    const seen: string[] = [];
    const result = await service((actor) => {
      seen.push(actor);
      return true;
    }).approve({
      profile: candidate as never,
      actor: ` ${HUMAN} `,
      reason: "Approved with untrimmed handle.",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.approvedBy).toBe(seen[0]);
  });
});

describe("the service honours the never-throw result contract", () => {
  it("does not throw when its methods are destructured", async () => {
    // Destructuring a service object is idiomatic here, and the store's methods
    // survive it. A method depending on `this` breaks that symmetry and throws
    // on the approval path, where the module promises a typed Result instead.
    const { approve } = service();
    await expect(
      approve({
        profile: candidate as never,
        actor: HUMAN,
        reason: "Destructured call.",
      }),
    ).resolves.toBeDefined();
  });

  it("does not throw when assertRunAllowed is destructured", async () => {
    const { assertRunAllowed } = service();
    await expect(assertRunAllowed(candidate.id)).resolves.toBeDefined();
  });
});
