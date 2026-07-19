import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { open, unlink } from "node:fs/promises";

import {
  PolicyApprovalSchema,
  digestDataRightsPolicyProfile,
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
 * Public failure text is fixed per code.
 *
 * Nothing derived from a caught exception, a stored record, a profile, or an
 * absolute path may reach a caller: a Result message crosses trust boundaries,
 * and this module handles both attacker-influenced ids and records that may
 * contain credentials planted by whoever wrote them. Diagnostics stay internal.
 */
const PUBLIC_MESSAGE: Record<PolicyApprovalErrorCode, string> = {
  APPROVAL_CONFLICT:
    "the profile id is already approved at a different content digest; changed content must use a new profile id",
  INVALID_APPROVAL: "the approval record failed strict validation",
  CUSTODY_UNAVAILABLE: "the approval store could not be read or written",
};

function failure<T>(
  code: PolicyApprovalErrorCode,
): IngestResult<T, PolicyApprovalErrorCode> {
  return { ok: false, code, message: PUBLIC_MESSAGE[code] };
}

/** Filesystem capabilities, injected so unavailable custody can be exercised
 * deterministically without touching anything outside the root. */
export interface PolicyApprovalCapabilities {
  openDirectory?(path: string): Promise<unknown | undefined>;
  readFile?(path: string): Promise<Uint8Array>;
  fsyncDirectory?(path: string): Promise<void>;
}

export interface FilePolicyApprovalStoreOptions {
  root: string;
  capabilities?: PolicyApprovalCapabilities;
}

/**
 * There is deliberately no delete, revoke, or overwrite member. A conflicting
 * digest under an approved id is refused rather than resolved, because
 * last-write-wins would let a second approval silently retarget a policy id
 * underneath a running gate.
 */
export interface PolicyApprovalStore {
  publish(approval: PolicyApproval): Promise<PolicyApprovalPublishResult>;
  read(profileId: string): Promise<PolicyApprovalReadResult>;
}

/**
 * Recursive freeze.
 *
 * `Object.freeze` is shallow, so freezing only the record leaves every nested
 * array and object writable while `Object.isFrozen` still reports true — a
 * policy record handed to an enforcement gate could then be edited in place by
 * anything else holding it.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

function frozenCopy(approval: PolicyApproval): PolicyApproval {
  return deepFreeze(JSON.parse(JSON.stringify(approval)) as PolicyApproval);
}

/**
 * Strict validation, including the digest recomputation the schema performs.
 * A record that parses is self-authenticating: its digest commits to the
 * profile it carries.
 */
function validate(
  candidate: unknown,
): IngestResult<PolicyApproval, PolicyApprovalErrorCode> {
  const parsed = PolicyApprovalSchema.safeParse(candidate);
  if (!parsed.success) return failure("INVALID_APPROVAL");
  return { ok: true, value: parsed.data };
}

export function createInMemoryPolicyApprovalStore(): PolicyApprovalStore {
  const records = new Map<string, PolicyApproval>();

  const publish = async (
    approval: PolicyApproval,
  ): Promise<PolicyApprovalPublishResult> => {
    const validated = validate(approval);
    if (!validated.ok) return validated;

    const existing = records.get(validated.value.profileId);
    if (existing) {
      return existing.profileSha256 === validated.value.profileSha256
        ? { ok: true, value: "replayed" }
        : failure("APPROVAL_CONFLICT");
    }

    records.set(validated.value.profileId, frozenCopy(validated.value));
    return { ok: true, value: "published" };
  };

  const read = async (profileId: string): Promise<PolicyApprovalReadResult> => {
    const found = records.get(profileId);
    return { ok: true, value: found ? frozenCopy(found) : undefined };
  };

  return { publish, read };
}

/**
 * Profile ids are attacker-influenced strings, so they are never used as path
 * components. The leaf name is a digest of the id; the record's embedded
 * identity is what proves which profile it describes.
 */
async function leafName(profileId: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return `${createHash("sha256").update(profileId, "utf8").digest("hex")}.json`;
}

/**
 * Descriptor-relative paths.
 *
 * Node exposes no `openat`, so a held directory descriptor is re-entered
 * through `/proc/self/fd/<fd>`. That keeps every subsequent operation anchored
 * to the inode we validated: a directory swapped after the check cannot
 * redirect a later write, because the descriptor still refers to the original
 * inode. This is Linux-specific, and the store fails closed elsewhere rather
 * than silently downgrading to pathname I/O that cannot offer the guarantee.
 */
const DESCRIPTOR_PATHS_AVAILABLE = process.platform === "linux";

function within(directory: FileHandle, leaf: string): string {
  return `/proc/self/fd/${directory.fd}/${leaf}`;
}

const DIRECTORY_FLAGS =
  fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_DIRECTORY;

/** Open a child directory relative to a held descriptor, never following a
 * link at the final component. */
async function openChildDirectory(
  parent: FileHandle,
  name: string,
): Promise<FileHandle | undefined> {
  try {
    return await open(within(parent, name), DIRECTORY_FLAGS);
  } catch {
    return undefined;
  }
}

export function createFilePolicyApprovalStore(
  options: FilePolicyApprovalStoreOptions,
): PolicyApprovalStore {
  const capabilities = options.capabilities ?? {};
  const components = POLICY_APPROVAL_ROOT.split("/");
  // Whether this instance has ever bound the approval directory. A tree that
  // has never existed is a fresh checkout holding no approvals; a tree that
  // vanishes after we have bound it is tampering, and must surface as a typed
  // storage failure rather than as "nothing approved".
  let hasBound = false;

  async function bind(
    create: boolean,
  ): Promise<
    { ok: true; handle: FileHandle } | { ok: false; absent: boolean }
  > {
    if (!DESCRIPTOR_PATHS_AVAILABLE) return { ok: false, absent: false };

    if (capabilities.openDirectory) {
      const bound = await capabilities.openDirectory(
        `${options.root}/${POLICY_APPROVAL_ROOT}`,
      );
      if (bound === undefined) return { ok: false, absent: false };
    }

    let current: FileHandle;
    try {
      current = await open(options.root, DIRECTORY_FLAGS);
    } catch {
      return { ok: false, absent: !hasBound };
    }

    for (const component of components) {
      let next = await openChildDirectory(current, component);
      if (!next && create) {
        try {
          const { mkdir } = await import("node:fs/promises");
          await mkdir(within(current, component));
          next = await openChildDirectory(current, component);
        } catch {
          next = undefined;
        }
      }
      await current.close().catch(() => {});
      if (!next) return { ok: false, absent: !hasBound && !create };
      current = next;
    }

    hasBound = true;
    return { ok: true, handle: current };
  }

  /** Read and validate the record at `leaf`, refusing anything that is not a
   * regular file reached without following a link. */
  async function readLeaf(
    directory: FileHandle,
    leaf: string,
  ): Promise<PolicyApprovalReadResult> {
    if (capabilities.readFile) {
      try {
        const bytes = await capabilities.readFile(within(directory, leaf));
        return decode(bytes);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        return code === "ENOENT"
          ? { ok: true, value: undefined }
          : failure("CUSTODY_UNAVAILABLE");
      }
    }

    let handle: FileHandle;
    try {
      handle = await open(
        within(directory, leaf),
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      // ENOENT is a record that does not exist. ELOOP means the leaf is a
      // symlink and O_NOFOLLOW refused it; anything else is an outage. Neither
      // may be reported as an absent approval.
      if (code === "ENOENT") return { ok: true, value: undefined };
      return failure("CUSTODY_UNAVAILABLE");
    }

    try {
      const stat = await handle.stat();
      // A FIFO would block, a directory is nonsense, a device is hostile. Only
      // a regular file can be an approval record.
      if (!stat.isFile()) return failure("CUSTODY_UNAVAILABLE");
      return decode(await handle.readFile());
    } catch {
      return failure("CUSTODY_UNAVAILABLE");
    } finally {
      await handle.close().catch(() => {});
    }
  }

  function decode(bytes: Uint8Array): PolicyApprovalReadResult {
    let candidate: unknown;
    try {
      candidate = JSON.parse(Buffer.from(bytes).toString("utf8"));
    } catch {
      // The parse error text quotes the offending bytes, which may be planted
      // credentials. It never reaches the caller.
      return failure("INVALID_APPROVAL");
    }
    const validated = validate(candidate);
    if (!validated.ok) return validated;
    return { ok: true, value: frozenCopy(validated.value) };
  }

  async function existingRecord(
    directory: FileHandle,
    profileId: string,
  ): Promise<PolicyApprovalReadResult> {
    const found = await readLeaf(directory, await leafName(profileId));
    if (!found.ok) return found;
    if (found.value && found.value.profileId !== profileId) {
      return failure("INVALID_APPROVAL");
    }
    return found;
  }

  const publish = async (
    approval: PolicyApproval,
  ): Promise<PolicyApprovalPublishResult> => {
    const validated = validate(approval);
    if (!validated.ok) return validated;

    const bound = await bind(true);
    if (!bound.ok) return failure("CUSTODY_UNAVAILABLE");
    const directory = bound.handle;

    try {
      const leaf = await leafName(validated.value.profileId);
      const existing = await existingRecord(
        directory,
        validated.value.profileId,
      );
      if (!existing.ok) return existing;
      if (existing.value) {
        return existing.value.profileSha256 === validated.value.profileSha256
          ? { ok: true, value: "replayed" }
          : failure("APPROVAL_CONFLICT");
      }

      // A fresh, unguessable temp name every attempt. Reusing a
      // content-addressed name would let an attacker pre-plant bytes at a
      // predictable path and have them promoted unread.
      const temp = `.${randomBytes(16).toString("hex")}.tmp`;
      const bytes = `${JSON.stringify(validated.value, null, 2)}\n`;

      let staged: FileHandle;
      try {
        staged = await open(
          within(directory, temp),
          fsConstants.O_CREAT |
            fsConstants.O_EXCL |
            fsConstants.O_WRONLY |
            fsConstants.O_NOFOLLOW,
          0o600,
        );
      } catch {
        return failure("CUSTODY_UNAVAILABLE");
      }

      try {
        const stat = await staged.stat();
        if (!stat.isFile()) return failure("CUSTODY_UNAVAILABLE");
        await staged.writeFile(bytes, "utf8");
        await staged.sync();
      } catch {
        return failure("CUSTODY_UNAVAILABLE");
      } finally {
        await staged.close().catch(() => {});
      }

      if (capabilities.fsyncDirectory) {
        try {
          await capabilities.fsyncDirectory(within(directory, "."));
        } catch {
          return failure("CUSTODY_UNAVAILABLE");
        }
      }

      try {
        // link() refuses an existing destination, so publication cannot replace
        // a record. rename() would clobber silently, which is exactly the
        // last-write-wins retargeting this store exists to prevent.
        const { link } = await import("node:fs/promises");
        await link(within(directory, temp), within(directory, leaf));
        await directory.sync();
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if (code === "EEXIST") {
          // Someone published between our read and our link. Re-validate the
          // record that actually won rather than assuming it is ours.
          const winner = await existingRecord(
            directory,
            validated.value.profileId,
          );
          if (!winner.ok) return winner;
          if (!winner.value) return failure("CUSTODY_UNAVAILABLE");
          return winner.value.profileSha256 === validated.value.profileSha256
            ? { ok: true, value: "replayed" }
            : failure("APPROVAL_CONFLICT");
        }
        return failure("CUSTODY_UNAVAILABLE");
      } finally {
        // Removing our own temp is not a deletion path for records: the temp
        // was never authoritative and is unreachable by any reader.
        await unlink(within(directory, temp)).catch(() => {});
      }

      return { ok: true, value: "published" };
    } finally {
      await directory.close().catch(() => {});
    }
  };

  const read = async (profileId: string): Promise<PolicyApprovalReadResult> => {
    const bound = await bind(false);
    if (!bound.ok) {
      return bound.absent
        ? { ok: true, value: undefined }
        : failure("CUSTODY_UNAVAILABLE");
    }
    try {
      return await existingRecord(bound.handle, profileId);
    } finally {
      await bound.handle.close().catch(() => {});
    }
  };

  return { publish, read };
}
