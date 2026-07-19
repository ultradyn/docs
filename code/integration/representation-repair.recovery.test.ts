import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  Sha256,
  SnapshotId,
  SourceFile,
  SourceFileId,
  SourceRepresentation,
  SourceRepresentationId,
} from "../domain/ingest/index.js";
import { InvalidationRequestSchema } from "../domain/ingest/index.js";
import { createRepresentationRepairService } from "../ingest/source/index.js";
import { createRepresentationRepairRepository } from "../repository/representation-repair-repository.js";

const HUMAN = "alex.review-1";
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

function sha256(text: string): Sha256 {
  return createHash("sha256").update(text).digest("hex") as Sha256;
}

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

function baseOptions(root: string, deliver: (request: unknown) => void) {
  const repository = createRepresentationRepairRepository({ root });
  return {
    repository,
    // The Phase A ledger seam is backed by the real durable repository so a
    // revived service can find the outbox from persisted state alone.
    ledger: {
      append: async (record: { readonly kind: string }) =>
        repository.appendLedgerRecord(record),
    },
    invalidationOutbox: {
      pending: async () =>
        (await repository.readPendingInvalidations()).map((request) =>
          InvalidationRequestSchema.parse(request),
        ),
      acknowledge: async (id: string) => repository.acknowledgeInvalidation(id),
    },
    sourceFile: {
      schemaVersion: 1,
      id: SOURCE_FILE_ID,
      snapshotId: SNAPSHOT_ID,
      logicalPath: "docs/guide.md",
      mediaType: "text/markdown",
      size: Buffer.byteLength(FAULTY_TEXT),
      sha256: sha256(FAULTY_TEXT),
    } satisfies SourceFile,
    representation: {
      schemaVersion: 1,
      id: FAULTY_REPRESENTATION_ID,
      sourceFileId: SOURCE_FILE_ID,
      version: 1,
      kind: "markdown",
      normalizedText: FAULTY_TEXT,
      locatorMap: lineLocators(FAULTY_TEXT),
      warnings: [],
    } satisfies SourceRepresentation,
    approvalPolicy: { isAuthorisedHuman: (actor: string) => actor === HUMAN },
    invalidationSink: { deliver: async (request: unknown) => deliver(request) },
  };
}

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "repair-recovery-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function approveWithFailingSink(failures: number) {
  const delivered: unknown[] = [];
  let left = failures;
  const options = baseOptions(root, (request) => {
    if (left > 0) {
      left -= 1;
      throw new Error("sink unavailable");
    }
    delivered.push(request);
  });
  const instance = createRepresentationRepairService({
    ledger: options.ledger,
    invalidationOutbox: options.invalidationOutbox,
    sourceFile: options.sourceFile,
    representation: options.representation,
    approvalPolicy: options.approvalPolicy,
    invalidationSink: options.invalidationSink,
  });
  const proposal = await instance.propose({
    representationId: FAULTY_REPRESENTATION_ID,
    correctedText: CORRECTED_TEXT,
    correctedLocators: lineLocators(CORRECTED_TEXT),
    proposedBy: HUMAN,
    reason: "Extraction dropped the intro paragraph.",
    expectedRevision: 1,
    idempotencyKey: "repair-guide-intro-1",
  });
  if (!proposal.ok) throw new Error(`propose failed: ${proposal.code}`);
  const approved = await instance.approve({
    repairId: proposal.value.id,
    approvedBy: HUMAN,
    reason: "Verified against the original document.",
    expectedRevision: 1,
  });
  return { instance, delivered, proposal: proposal.value, approved, options };
}

describe("post-commit delivery failure leaves the approval committed", () => {
  it("still reports the repair approved when the sink is down", async () => {
    const { approved } = await approveWithFailingSink(1);
    // The commit point is the atomic append, not the delivery. A sink outage
    // must never roll an approval back.
    expect(approved.ok).toBe(true);
  });

  it("leaves the request pending in the outbox", async () => {
    const { options } = await approveWithFailingSink(1);
    const pending = await options.repository.pendingInvalidations();
    expect(pending).toHaveLength(1);
  });

  it("does not deliver while the sink is failing", async () => {
    const { delivered } = await approveWithFailingSink(1);
    expect(delivered).toHaveLength(0);
  });
});

describe("recovery replays undelivered requests exactly once", () => {
  it("returns the exact recovered request identities", async () => {
    const { instance, approved } = await approveWithFailingSink(1);
    const recovered = await instance.recoverInvalidations();
    expect(recovered.ok && approved.ok).toBe(true);
    if (!recovered.ok || !approved.ok) return;
    expect(recovered.value).toEqual([approved.value.invalidation.id]);
  });

  it("delivers the request exactly once across repeated recoveries", async () => {
    const { instance, delivered } = await approveWithFailingSink(1);
    await instance.recoverInvalidations();
    await instance.recoverInvalidations();
    await instance.recoverInvalidations();
    expect(delivered).toHaveLength(1);
  });

  it("returns an empty list once nothing is pending", async () => {
    const { instance } = await approveWithFailingSink(1);
    await instance.recoverInvalidations();
    const again = await instance.recoverInvalidations();
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value).toEqual([]);
  });

  it("survives a sink that fails repeatedly before succeeding", async () => {
    const { instance, delivered } = await approveWithFailingSink(3);
    await instance.recoverInvalidations();
    await instance.recoverInvalidations();
    await instance.recoverInvalidations();
    expect(delivered).toHaveLength(1);
  });

  it("recovers across a fresh service bound to the same repository", async () => {
    // Simulates a crash: the process that approved is gone, and a new service
    // instance must find and drain the outbox from durable state alone.
    const { delivered } = await approveWithFailingSink(1);
    const options = baseOptions(root, (request) => delivered.push(request));
    const revived = createRepresentationRepairService({
      ledger: options.ledger,
      invalidationOutbox: options.invalidationOutbox,
      sourceFile: options.sourceFile,
      representation: options.representation,
      approvalPolicy: options.approvalPolicy,
      invalidationSink: options.invalidationSink,
    });
    const recovered = await revived.recoverInvalidations();
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.value).toHaveLength(1);
    expect(delivered).toHaveLength(1);
  });

  it("cannot transition repair state", async () => {
    const { instance, proposal } = await approveWithFailingSink(1);
    const before = await instance.getReview(proposal.id);
    await instance.recoverInvalidations();
    const after = await instance.getReview(proposal.id);
    expect(before.ok && after.ok).toBe(true);
    if (!before.ok || !after.ok) return;
    expect(after.value.proposal.state).toBe(before.value.proposal.state);
  });

  it("carries the same unit identities the approval computed", async () => {
    const { instance, delivered, approved } = await approveWithFailingSink(1);
    await instance.recoverInvalidations();
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    expect(delivered).toHaveLength(1);
    expect((delivered[0] as { unitIds: readonly string[] }).unitIds).toEqual(
      approved.value.invalidation.unitIds,
    );
  });
});
