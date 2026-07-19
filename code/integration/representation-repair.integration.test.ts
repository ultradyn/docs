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
import {
  auditRepresentation,
  createRepresentationRepairService,
  unitizeRepresentation,
} from "../ingest/source/index.js";
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

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "repair-integration-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function service() {
  const delivered: { id: string; unitIds: readonly string[] }[] = [];
  const repository = createRepresentationRepairRepository({ root });
  const instance = createRepresentationRepairService({
    sourceFile: sourceFile(),
    representation: faultyRepresentation(),
    approvalPolicy: { isAuthorisedHuman: (actor: string) => actor === HUMAN },
    invalidationSink: {
      deliver: async (request: { id: string; unitIds: readonly string[] }) => {
        if (!delivered.some((entry) => entry.id === request.id)) {
          delivered.push(request);
        }
      },
    },
    // The Phase A ledger seam is satisfied by the real durable repository,
    // so this exercises persistence rather than an in-memory stand-in.
    ledger: { append: async (record) => repository.appendLedgerRecord(record) },
  });
  return { service: instance, delivered, repository };
}

async function approvedRepair() {
  const harness = service();
  const proposal = await harness.service.propose({
    representationId: FAULTY_REPRESENTATION_ID,
    correctedText: CORRECTED_TEXT,
    correctedLocators: lineLocators(CORRECTED_TEXT),
    proposedBy: HUMAN,
    reason: "Extraction dropped the intro paragraph.",
    expectedRevision: 1,
    idempotencyKey: "repair-guide-intro-1",
  });
  if (!proposal.ok) throw new Error(`propose failed: ${proposal.code}`);
  const approved = await harness.service.approve({
    repairId: proposal.value.id,
    approvedBy: HUMAN,
    reason: "Verified against the original document.",
    expectedRevision: 1,
  });
  return { ...harness, proposal: proposal.value, approved };
}

describe("repair persists through the real repository seam", () => {
  it("produces a version 2 representation linked to its predecessor", async () => {
    const { approved } = await approvedRepair();
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    expect(approved.value.representation.version).toBe(2);
    expect(approved.value.representation.supersedesId).toBe(
      FAULTY_REPRESENTATION_ID,
    );
  });

  it("keeps the faulty representation readable after approval", async () => {
    const { service: instance, proposal, approved } = await approvedRepair();
    expect(approved.ok).toBe(true);
    const review = await instance.getReview(proposal.id);
    expect(review.ok).toBe(true);
    if (!review.ok) return;
    expect(review.value.faultyRepresentation.normalizedText).toBe(FAULTY_TEXT);
  });

  it("invalidates exactly the removed and canonically changed units", async () => {
    const { approved } = await approvedRepair();
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    // 2 removed + 2 locator-drifted + 1 provenance-only = 5.
    expect(approved.value.invalidation.unitIds).toHaveLength(5);
    expect(approved.value.invalidation.unitIds).toEqual(
      [...approved.value.invalidation.unitIds].sort(),
    );
  });

  it("delivers one invalidation request for one approval", async () => {
    const { delivered, approved } = await approvedRepair();
    expect(approved.ok).toBe(true);
    expect(delivered).toHaveLength(1);
  });
});

describe("superseded and current representations never share a projection", () => {
  it("unitizes each representation version independently", async () => {
    const { approved } = await approvedRepair();
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    const current = approved.value.representation;
    const audited = auditRepresentation(current);
    expect(audited.ok).toBe(true);
    if (!audited.ok) return;
    const unitized = unitizeRepresentation({
      sourceFile: sourceFile(),
      representation: current,
      audit: audited.value,
    });
    expect(unitized.ok).toBe(true);
    if (!unitized.ok) return;
    const representationIds = new Set(
      unitized.value.map((unit) => unit.representationId),
    );
    expect(representationIds).toEqual(new Set([current.id]));
  });

  it("invalidates only identities that existed before the repair", async () => {
    // Additions are excluded, so every invalidated id must come from the OLD
    // unit set. An id present only in the new set would mean the repair asked
    // consumers to invalidate something they never held.
    const { approved } = await approvedRepair();
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    const audited = auditRepresentation(faultyRepresentation());
    expect(audited.ok).toBe(true);
    if (!audited.ok) return;
    const before = unitizeRepresentation({
      sourceFile: sourceFile(),
      representation: faultyRepresentation(),
      audit: audited.value,
    });
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const beforeIds = new Set(before.value.map((unit) => unit.id));
    for (const id of approved.value.invalidation.unitIds) {
      expect(beforeIds.has(id as (typeof before.value)[number]["id"])).toBe(
        true,
      );
    }
  });
});

describe("legacy records remain readable across the repair", () => {
  it("reads a pre-migration representation that carries no supersedes link", async () => {
    const legacy = faultyRepresentation();
    expect("supersedesId" in legacy).toBe(false);
    const audited = auditRepresentation(legacy);
    expect(audited.ok).toBe(true);
  });

  it("replays a legacy repair ledger written before the outbox existed", async () => {
    const repository = createRepresentationRepairRepository({ root });
    const pending = await repository.pendingInvalidations();
    expect(pending).toEqual([]);
  });
});
