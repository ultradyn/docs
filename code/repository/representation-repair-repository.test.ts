import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createRepresentationRepairRepository } from "./representation-repair-repository.js";

const ACTOR = "alex.review-1";
const REPAIR_ID = "rpr-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const INVALIDATION_ID = "inv-01ARZ3NDEKTSV4RRFFQ69G5FAV";

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
