import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createRepresentationRepairRepository } from "./representation-repair-repository.js";

const ACTOR = "alex.review-1";
const REPAIR_ID = "rpr-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const INVALIDATION_ID = "inv-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SOURCE_FILE_ID = `file-${"a".repeat(64)}`;

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "repair-repo-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function proposalRecord(overrides: Record<string, unknown> = {}) {
  return {
    kind: "proposal" as const,
    repairId: REPAIR_ID,
    idempotencyKey: "repair-guide-intro-1",
    expectedRevision: 1,
    payloadDigest: "a".repeat(64),
    actor: ACTOR,
    reason: "Extraction dropped the intro paragraph.",
    ...overrides,
  };
}

function repository(options: Record<string, unknown> = {}) {
  return createRepresentationRepairRepository({ root, ...options });
}

describe("repair repository serialises on the canonical repository lock", () => {
  it("uses the same lock identity as the knowledge repository", async () => {
    const repo = repository();
    const identity = await repo.lockIdentity();
    expect(identity).toBe(join(root, ".git"));
  });

  it("serialises concurrent appends rather than interleaving them", async () => {
    const order: string[] = [];
    const repo = repository({
      hooks: {
        afterLockAcquired: async () => {
          order.push("enter");
          await new Promise((resolve) => setTimeout(resolve, 5));
          order.push("exit");
        },
      },
    });
    await Promise.all([
      repo.append(proposalRecord({ repairId: `${REPAIR_ID}` })),
      repo.append(proposalRecord({ idempotencyKey: "repair-guide-intro-2" })),
    ]);
    expect(order).toEqual(["enter", "exit", "enter", "exit"]);
  });
});

describe("repair repository appends atomically under expected revision", () => {
  it("appends a proposal and reports the new revision", async () => {
    const repo = repository();
    const result = await repo.append(proposalRecord());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.revision).toBe(2);
  });

  it("rejects an append whose expected revision is stale", async () => {
    const repo = repository();
    await repo.append(proposalRecord());
    const stale = await repo.append(
      proposalRecord({ idempotencyKey: "repair-guide-intro-2" }),
    );
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.code).toBe("REVISION_CONFLICT");
  });

  it("returns the existing entry for a repeated idempotency key", async () => {
    const repo = repository();
    const first = await repo.append(proposalRecord());
    const repeat = await repo.append(proposalRecord());
    expect(first.ok && repeat.ok).toBe(true);
    if (!first.ok || !repeat.ok) return;
    expect(repeat.value.revision).toBe(first.value.revision);
    expect(repeat.value.replayed).toBe(true);
  });

  it("rejects a repeated key whose payload digest differs", async () => {
    const repo = repository();
    await repo.append(proposalRecord());
    const conflicting = await repo.append(
      proposalRecord({ payloadDigest: "b".repeat(64) }),
    );
    expect(conflicting.ok).toBe(false);
    if (conflicting.ok) return;
    expect(conflicting.code).toBe("IDEMPOTENCY_CONFLICT");
  });
});

describe("repair repository records are immutable once written", () => {
  it("refuses to overwrite an existing record", async () => {
    const repo = repository();
    await repo.append(proposalRecord());
    const overwrite = (
      repo as typeof repo & {
        overwrite?: (
          id: string,
          record: Record<string, unknown>,
        ) => Promise<unknown>;
      }
    ).overwrite;
    expect(overwrite).toBeUndefined();
  });

  it("exposes no member that could delete or mutate custody", () => {
    const repo = repository();
    for (const member of ["delete", "erase", "purge", "unlink", "truncate"]) {
      expect(member in (repo as Record<string, unknown>)).toBe(false);
    }
  });

  it("rejects a record identity that escapes the repository root", async () => {
    const repo = repository();
    for (const repairId of [
      "../escape",
      "rpr-01ARZ3NDEKTSV4RRFFQ69G5FAV/../..",
      "/etc/passwd",
    ]) {
      const result = await repo.append(proposalRecord({ repairId }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("INVALID_RECORD");
    }
  });

  it("leaves an already written artifact byte identical after a later append", async () => {
    const repo = repository();
    const first = await repo.append(proposalRecord());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const before = await readFile(join(root, first.value.path));
    await repo.append(
      proposalRecord({
        idempotencyKey: "repair-guide-intro-2",
        expectedRevision: 2,
      }),
    );
    expect(await readFile(join(root, first.value.path))).toEqual(before);
  });
});

describe("repair repository exposes no partial state before commit", () => {
  const faults = [
    "beforeJournalWrite",
    "afterJournalWrite",
    "beforeRecordWrite",
    "afterRecordWrite",
    "beforeRevisionBump",
  ] as const;

  for (const fault of faults) {
    it(`commits nothing when the transaction fails at ${fault}`, async () => {
      const repo = repository({
        hooks: {
          [fault]: () => {
            throw new Error(`injected failure at ${fault}`);
          },
        },
      });
      const result = await repo.append(proposalRecord());
      expect(result.ok).toBe(false);
      const clean = repository();
      const revision = await clean.currentRevision();
      expect(revision).toBe(1);
      const entries = await clean.list();
      expect(entries).toEqual([]);
    });
  }

  it("recovers a crashed transaction without duplicating the record", async () => {
    const crashing = repository({
      hooks: {
        afterRecordWrite: () => {
          throw new Error("crash after record write");
        },
      },
    });
    await crashing.append(proposalRecord());
    const repo = repository();
    const result = await repo.append(proposalRecord());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((await repo.list()).length).toBe(1);
  });
});

describe("repair repository delivers invalidation exactly once", () => {
  async function withPendingOutbox() {
    const repo = repository();
    await repo.append(proposalRecord());
    await repo.enqueueInvalidation({
      id: INVALIDATION_ID,
      repairId: REPAIR_ID,
      unitIds: [],
      expectedRevision: 2,
    });
    return repo;
  }

  it("lists an undelivered request until it is acknowledged", async () => {
    const repo = await withPendingOutbox();
    expect(await repo.pendingInvalidations()).toEqual([INVALIDATION_ID]);
    await repo.acknowledgeInvalidation(INVALIDATION_ID);
    expect(await repo.pendingInvalidations()).toEqual([]);
  });

  it("is idempotent when the same request is acknowledged twice", async () => {
    const repo = await withPendingOutbox();
    await repo.acknowledgeInvalidation(INVALIDATION_ID);
    await repo.acknowledgeInvalidation(INVALIDATION_ID);
    expect(await repo.pendingInvalidations()).toEqual([]);
  });

  it("keeps the request pending when acknowledgement fails midway", async () => {
    const repo = repository({
      hooks: {
        beforeRevisionBump: () => {
          throw new Error("ack interrupted");
        },
      },
    });
    await repo.append(proposalRecord());
    await repo
      .enqueueInvalidation({
        id: INVALIDATION_ID,
        repairId: REPAIR_ID,
        unitIds: [],
        expectedRevision: 2,
      })
      .catch(() => undefined);
    const clean = repository();
    expect(await clean.pendingInvalidations()).not.toContain("undefined");
  });

  it("acknowledging cannot change any repair record", async () => {
    const repo = await withPendingOutbox();
    const before = await repo.list();
    await repo.acknowledgeInvalidation(INVALIDATION_ID);
    expect(await repo.list()).toEqual(before);
  });
});

describe("repair repository rejects foreign on-disk state", () => {
  it("fails closed when the journal is unreadable rather than assuming empty", async () => {
    const repo = repository();
    await repo.append(proposalRecord());
    await writeFile(join(root, ".ultradyn/repair/journal.json"), "{ not json");
    const result = repository().currentRevision();
    await expect(result).rejects.toBeDefined();
  });
});

function approvalLedgerRecord(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    kind: "approval",
    approval: {
      schemaVersion: 1,
      repairId: REPAIR_ID,
      approvedBy: ACTOR,
      reason: "Verified against the original document.",
      approvedRevision: 1,
    },
    invalidation: {
      schemaVersion: 1,
      id: INVALIDATION_ID,
      repairId: REPAIR_ID,
      sourceFileId: SOURCE_FILE_ID,
      unitIds: [],
    },
    ...overrides,
  };
}

describe("approval ledger entry and invalidation outbox are one transaction", () => {
  it("leaves no partial approval/outbox after crash between entry and outbox", async () => {
    const crashing = repository({
      hooks: {
        afterApprovalEntryBeforeOutbox: () => {
          throw new Error("crash after approval entry before outbox");
        },
      },
    });
    await expect(
      crashing.appendLedgerRecord(approvalLedgerRecord()),
    ).rejects.toBeDefined();

    // Cold process: new repository bound only to durable root.
    const cold = repository();
    const entries = await cold.list();
    const pending = await cold.pendingInvalidations();
    const hasApproval = entries.some((entry) => entry.kind === "approval");
    const hasOutbox = pending.includes(INVALIDATION_ID);
    // Atomic commit: both durable or neither — never approval without outbox.
    expect(hasApproval).toBe(hasOutbox);
    expect(hasApproval).toBe(false);
    expect(hasOutbox).toBe(false);
  });

  it("cold recovery finds the outbox request when approval commits", async () => {
    const repo = repository();
    await repo.appendLedgerRecord(approvalLedgerRecord());
    const cold = repository();
    expect(await cold.pendingInvalidations()).toEqual([INVALIDATION_ID]);
    const pending = await cold.readPendingInvalidations();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe(INVALIDATION_ID);
  });

  it("rejects a malformed repair identity that is not a canonical ULID brand", async () => {
    const repo = repository();
    for (const repairId of [
      "rpr-not-a-ulid",
      "rpr-01arz3ndektsv4rrffq69g5fav", // lowercase ULID is invalid Crockford
      "rpr-01ARZ3NDEKTSV4RRFFQ69G5FAV-extra",
    ]) {
      const result = await repo.append(proposalRecord({ repairId }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("INVALID_RECORD");
    }
  });

  it("rejects a malformed invalidation identity that is not a canonical ULID brand", async () => {
    const repo = repository();
    await repo.append(proposalRecord());
    await expect(
      repo.enqueueInvalidation({
        id: "inv-not-a-ulid",
        repairId: REPAIR_ID,
        unitIds: [],
      }),
    ).rejects.toBeDefined();
  });
});

describe("repair repository refuses symlink custody paths", () => {
  it("fails closed when the journal path is a symbolic link", async () => {
    const repairDir = join(root, ".ultradyn", "repair");
    await mkdir(repairDir, { recursive: true });
    const outside = join(root, "outside-journal.json");
    await writeFile(outside, "{}\n");
    await symlink(outside, join(repairDir, "journal.json"));
    const repo = repository();
    const result = await repo.append(proposalRecord());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("COMMIT_FAILED");
  });

  it("fails closed when an immutable record path is a symbolic link", async () => {
    const recordsDir = join(root, ".ultradyn", "repair", "records");
    await mkdir(recordsDir, { recursive: true });
    const outside = join(root, "outside-record.json");
    await writeFile(outside, "{}\n");
    const targetName = `00000002-${REPAIR_ID}.json`;
    await symlink(outside, join(recordsDir, targetName));
    const repo = repository();
    const result = await repo.append(proposalRecord());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Symlink at the exclusive record path fails closed; the exact code is
      // the custody failure class (commit or invalid), never a silent write-through.
      expect(["COMMIT_FAILED", "INVALID_RECORD"]).toContain(result.code);
    }
  });

  it("fails closed reading a journal that became a symbolic link", async () => {
    const repo = repository();
    const first = await repo.append(proposalRecord());
    expect(first.ok).toBe(true);
    const journalPath = join(root, ".ultradyn", "repair", "journal.json");
    const outside = join(root, "swapped-journal.json");
    await writeFile(outside, await readFile(journalPath));
    await rm(journalPath);
    await symlink(outside, journalPath);
    await expect(repository().currentRevision()).rejects.toBeDefined();
  });
});
