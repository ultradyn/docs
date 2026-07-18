import { posix } from "node:path";
import {
  PolicyProfileSchema,
  type IngestResult,
  type PolicyProfile,
} from "../../domain/ingest/index.js";

export type ArchiveEntryKind = "file" | "symlink" | "hardlink";

export interface ArchiveEntry {
  logicalPath: string;
  mediaType: string;
  size: number;
  kind: ArchiveEntryKind;
  linkTarget?: string;
}

export interface ArchiveReader {
  entries(archivePath: string): Promise<readonly ArchiveEntry[]>;
  extract(archivePath: string, destination: string): Promise<void>;
}

export interface PreflightManifestEntry {
  logicalPath: string;
  mediaType: string;
  size: number;
  included: boolean;
  reason: string;
}

export interface PreflightManifest {
  entries: readonly PreflightManifestEntry[];
}

export type PreflightErrorCode =
  | "PATH_TRAVERSAL"
  | "LINK_ESCAPE"
  | "LIMIT_EXCEEDED"
  | "MEDIA_DENIED"
  | "POLICY_DENIED";

export async function preflightPackage(input: {
  archivePath: string;
  policy: PolicyProfile;
  archive: ArchiveReader;
}): Promise<IngestResult<PreflightManifest, PreflightErrorCode>> {
  const parsedPolicy = PolicyProfileSchema.safeParse(input.policy);
  if (!parsedPolicy.success) {
    return {
      ok: false,
      code: "POLICY_DENIED",
      message: "approved policy profile is required",
    };
  }
  const policy = parsedPolicy.data;
  const entries = [...(await input.archive.entries(input.archivePath))].sort(
    compareArchiveEntries,
  );
  const unsafe = entries.find((entry) => {
    const logicalPath = entry.logicalPath.replaceAll("\\", "/");
    const normalized = posix.normalize(logicalPath);
    return (
      logicalPath.length === 0 ||
      logicalPath.includes("\0") ||
      logicalPath.includes("//") ||
      normalized === "." ||
      normalized.endsWith("/") ||
      logicalPath.startsWith("/") ||
      logicalPath.includes(":") ||
      logicalPath.split("/").includes("..")
    );
  });
  if (unsafe !== undefined) {
    return {
      ok: false,
      code: "PATH_TRAVERSAL",
      message: `unsafe archive path: ${unsafe.logicalPath}`,
    };
  }

  const normalizedPaths = new Map<string, string>();
  for (const entry of entries) {
    const normalized = posix.normalize(entry.logicalPath.replaceAll("\\", "/"));
    const collidingPath = normalizedPaths.get(normalized);
    if (collidingPath !== undefined) {
      return {
        ok: false,
        code: "PATH_TRAVERSAL",
        message: `archive paths collide after normalization: ${collidingPath} and ${entry.logicalPath}`,
      };
    }
    normalizedPaths.set(normalized, entry.logicalPath);
  }

  const nonPortable = entries.find((entry) =>
    entry.logicalPath
      .replaceAll("\\", "/")
      .split("/")
      .some(
        (segment) =>
          (segment !== "." && /[. ]$/.test(segment)) ||
          /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com(?:[1-9]|[¹²³])|lpt(?:[1-9]|[¹²³]))(?:\.|$)/i.test(
            segment,
          ),
      ),
  );
  if (nonPortable !== undefined) {
    return {
      ok: false,
      code: "PATH_TRAVERSAL",
      message: `archive path is not portable: ${nonPortable.logicalPath}`,
    };
  }

  const portablePaths = new Map<string, string>();
  for (const entry of entries) {
    const normalized = posix.normalize(entry.logicalPath.replaceAll("\\", "/"));
    const key = portableCollisionKey(normalized);
    const collidingPath = portablePaths.get(key);
    if (collidingPath !== undefined) {
      return {
        ok: false,
        code: "PATH_TRAVERSAL",
        message: `archive paths collide portably: ${collidingPath} and ${entry.logicalPath}`,
      };
    }
    portablePaths.set(key, entry.logicalPath);
  }

  const link = entries.find((entry) => entry.kind !== "file");
  if (link !== undefined) {
    return {
      ok: false,
      code: "LINK_ESCAPE",
      message: `archive links are not permitted: ${link.logicalPath}`,
    };
  }

  const invalidSize = entries.find(
    (entry) => !Number.isSafeInteger(entry.size) || entry.size < 0,
  );
  if (invalidSize !== undefined) {
    return {
      ok: false,
      code: "LIMIT_EXCEEDED",
      message: `invalid file size: ${invalidSize.logicalPath} (${invalidSize.size})`,
    };
  }

  if (entries.length > policy.maxFiles) {
    return {
      ok: false,
      code: "LIMIT_EXCEEDED",
      message: `file count exceeds policy limit: ${entries.length} > ${policy.maxFiles}`,
    };
  }

  const oversized = entries.find((entry) => entry.size > policy.maxFileBytes);
  if (oversized !== undefined) {
    return {
      ok: false,
      code: "LIMIT_EXCEEDED",
      message: `file bytes exceed policy limit: ${oversized.logicalPath} (${oversized.size} > ${policy.maxFileBytes})`,
    };
  }

  const unclassifiedPath = entries.find((entry) => {
    const logicalPath = posix.normalize(
      entry.logicalPath.replaceAll("\\", "/"),
    );
    return (
      !policy.include.some((pattern) => matchesPath(pattern, logicalPath)) &&
      !policy.exclude.some((pattern) => matchesPath(pattern, logicalPath))
    );
  });
  if (unclassifiedPath !== undefined) {
    return {
      ok: false,
      code: "POLICY_DENIED",
      message: `path is not classified by policy: ${unclassifiedPath.logicalPath}`,
    };
  }

  const deniedMedia = entries.find(
    (entry) => !policy.allowedMediaTypes.includes(entry.mediaType),
  );
  if (deniedMedia !== undefined) {
    return {
      ok: false,
      code: "MEDIA_DENIED",
      message: `media type is not permitted: ${deniedMedia.logicalPath} (${deniedMedia.mediaType})`,
    };
  }

  let expandedBytes = 0;
  for (const entry of entries) {
    if (entry.size > Number.MAX_SAFE_INTEGER - expandedBytes) {
      return {
        ok: false,
        code: "LIMIT_EXCEEDED",
        message: "expanded bytes exceed safe integer range",
      };
    }
    expandedBytes += entry.size;
  }
  if (expandedBytes > policy.maxExpandedBytes) {
    return {
      ok: false,
      code: "LIMIT_EXCEEDED",
      message: `expanded bytes exceed policy limit: ${expandedBytes} > ${policy.maxExpandedBytes}`,
    };
  }

  const manifestEntries = entries.map((entry) => {
    const logicalPath = posix.normalize(
      entry.logicalPath.replaceAll("\\", "/"),
    );
    const excludedBy = policy.exclude.find((pattern) =>
      matchesPath(pattern, logicalPath),
    );
    if (excludedBy !== undefined) {
      return {
        logicalPath: entry.logicalPath,
        mediaType: entry.mediaType,
        size: entry.size,
        included: false,
        reason: `excluded by ${excludedBy}`,
      };
    }

    const includedBy = policy.include.find((pattern) =>
      matchesPath(pattern, logicalPath),
    );
    return {
      logicalPath: entry.logicalPath,
      mediaType: entry.mediaType,
      size: entry.size,
      included: includedBy !== undefined,
      reason:
        includedBy === undefined
          ? "not matched by include rules"
          : `included by ${includedBy}`,
    };
  });
  return { ok: true, value: { entries: manifestEntries } };
}

// NFKC plus upper-then-lower provides a deterministic, locale-independent
// caseless key for portable source custody (including sigma and long-s forms).
function portableCollisionKey(logicalPath: string): string {
  return logicalPath
    .normalize("NFKC")
    .toUpperCase()
    .toLowerCase()
    .normalize("NFC");
}

function compareArchiveEntries(
  left: ArchiveEntry,
  right: ArchiveEntry,
): number {
  const leftKey = archiveEntrySortKey(left);
  const rightKey = archiveEntrySortKey(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function archiveEntrySortKey(entry: ArchiveEntry): string {
  const normalizedPath = posix.normalize(
    entry.logicalPath.replaceAll("\\", "/"),
  );
  return [
    portableCollisionKey(normalizedPath),
    entry.logicalPath,
    entry.kind,
    entry.linkTarget ?? "",
    entry.mediaType,
    String(entry.size),
  ].join("\0");
}

function matchesPath(pattern: string, logicalPath: string): boolean {
  if (pattern.endsWith("/**")) {
    return logicalPath.startsWith(pattern.slice(0, -2));
  }
  return logicalPath === pattern;
}
