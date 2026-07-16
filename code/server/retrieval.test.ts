import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DocumentationIndex } from "./testing.js";

describe("documentation retrieval filesystem boundary", () => {
  it("rejects a symlinked documentation root instead of reading outside content", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "ultradyn-retrieval-root-"),
    );
    const externalRoot = await mkdtemp(
      join(tmpdir(), "ultradyn-retrieval-external-"),
    );
    const externalDocument = join(externalRoot, "private.md");
    await writeFile(
      externalDocument,
      "# Private\n\nThis content must never enter model context.\n",
      "utf8",
    );
    await symlink(externalRoot, join(repositoryRoot, "docs"), "dir");

    await expect(
      new DocumentationIndex(repositoryRoot).context(),
    ).rejects.toThrow(/symbolic link/i);
    expect(await readFile(externalDocument, "utf8")).toContain(
      "must never enter model context",
    );
  });
});
