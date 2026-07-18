import { readFile } from "node:fs/promises";
import { describe, expect, it, vi, type Mock } from "vitest";
import {
  preflightPackage,
  type ArchiveEntry,
  type ArchiveReader,
} from "../index.js";
import type { PolicyProfile } from "../../domain/ingest/index.js";

const policy: PolicyProfile = {
  schemaVersion: 1,
  id: "policy-source-docs",
  approved: true,
  dataClass: "internal",
  include: ["docs/**", "README.md"],
  exclude: ["docs/private/**"],
  allowedMediaTypes: ["text/markdown", "text/plain"],
  allowedProcessors: ["local-markdown", "local-text"],
  allowedStorage: ["project-repository"],
  retentionDays: 365,
  accessClass: "project-members",
  maxFiles: 3,
  maxFileBytes: 20,
  maxExpandedBytes: 40,
};

function archiveWith(entries: readonly ArchiveEntry[]): ArchiveReader & {
  extract: Mock<ArchiveReader["extract"]>;
} {
  const extract = vi.fn<ArchiveReader["extract"]>();
  return {
    entries: vi.fn<ArchiveReader["entries"]>().mockResolvedValue(entries),
    extract,
  };
}

async function archiveFixture(
  name: "valid" | "traversal" | "symlink" | "bomb" | "prohibited",
): Promise<ArchiveReader & { extract: Mock<ArchiveReader["extract"]> }> {
  const fixtureUrl = new URL(
    `./fixtures/${name}/archive.json`,
    import.meta.url,
  );
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8")) as {
    entries: readonly ArchiveEntry[];
  };
  return archiveWith(fixture.entries);
}

describe("source package preflight", () => {
  it.each([
    ["traversal", "PATH_TRAVERSAL"],
    ["symlink", "LINK_ESCAPE"],
    ["bomb", "LIMIT_EXCEEDED"],
    ["prohibited", "MEDIA_DENIED"],
  ] as const)(
    "rejects the %s fixture before extraction",
    async (fixtureName, code) => {
      const archive = await archiveFixture(fixtureName);

      const result = await preflightPackage({
        archivePath: `${fixtureName}.archive`,
        policy,
        archive,
      });

      expect(result).toMatchObject({ ok: false, code });
      expect(archive.extract).not.toHaveBeenCalled();
    },
  );

  it("fails closed when the approved policy profile is missing", async () => {
    const archive = archiveWith([]);

    await expect(
      preflightPackage({
        archivePath: "empty.zip",
        policy: undefined as unknown as PolicyProfile,
        archive,
      }),
    ).resolves.toEqual({
      ok: false,
      code: "POLICY_DENIED",
      message: "approved policy profile is required",
    });
    expect(archive.entries).not.toHaveBeenCalled();
    expect(archive.extract).not.toHaveBeenCalled();
  });

  it.each([
    "../outside.md",
    "docs\\..\\outside.md",
    "/etc/passwd",
    "C:\\secret.md",
    "C:secret.md",
    "docs/report.md:payload",
  ])(
    "rejects unsafe path metadata %s before extraction",
    async (logicalPath) => {
      const archive = archiveWith([
        {
          logicalPath,
          mediaType: "text/markdown",
          size: 12,
          kind: "file",
        },
      ]);

      const result = await preflightPackage({
        archivePath: "traversal.zip",
        policy,
        archive,
      });
      expect(result).toMatchObject({
        ok: false,
        code: "PATH_TRAVERSAL",
      });
      expect(archive.extract).not.toHaveBeenCalled();
    },
  );

  it("rejects link metadata before extraction", async () => {
    const archive = archiveWith([
      {
        logicalPath: "docs/current.md",
        mediaType: "text/markdown",
        size: 8,
        kind: "symlink",
        linkTarget: "../../secret.md",
      },
    ]);

    await expect(
      preflightPackage({ archivePath: "symlink.tar", policy, archive }),
    ).resolves.toEqual({
      ok: false,
      code: "LINK_ESCAPE",
      message: "archive links are not permitted: docs/current.md",
    });
    expect(archive.extract).not.toHaveBeenCalled();
  });

  it("rejects expanded-byte totals that cannot be represented exactly", async () => {
    const archive = archiveWith([
      {
        logicalPath: "docs/one.md",
        mediaType: "text/markdown",
        size: Number.MAX_SAFE_INTEGER,
        kind: "file",
      },
      {
        logicalPath: "docs/two.md",
        mediaType: "text/markdown",
        size: 1,
        kind: "file",
      },
    ]);

    await expect(
      preflightPackage({
        archivePath: "overflow.zip",
        policy: {
          ...policy,
          maxFileBytes: Number.MAX_SAFE_INTEGER,
          maxExpandedBytes: Number.MAX_SAFE_INTEGER,
        },
        archive,
      }),
    ).resolves.toEqual({
      ok: false,
      code: "LIMIT_EXCEEDED",
      message: "expanded bytes exceed safe integer range",
    });
    expect(archive.extract).not.toHaveBeenCalled();
  });

  it("rejects expanded-byte bombs from headers before extraction", async () => {
    const archive = archiveWith([
      {
        logicalPath: "docs/one.md",
        mediaType: "text/markdown",
        size: 20,
        kind: "file",
      },
      {
        logicalPath: "docs/two.md",
        mediaType: "text/markdown",
        size: 20,
        kind: "file",
      },
      {
        logicalPath: "README.md",
        mediaType: "text/markdown",
        size: 1,
        kind: "file",
      },
    ]);

    await expect(
      preflightPackage({ archivePath: "bomb.zip", policy, archive }),
    ).resolves.toEqual({
      ok: false,
      code: "LIMIT_EXCEEDED",
      message: "expanded bytes exceed policy limit: 41 > 40",
    });
    expect(archive.extract).not.toHaveBeenCalled();
  });

  it.each(["", ".", "docs//", "docs/guide.md\0.exe"])(
    "rejects invalid logical path metadata %j before extraction",
    async (logicalPath) => {
      const archive = archiveWith([
        { logicalPath, mediaType: "text/markdown", size: 1, kind: "file" },
      ]);

      const result = await preflightPackage({
        archivePath: "invalid-path.zip",
        policy,
        archive,
      });
      expect(result).toMatchObject({ ok: false, code: "PATH_TRAVERSAL" });
      expect(archive.extract).not.toHaveBeenCalled();
    },
  );

  it("rejects colliding normalized paths before extraction", async () => {
    const archive = archiveWith([
      {
        logicalPath: "docs/guide.md",
        mediaType: "text/markdown",
        size: 1,
        kind: "file",
      },
      {
        logicalPath: "docs/./guide.md",
        mediaType: "text/markdown",
        size: 1,
        kind: "file",
      },
    ]);

    await expect(
      preflightPackage({ archivePath: "collision.zip", policy, archive }),
    ).resolves.toEqual({
      ok: false,
      code: "PATH_TRAVERSAL",
      message: "archive paths collide after normalization: docs/guide.md",
    });
    expect(archive.extract).not.toHaveBeenCalled();
  });

  it("rejects invalid size metadata before extraction", async () => {
    const archive = archiveWith([
      {
        logicalPath: "docs/impossible.md",
        mediaType: "text/markdown",
        size: -1,
        kind: "file",
      },
    ]);

    await expect(
      preflightPackage({ archivePath: "invalid-size.zip", policy, archive }),
    ).resolves.toEqual({
      ok: false,
      code: "LIMIT_EXCEEDED",
      message: "invalid file size: docs/impossible.md (-1)",
    });
    expect(archive.extract).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "file count",
      entries: [
        {
          logicalPath: "docs/1.md",
          mediaType: "text/markdown",
          size: 1,
          kind: "file",
        },
        {
          logicalPath: "docs/2.md",
          mediaType: "text/markdown",
          size: 1,
          kind: "file",
        },
        {
          logicalPath: "docs/3.md",
          mediaType: "text/markdown",
          size: 1,
          kind: "file",
        },
        {
          logicalPath: "docs/4.md",
          mediaType: "text/markdown",
          size: 1,
          kind: "file",
        },
      ] satisfies readonly ArchiveEntry[],
      message: "file count exceeds policy limit: 4 > 3",
    },
    {
      label: "file bytes",
      entries: [
        {
          logicalPath: "docs/large.md",
          mediaType: "text/markdown",
          size: 21,
          kind: "file",
        },
      ] satisfies readonly ArchiveEntry[],
      message: "file bytes exceed policy limit: docs/large.md (21 > 20)",
    },
  ])(
    "rejects $label above the exact boundary",
    async ({ entries, message }) => {
      const archive = archiveWith(entries);

      await expect(
        preflightPackage({ archivePath: "oversized.zip", policy, archive }),
      ).resolves.toEqual({ ok: false, code: "LIMIT_EXCEEDED", message });
      expect(archive.extract).not.toHaveBeenCalled();
    },
  );

  it("accepts file-count, per-file, and expanded-byte limits exactly", async () => {
    const archive = archiveWith([
      {
        logicalPath: "docs/one.md",
        mediaType: "text/markdown",
        size: 20,
        kind: "file",
      },
      {
        logicalPath: "docs/two.md",
        mediaType: "text/markdown",
        size: 19,
        kind: "file",
      },
      {
        logicalPath: "README.md",
        mediaType: "text/markdown",
        size: 1,
        kind: "file",
      },
    ]);

    const result = await preflightPackage({
      archivePath: "boundaries.zip",
      policy,
      archive,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.entries).toHaveLength(3);
    expect(archive.extract).not.toHaveBeenCalled();
  });

  it("rejects included content denied by policy before extraction", async () => {
    const archive = archiveWith([
      {
        logicalPath: "misc/notes.md",
        mediaType: "text/markdown",
        size: 1,
        kind: "file",
      },
    ]);

    await expect(
      preflightPackage({ archivePath: "policy-denied.zip", policy, archive }),
    ).resolves.toEqual({
      ok: false,
      code: "POLICY_DENIED",
      message: "path is not classified by policy: misc/notes.md",
    });
    expect(archive.extract).not.toHaveBeenCalled();
  });

  it("rejects prohibited or unclassified media before extraction", async () => {
    const archive = archiveWith([
      {
        logicalPath: "docs/payload.bin",
        mediaType: "application/octet-stream",
        size: 1,
        kind: "file",
      },
    ]);

    await expect(
      preflightPackage({ archivePath: "prohibited.zip", policy, archive }),
    ).resolves.toEqual({
      ok: false,
      code: "MEDIA_DENIED",
      message:
        "media type is not permitted: docs/payload.bin (application/octet-stream)",
    });
    expect(archive.extract).not.toHaveBeenCalled();
  });

  it("lists every included and excluded normalized path without extraction", async () => {
    const archive = await archiveFixture("valid");

    await expect(
      preflightPackage({ archivePath: "valid.zip", policy, archive }),
    ).resolves.toEqual({
      ok: true,
      value: {
        entries: [
          {
            logicalPath: "docs/guide.md",
            mediaType: "text/markdown",
            size: 20,
            included: true,
            reason: "included by docs/**",
          },
          {
            logicalPath: "docs/private/notes.txt",
            mediaType: "text/plain",
            size: 20,
            included: false,
            reason: "excluded by docs/private/**",
          },
        ],
      },
    });
    expect(archive.extract).not.toHaveBeenCalled();
  });

  it("orders manifests by a portable code-unit total order", async () => {
    const archive = archiveWith([
      {
        logicalPath: "docs/z.md",
        mediaType: "text/markdown",
        size: 1,
        kind: "file",
      },
      {
        logicalPath: "docs/A.md",
        mediaType: "text/markdown",
        size: 1,
        kind: "file",
      },
      {
        logicalPath: "docs/a.md",
        mediaType: "text/markdown",
        size: 1,
        kind: "file",
      },
    ]);

    const result = await preflightPackage({
      archivePath: "ordering.zip",
      policy,
      archive,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.entries.map((entry) => entry.logicalPath)).toEqual([
        "docs/A.md",
        "docs/a.md",
        "docs/z.md",
      ]);
    }
  });
});
