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
  const entries = await input.archive.entries(input.archivePath);
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

  const normalizedPaths = new Set<string>();
  for (const entry of entries) {
    const normalized = posix.normalize(entry.logicalPath.replaceAll("\\", "/"));
    if (normalizedPaths.has(normalized)) {
      return {
        ok: false,
        code: "PATH_TRAVERSAL",
        message: `archive paths collide after normalization: ${normalized}`,
      };
    }
    normalizedPaths.add(normalized);
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
        logicalPath,
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
      logicalPath,
      mediaType: entry.mediaType,
      size: entry.size,
      included: includedBy !== undefined,
      reason:
        includedBy === undefined
          ? "not matched by include rules"
          : `included by ${includedBy}`,
    };
  });
  manifestEntries.sort((left, right) =>
    left.logicalPath < right.logicalPath
      ? -1
      : left.logicalPath > right.logicalPath
        ? 1
        : 0,
  );

  return { ok: true, value: { entries: manifestEntries } };
}

function matchesPath(pattern: string, logicalPath: string): boolean {
  if (pattern.endsWith("/**")) {
    return logicalPath.startsWith(pattern.slice(0, -2));
  }
  return logicalPath === pattern;
}
