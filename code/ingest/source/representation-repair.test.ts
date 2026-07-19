import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type {
  Sha256,
  SnapshotId,
  SourceFile,
  SourceFileId,
  SourceRepresentation,
  SourceRepresentationId,
} from "../../domain/ingest/index.js";

import { createRepresentationRepairService } from "./representation-repair.js";

function sha256(text: string): Sha256 {
  return createHash("sha256").update(text).digest("hex") as Sha256;
}

const SNAPSHOT_ID = `snap-${"b".repeat(64)}` as SnapshotId;
const SOURCE_FILE_ID = `file-${"a".repeat(64)}` as SourceFileId;
const FAULTY_REPRESENTATION_ID =
  "repr-01ARZ3NDEKTSV4RRFFQ69G5FAV" as SourceRepresentationId;

const FAULTY_TEXT = [
  "# Guide",
  "",
  "Short intro.",
  "",
  "## Stable",
  "",
  "This paragraph never changes.",
  "",
].join("\n");

const CORRECTED_TEXT = [
  "# Guide",
  "",
  "A considerably longer corrected intro paragraph.",
  "",
  "## Stable",
  "",
  "This paragraph never changes.",
  "",
].join("\n");

const HUMAN = "alex.review-1";
const OTHER_HUMAN = "sam.review-2";
const AGENT = "agent:evidence-critic";

function lineLocators(text: string): SourceRepresentation["locatorMap"] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  let offset = 0;
  return lines.map((line, index) => {
    const start = offset;
    const end = start + line.length;
    offset = end + 1;
    const span = {
      utf16Start: start,
      utf16End: end,
      lineStart: index + 1,
      columnStart: 1,
      lineEnd: index + 1,
      columnEnd: line.length + 1,
    };
    return {
      kind: "line" as const,
      normalized: span,
      original: {
        byteStart: start,
        byteEnd: end,
        lineStart: index + 1,
        columnStart: 1,
        lineEnd: index + 1,
        columnEnd: line.length + 1,
      },
    };
  });
}

function faultyRepresentation(): SourceRepresentation {
  return {
    schemaVersion: 1,
    id: FAULTY_REPRESENTATION_ID,
    sourceFileId: SOURCE_FILE_ID,
    version: 1,
    kind: "markdown",
    normalizedText: FAULTY_TEXT,
    locatorMap: lineLocators(FAULTY_TEXT),
    warnings: [],
  };
}

function sourceFile(): SourceFile {
  return {
    schemaVersion: 1,
    id: SOURCE_FILE_ID,
    snapshotId: SNAPSHOT_ID,
    logicalPath: "docs/guide.md",
    mediaType: "text/markdown",
    size: Buffer.byteLength(FAULTY_TEXT),
    sha256: sha256(FAULTY_TEXT),
  };
}

interface DeliveredRequest {
  readonly id: string;
  readonly unitIds: readonly string[];
}

/**
 * Deterministic fakes for the injected system boundaries only. The repository
 * ledger, the approval policy and the delivery sink are seams the plan names;
 * nothing internal is mocked.
 */
function harness(
  options: {
    readonly approvers?: readonly string[];
    readonly failDeliveryTimes?: number;
    readonly failCommit?: boolean;
  } = {},
) {
  const delivered: DeliveredRequest[] = [];
  let deliveryFailuresLeft = options.failDeliveryTimes ?? 0;
  const appended: string[] = [];
  const service = createRepresentationRepairService({
    sourceFile: sourceFile(),
    representation: faultyRepresentation(),
    approvalPolicy: {
      isAuthorisedHuman: (actor: string) =>
        (options.approvers ?? [HUMAN, OTHER_HUMAN]).includes(actor),
    },
    invalidationSink: {
      deliver: async (request: DeliveredRequest) => {
        if (deliveryFailuresLeft > 0) {
          deliveryFailuresLeft -= 1;
          throw new Error("sink unavailable");
        }
        if (!delivered.some((entry) => entry.id === request.id)) {
          delivered.push(request);
        }
      },
    },
    ledger: {
      append: async (record: { readonly kind: string }) => {
        if (options.failCommit && record.kind === "approval") {
          throw new Error("commit failed");
        }
        appended.push(record.kind);
      },
    },
  });
  return { service, delivered, appended };
}

async function propose(
  service: ReturnType<typeof harness>["service"],
  overrides: Record<string, unknown> = {},
) {
  return service.propose({
    representationId: FAULTY_REPRESENTATION_ID,
    correctedText: CORRECTED_TEXT,
    correctedLocators: lineLocators(CORRECTED_TEXT),
    proposedBy: HUMAN,
    reason: "Extraction dropped the intro paragraph.",
    expectedRevision: 1,
    idempotencyKey: "repair-guide-intro-1",
    ...overrides,
  });
}

describe("proposing a representation repair", () => {
  it("creates an immutable proposal without touching the faulty record", async () => {
    const { service } = harness();
    const result = await propose(service);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe("proposed");
    const review = await service.getReview(result.value.id);
    expect(review.ok).toBe(true);
  });

  it("keeps the original faulty bytes readable after a proposal", async () => {
    const { service } = harness();
    const proposal = await propose(service);
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    const review = await service.getReview(proposal.value.id);
    expect(review.ok).toBe(true);
    if (!review.ok) return;
    expect(review.value.faultyRepresentation.normalizedText).toBe(FAULTY_TEXT);
  });

  it("returns the same proposal for a repeated idempotency key", async () => {
    const { service } = harness();
    const first = await propose(service);
    const second = await propose(service);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.id).toBe(first.value.id);
  });

  it("rejects a repeated idempotency key carrying a different payload", async () => {
    const { service } = harness();
    await propose(service);
    const conflicting = await propose(service, {
      reason: "A different rationale entirely.",
    });
    expect(conflicting.ok).toBe(false);
    if (conflicting.ok) return;
    expect(conflicting.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("rejects a stale expected revision", async () => {
    const { service } = harness();
    const result = await propose(service, { expectedRevision: 99 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("REVISION_CONFLICT");
  });

  it("rejects a blank rationale", async () => {
    const { service } = harness();
    const result = await propose(service, { reason: "   " });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_CORRECTION");
  });

  it("never echoes corrected source text in a failure", async () => {
    const { service } = harness();
    const result = await propose(service, { expectedRevision: 99 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).not.toContain(CORRECTED_TEXT);
    expect(result.message).not.toContain("corrected intro paragraph");
  });
});

describe("approval authority is human and injected", () => {
  it("accepts an approval from an authorised human", async () => {
    const { service } = harness();
    const proposal = await propose(service);
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    const approved = await service.approve({
      repairId: proposal.value.id,
      approvedBy: OTHER_HUMAN,
      reason: "Verified against the original document.",
      expectedRevision: 1,
    });
    expect(approved.ok).toBe(true);
  });

  it("refuses an approval from an unauthorised human", async () => {
    const { service } = harness({ approvers: [HUMAN] });
    const proposal = await propose(service);
    if (!proposal.ok) return;
    const approved = await service.approve({
      repairId: proposal.value.id,
      approvedBy: OTHER_HUMAN,
      reason: "Looks fine to me.",
      expectedRevision: 1,
    });
    expect(approved.ok).toBe(false);
    if (approved.ok) return;
    expect(approved.code).toBe("APPROVER_NOT_AUTHORIZED");
  });

  it("refuses an approval from a system actor", async () => {
    const { service } = harness({ approvers: [HUMAN, AGENT] });
    const proposal = await propose(service);
    if (!proposal.ok) return;
    const approved = await service.approve({
      repairId: proposal.value.id,
      approvedBy: AGENT,
      reason: "Automated verification succeeded.",
      expectedRevision: 1,
    });
    // Even when policy lists it, an agent handle can never approve: the
    // human-only rule is a contract invariant, not a policy configuration.
    expect(approved.ok).toBe(false);
    if (approved.ok) return;
    expect(approved.code).toBe("APPROVER_NOT_AUTHORIZED");
  });

  it("checks authority before running the fresh audit", async () => {
    const { service, appended } = harness({ approvers: [HUMAN] });
    const proposal = await propose(service);
    if (!proposal.ok) return;
    await service.approve({
      repairId: proposal.value.id,
      approvedBy: OTHER_HUMAN,
      reason: "Looks fine to me.",
      expectedRevision: 1,
    });
    expect(appended).not.toContain("audit");
    expect(appended).not.toContain("approval");
  });

  it("requires a nonblank approval rationale", async () => {
    const { service } = harness();
    const proposal = await propose(service);
    if (!proposal.ok) return;
    const approved = await service.approve({
      repairId: proposal.value.id,
      approvedBy: OTHER_HUMAN,
      reason: "  ",
      expectedRevision: 1,
    });
    expect(approved.ok).toBe(false);
  });

  it("refuses to approve a stale revision", async () => {
    const { service } = harness();
    const proposal = await propose(service);
    if (!proposal.ok) return;
    const approved = await service.approve({
      repairId: proposal.value.id,
      approvedBy: OTHER_HUMAN,
      reason: "Verified against the original document.",
      expectedRevision: 99,
    });
    expect(approved.ok).toBe(false);
    if (approved.ok) return;
    expect(approved.code).toBe("REVISION_CONFLICT");
  });
});

describe("rejection appends rather than edits", () => {
  it("records a rejection with its rationale", async () => {
    const { service } = harness();
    const proposal = await propose(service);
    if (!proposal.ok) return;
    const rejected = await service.reject({
      repairId: proposal.value.id,
      rejectedBy: HUMAN,
      reason: "The correction drops a table row.",
    });
    expect(rejected.ok).toBe(true);
  });

  it("requires a nonblank rejection rationale", async () => {
    const { service } = harness();
    const proposal = await propose(service);
    if (!proposal.ok) return;
    const rejected = await service.reject({
      repairId: proposal.value.id,
      rejectedBy: HUMAN,
      reason: "",
    });
    expect(rejected.ok).toBe(false);
  });

  it("refuses a rejection from an unauthorised human", async () => {
    const { service, appended } = harness({ approvers: [HUMAN] });
    const proposal = await propose(service);
    if (!proposal.ok) return;
    const rejected = await service.reject({
      repairId: proposal.value.id,
      rejectedBy: OTHER_HUMAN,
      reason: "The correction drops a table row.",
    });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.code).toBe("APPROVER_NOT_AUTHORIZED");
    expect(appended).not.toContain("rejection");
  });

  it("refuses a rejection from an agent even when listed as approver", async () => {
    const { service, appended } = harness({ approvers: [HUMAN, AGENT] });
    const proposal = await propose(service);
    if (!proposal.ok) return;
    const rejected = await service.reject({
      repairId: proposal.value.id,
      rejectedBy: AGENT,
      reason: "Automated rejection.",
    });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.code).toBe("APPROVER_NOT_AUTHORIZED");
    expect(appended).not.toContain("rejection");
  });

  it("refuses to transition a proposal that is already terminal", async () => {
    const { service } = harness();
    const proposal = await propose(service);
    if (!proposal.ok) return;
    await service.reject({
      repairId: proposal.value.id,
      rejectedBy: HUMAN,
      reason: "The correction drops a table row.",
    });
    const approved = await service.approve({
      repairId: proposal.value.id,
      approvedBy: OTHER_HUMAN,
      reason: "Changed my mind.",
      expectedRevision: 1,
    });
    expect(approved.ok).toBe(false);
    if (approved.ok) return;
    expect(approved.code).toBe("ALREADY_TERMINAL");
  });

  it("leaves the original proposal readable after rejection", async () => {
    const { service } = harness();
    const proposal = await propose(service);
    if (!proposal.ok) return;
    await service.reject({
      repairId: proposal.value.id,
      rejectedBy: HUMAN,
      reason: "The correction drops a table row.",
    });
    const review = await service.getReview(proposal.value.id);
    expect(review.ok).toBe(true);
    if (!review.ok) return;
    expect(review.value.proposal.reason).toBe(
      "Extraction dropped the intro paragraph.",
    );
    expect(review.value.rejection?.reason).toBe(
      "The correction drops a table row.",
    );
  });
});

describe("proposer cannot approve their own repair", () => {
  it("refuses self-approval matching the web review contract", async () => {
    const { service, appended } = harness();
    const proposal = await propose(service, { proposedBy: HUMAN });
    if (!proposal.ok) return;
    const approved = await service.approve({
      repairId: proposal.value.id,
      approvedBy: HUMAN,
      reason: "I proposed it and still believe it.",
      expectedRevision: 1,
    });
    expect(approved.ok).toBe(false);
    if (approved.ok) return;
    expect(approved.code).toBe("APPROVER_NOT_AUTHORIZED");
    expect(appended).not.toContain("approval");
  });

  it("allows a different authorised human to approve", async () => {
    const { service } = harness({ approvers: [HUMAN, OTHER_HUMAN] });
    const proposal = await propose(service, { proposedBy: HUMAN });
    if (!proposal.ok) return;
    const approved = await service.approve({
      repairId: proposal.value.id,
      approvedBy: OTHER_HUMAN,
      reason: "Verified against the original document.",
      expectedRevision: 1,
    });
    expect(approved.ok).toBe(true);
  });
});

describe("approval commits atomically and invalidates exactly", () => {
  it("emits an invalidation covering removed and drifted units", async () => {
    const { service, delivered } = harness();
    const proposal = await propose(service);
    if (!proposal.ok) return;
    const approved = await service.approve({
      repairId: proposal.value.id,
      approvedBy: OTHER_HUMAN,
      reason: "Verified against the original document.",
      expectedRevision: 1,
    });
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    expect(approved.value.invalidation.unitIds).toHaveLength(5);
    expect(delivered).toHaveLength(1);
  });

  it("creates version 2 linked to the superseded representation", async () => {
    const { service } = harness();
    const proposal = await propose(service);
    if (!proposal.ok) return;
    const approved = await service.approve({
      repairId: proposal.value.id,
      approvedBy: OTHER_HUMAN,
      reason: "Verified against the original document.",
      expectedRevision: 1,
    });
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    expect(approved.value.representation.version).toBe(2);
    expect(approved.value.representation.supersedesId).toBe(
      FAULTY_REPRESENTATION_ID,
    );
  });

  it("commits nothing when the fresh audit rejects the correction", async () => {
    const { service, appended } = harness();
    const proposal = await propose(service, {
      correctedText: CORRECTED_TEXT,
      correctedLocators: [],
    });
    if (!proposal.ok) return;
    const approved = await service.approve({
      repairId: proposal.value.id,
      approvedBy: OTHER_HUMAN,
      reason: "Verified against the original document.",
      expectedRevision: 1,
    });
    expect(approved.ok).toBe(false);
    if (approved.ok) return;
    expect(approved.code).toBe("AUDIT_REJECTED");
    expect(appended).not.toContain("approval");
  });

  it("exposes no approval or head change when the commit fails", async () => {
    const { service, delivered } = harness({ failCommit: true });
    const proposal = await propose(service);
    if (!proposal.ok) return;
    const approved = await service.approve({
      repairId: proposal.value.id,
      approvedBy: OTHER_HUMAN,
      reason: "Verified against the original document.",
      expectedRevision: 1,
    });
    expect(approved.ok).toBe(false);
    expect(delivered).toHaveLength(0);
    const review = await service.getReview(proposal.value.id);
    expect(review.ok).toBe(true);
    if (!review.ok) return;
    expect(review.value.proposal.state).toBe("proposed");
  });
});

describe("invalidation delivery recovers exactly once", () => {
  it("replays an undelivered request and returns its identity", async () => {
    const { service, delivered } = harness({ failDeliveryTimes: 1 });
    const proposal = await propose(service);
    if (!proposal.ok) return;
    const approved = await service.approve({
      repairId: proposal.value.id,
      approvedBy: OTHER_HUMAN,
      reason: "Verified against the original document.",
      expectedRevision: 1,
    });
    // Delivery failed post-commit, so the repair is still approved.
    expect(approved.ok).toBe(true);
    expect(delivered).toHaveLength(0);
    const recovered = await service.recoverInvalidations();
    expect(recovered.ok).toBe(true);
    if (!recovered.ok || !approved.ok) return;
    expect(recovered.value).toEqual([approved.value.invalidation.id]);
    expect(delivered).toHaveLength(1);
  });

  it("delivers nothing further once every request has landed", async () => {
    const { service, delivered } = harness();
    const proposal = await propose(service);
    if (!proposal.ok) return;
    await service.approve({
      repairId: proposal.value.id,
      approvedBy: OTHER_HUMAN,
      reason: "Verified against the original document.",
      expectedRevision: 1,
    });
    const recovered = await service.recoverInvalidations();
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.value).toEqual([]);
    expect(delivered).toHaveLength(1);
  });

  it("cannot transition repair state", async () => {
    const { service } = harness({ failDeliveryTimes: 1 });
    const proposal = await propose(service);
    if (!proposal.ok) return;
    await service.approve({
      repairId: proposal.value.id,
      approvedBy: OTHER_HUMAN,
      reason: "Verified against the original document.",
      expectedRevision: 1,
    });
    const before = await service.getReview(proposal.value.id);
    await service.recoverInvalidations();
    const after = await service.getReview(proposal.value.id);
    expect(before.ok && after.ok).toBe(true);
    if (!before.ok || !after.ok) return;
    expect(after.value.proposal.state).toBe(before.value.proposal.state);
  });
});
