import { createHash } from "node:crypto";
import { constants as fsConstants, existsSync } from "node:fs";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  PolicyApprovalSchema,
  type PolicyApproval,
} from "../../domain/ingest/index.js";
import type { IngestResult } from "../../domain/ingest/types.js";

/**
 * Portable, Git-visible approval root. Records live in the repository so an
 * approval travels with the work it authorises.
 */
export const POLICY_APPROVAL_ROOT = "ingest/policy-approvals";

export type PolicyApprovalPublishOutcome = "published" | "replayed";

export type PolicyApprovalErrorCode =
  "APPROVAL_CONFLICT" | "INVALID_APPROVAL" | "CUSTODY_UNAVAILABLE";

export type PolicyApprovalPublishResult = IngestResult<
  PolicyApprovalPublishOutcome,
  PolicyApprovalErrorCode
>;

export type PolicyApprovalReadResult = IngestResult<
  PolicyApproval | undefined,
  PolicyApprovalErrorCode
>;

/**
 * The seam PolicyService depends on.
 *
 * There is deliberately no delete, revoke, or overwrite member. A conflicting
 * digest under an approved id is refused rather than resolved, because
 * last-write-wins would let a second approval silently retarget a policy id
 * underneath a running gate.
 */
export interface PolicyApprovalStore {
  publish(approval: PolicyApproval): Promise<PolicyApprovalPublishResult>;
  read(profileId: string): Promise<PolicyApprovalReadResult>;
}

/** Filesystem capabilities, injected so hostile and unavailable custody can be
 * exercised deterministically without touching anything outside the root. */
export interface PolicyApprovalCapabilities {
  openDirectory?(path: string): Promise<unknown | undefined>;
  readFile?(path: string): Promise<Uint8Array>;
  fsyncDirectory?(path: string): Promise<void>;
}

export interface FilePolicyApprovalStoreOptions {
  root: string;
  capabilities?: PolicyApprovalCapabilities;
}

function validate(
  candidate: unknown,
): IngestResult<PolicyApproval, "INVALID_APPROVAL"> {
  const parsed = PolicyApprovalSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      code: "INVALID_APPROVAL",
      message: parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; "),
    };
  }
  return { ok: true, value: parsed.data };
}

function conflict(existing: PolicyApproval): PolicyApprovalPublishResult {
  return {
    ok: false,
    code: "APPROVAL_CONFLICT",
    message: `profile id ${existing.profileId} is already approved at digest ${existing.profileSha256}; changed content must use a new profile id`,
  };
}

/**
 * Deep-freeze so a caller cannot mutate a record it was handed and thereby
 * rewrite history in the fake while the file adapter, which serialises, would
 * be unaffected. Parity between the two implementations is the whole point of
 * having a fake at all.
 */
function frozenCopy(approval: PolicyApproval): PolicyApproval {
  return Object.freeze(
    JSON.parse(JSON.stringify(approval)) as PolicyApproval,
  ) as PolicyApproval;
}

export function createInMemoryPolicyApprovalStore(): PolicyApprovalStore {
  const records = new Map<string, PolicyApproval>();

  return {
    async publish(approval) {
      const validated = validate(approval);
      if (!validated.ok) return validated;

      const existing = records.get(validated.value.profileId);
      if (existing) {
        return existing.profileSha256 === validated.value.profileSha256
          ? { ok: true, value: "replayed" }
          : conflict(existing);
      }

      records.set(validated.value.profileId, frozenCopy(validated.value));
      return { ok: true, value: "published" };
    },

    async read(profileId) {
      const found = records.get(profileId);
      return { ok: true, value: found ? frozenCopy(found) : undefined };
    },
  };
}

/**
 * Profile ids are attacker-influenced strings, so they are never used as path
 * components. The leaf name is a digest of the id; the record's embedded
 * identity is what proves which profile it describes.
 */
function leafName(profileId: string): string {
  return `${createHash("sha256").update(profileId, "utf8").digest("hex")}.json`;
}

/**
 * A directory that has never been created is genuinely absent. A directory we
 * cannot bind because a component was swapped for a link is an outage. These
 * must stay distinguishable: collapsing them would let an attacker who relinks
 * the root make every read report "nothing approved", which reads as a policy
 * decision rather than the tampering it is.
 */
type BindOutcome = "bound" | "absent" | "refused";

/**
 * Bind the configured root and every component beneath it down to the approval
 * directory.
 *
 * O_NOFOLLOW only refuses a symlinked FINAL component, so checking the leaf
 * alone would still traverse a symlinked root or intermediate directory and
 * write outside the intended tree. Walking the chain closes that, and doing it
 * by descriptor means a directory swapped after the check cannot redirect a
 * later write: the descriptor still refers to the inode we bound.
 */
async function bindDirectoryChain(
  root: string,
  descendants: readonly string[],
): Promise<BindOutcome> {
  // Scoped to the configured root and below. Walking above it would fail on any
  // host where an ancestor is legitimately a symlink, which says nothing about
  // whether OUR custody tree has been tampered with.
  const handles: Awaited<ReturnType<typeof open>>[] = [];
  const flags =
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_DIRECTORY;
  let current = root;

  try {
    handles.push(await open(current, flags));
    for (const part of descendants) {
      current = join(current, part);
      handles.push(await open(current, flags));
    }
    return "bound";
  } catch (error) {
    // ELOOP is the kernel refusing a symlink under O_NOFOLLOW; ENOTDIR means a
    // component was replaced by a non-directory. Both are tampering. Only a
    // plain ENOENT is a tree that simply has not been created yet.
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code === "ENOENT" ? "absent" : "refused";
  } finally {
    await Promise.all(handles.map((handle) => handle.close().catch(() => {})));
  }
}

export function createFilePolicyApprovalStore(
  options: FilePolicyApprovalStoreOptions,
): PolicyApprovalStore {
  const capabilities = options.capabilities ?? {};
  const approvalDirectory = join(options.root, POLICY_APPROVAL_ROOT);

  const bind = async (): Promise<BindOutcome> => {
    if (capabilities.openDirectory) {
      const bound = await capabilities.openDirectory(approvalDirectory);
      return bound === undefined ? "refused" : "bound";
    }
    return bindDirectoryChain(options.root, POLICY_APPROVAL_ROOT.split("/"));
  };

  const readBytes = capabilities.readFile ?? ((path: string) => readFile(path));

  const fsyncDirectory =
    capabilities.fsyncDirectory ??
    (async (path: string) => {
      const handle = await open(path, fsConstants.O_RDONLY);
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    });

  function recordPath(profileId: string): string {
    return join(approvalDirectory, leafName(profileId));
  }

  async function readExisting(
    profileId: string,
  ): Promise<PolicyApprovalReadResult> {
    let bytes: Uint8Array;
    try {
      bytes = await readBytes(recordPath(profileId));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      // Absent is a legitimate answer; anything else is an outage and must not
      // be reported as "nothing approved", which would silently deny every run
      // for a reason the caller cannot distinguish from a policy decision.
      if (code === "ENOENT") return { ok: true, value: undefined };
      return {
        ok: false,
        code: "CUSTODY_UNAVAILABLE",
        message: `approval record unreadable: ${String(error)}`,
      };
    }

    let candidate: unknown;
    try {
      candidate = JSON.parse(Buffer.from(bytes).toString("utf8"));
    } catch (error) {
      return {
        ok: false,
        code: "INVALID_APPROVAL",
        message: `approval record is not JSON: ${String(error)}`,
      };
    }

    // A tampered or truncated record must not be trusted merely because it
    // parses as JSON.
    const validated = validate(candidate);
    if (!validated.ok) return validated;
    if (validated.value.profileId !== profileId) {
      return {
        ok: false,
        code: "INVALID_APPROVAL",
        message: `record at ${profileId}'s key declares profile id ${validated.value.profileId}`,
      };
    }
    return { ok: true, value: frozenCopy(validated.value) };
  }

  return {
    async publish(approval) {
      const validated = validate(approval);
      if (!validated.ok) return validated;

      try {
        await mkdir(approvalDirectory, { recursive: true });
      } catch (error) {
        return {
          ok: false,
          code: "CUSTODY_UNAVAILABLE",
          message: `approval root unavailable: ${String(error)}`,
        };
      }

      // Bind the directory before writing. A symlinked root or intermediate
      // component fails here rather than after bytes have landed elsewhere.
      if ((await bind()) !== "bound") {
        return {
          ok: false,
          code: "CUSTODY_UNAVAILABLE",
          message: `approval root ${approvalDirectory} could not be bound`,
        };
      }

      const existing = await readExisting(validated.value.profileId);
      if (!existing.ok) return existing;
      if (existing.value) {
        return existing.value.profileSha256 === validated.value.profileSha256
          ? { ok: true, value: "replayed" }
          : conflict(existing.value);
      }

      const finalPath = recordPath(validated.value.profileId);
      const bytes = `${JSON.stringify(validated.value, null, 2)}\n`;
      // The staging name is content-addressed, so an interrupted attempt leaves
      // a file a retry of the SAME record can reuse rather than collide with.
      // Nothing is ever unlinked: this module has no deletion path.
      const staged = `${finalPath}.${createHash("sha256").update(bytes, "utf8").digest("hex").slice(0, 16)}.staged`;

      try {
        // Exclusive staging write, then a rename that cannot clobber, then a
        // directory fsync. Nothing is readable at the final path until the
        // whole record is durable.
        if (!existsSync(staged)) {
          await writeFile(staged, bytes, { flag: "wx", encoding: "utf8" });
        }
        await fsyncDirectory(dirname(finalPath));
        await rename(staged, finalPath);
        await fsyncDirectory(dirname(finalPath));
      } catch (error) {
        return {
          ok: false,
          code: "CUSTODY_UNAVAILABLE",
          message: `approval publication interrupted: ${String(error)}`,
        };
      }

      return { ok: true, value: "published" };
    },

    async read(profileId) {
      // Bind BEFORE deciding absence. Checking existence first would let an
      // attacker who relinks the root turn every read into a bare "absent",
      // which a caller cannot distinguish from a genuine policy refusal.
      const outcome = await bind();
      if (outcome === "absent") return { ok: true, value: undefined };
      if (outcome === "refused") {
        return {
          ok: false,
          code: "CUSTODY_UNAVAILABLE",
          message: `approval root ${approvalDirectory} could not be bound`,
        };
      }
      return readExisting(profileId);
    },
  };
}
