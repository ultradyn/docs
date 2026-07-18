import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type FileReader, validateIngestBundle } from "./index.js";

const fixtures = fileURLToPath(
  new URL("fixtures/ingest-bundle", import.meta.url),
);

async function fixture(
  kind: "valid" | "broken-link" | "cycle" | "committed-index",
) {
  const root = await mkdtemp(path.join(tmpdir(), `ingest-bundle-${kind}-`));
  await cp(path.join(fixtures, kind), root, { recursive: true });
  return root;
}

async function emptyFixture() {
  return mkdtemp(path.join(tmpdir(), "ingest-bundle-empty-"));
}

async function reportWith(
  root: string,
  relative: string,
  content: string | Uint8Array,
) {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
  return validateIngestBundle(root);
}

describe("curated ingestion bundle validation", () => {
  it("produces byte-identical reports from the committed clean fixture", async () => {
    const root = await fixture("valid");
    const first = await validateIngestBundle(root);
    const second = await validateIngestBundle(root);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first).toEqual({
      ok: true,
      schemaErrors: [],
      brokenLinks: [],
      cycles: [],
      forbiddenArtifacts: [],
    });
  });

  it.each([
    ["broken-link", "brokenLinks", "README.md -> missing.md"],
    ["cycle", "cycles", "T-A -> T-B -> T-A"],
    ["committed-index", "forbiddenArtifacts", "search.minisearch"],
  ] as const)(
    "reports the committed %s fixture",
    async (kind, field, expected) => {
      const report = await validateIngestBundle(await fixture(kind));
      expect(report.ok).toBe(false);
      const rendered =
        field === "cycles"
          ? report.cycles.map((cycle) => cycle.join(" -> ")).join("\n")
          : report[field].join("\n");
      expect(rendered).toContain(expected);
    },
  );

  it("uses only the injected reader and records reader failures", async () => {
    const calls: string[] = [];
    const io: FileReader = {
      async list(relative) {
        calls.push(`list:${relative}`);
        throw new Error("injected list failure");
      },
      async readText(relative) {
        calls.push(`text:${relative}`);
        throw new Error("unexpected text read");
      },
      async readBytes(relative) {
        calls.push(`bytes:${relative}`);
        throw new Error("unexpected byte read");
      },
    };
    const report = await validateIngestBundle("/not-on-disk", io);
    expect(calls).toEqual(["list:/not-on-disk"]);
    expect(report.schemaErrors).toEqual([".: injected list failure"]);
  });

  it("rejects all symlinks and never follows their markdown targets", async () => {
    const root = await fixture("valid");
    const outside = await emptyFixture();
    await writeFile(path.join(outside, "secret.md"), "secret\n");
    try {
      await symlink(
        path.join(outside, "secret.md"),
        path.join(root, "escape.md"),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    await writeFile(path.join(root, "README.md"), "[escape](escape.md)\n");
    const report = await validateIngestBundle(root);
    expect(report.schemaErrors).toContain(
      "escape.md: symbolic links are forbidden",
    );
    expect(report.brokenLinks).toContain(
      "README.md -> escape.md (symbolic link)",
    );
  });

  it("reports every forbidden portable artifact in sorted order", async () => {
    const root = await emptyFixture();
    for (const relative of [
      "z.wav",
      "x.sqlite3",
      "x.sqlite",
      "x.npy",
      "x.npz",
      "x.mp3",
      "x.minisearch",
      "x.gz",
      "x.faiss",
      "x.db",
      "x.pyc",
      "x.zip",
      "x.tar",
      "__pycache__/module",
    ]) {
      await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await writeFile(path.join(root, relative), "x");
    }
    const report = await validateIngestBundle(root);
    expect(report.forbiddenArtifacts).toEqual([
      "__pycache__",
      "x.db",
      "x.faiss",
      "x.gz",
      "x.minisearch",
      "x.mp3",
      "x.npy",
      "x.npz",
      "x.pyc",
      "x.sqlite",
      "x.sqlite3",
      "x.tar",
      "x.zip",
      "z.wav",
    ]);
  });

  it("rejects malformed, duplicate, dangling, and cyclic task rows", async () => {
    const root = await emptyFixture();
    const report = await reportWith(
      root,
      "tasks.json",
      JSON.stringify([
        null,
        { id: "T-A", dependencies: ["T-MISSING"] },
        { id: "T-A", dependencies: [] },
        { id: "T-B", dependencies: ["T-C"] },
        { id: "T-C", dependencies: ["T-B"] },
        { id: "T-D", dependencies: "T-A" },
      ]),
    );
    expect(report.schemaErrors).toEqual([
      "tasks.json[0]: must be an object",
      'tasks.json[1].dependencies[0]: unknown task ID "T-MISSING"',
      'tasks.json[2].id: duplicate task ID "T-A"',
      "tasks.json[5].dependencies: must be an array of strings",
    ]);
    expect(report.cycles).toEqual([["T-B", "T-C", "T-B"]]);
  });

  it("validates optional records with the curated record validator", async () => {
    const root = await emptyFixture();
    const report = await reportWith(
      root,
      "records.json",
      JSON.stringify([
        null,
        { schemaName: "unknown", version: 999, value: {} },
        { schemaName: "question", version: 999, value: {} },
      ]),
    );
    expect(report.schemaErrors).toHaveLength(3);
    expect(
      report.schemaErrors.every((error) => error.startsWith("records.json[")),
    ).toBe(true);
    expect(report.schemaErrors.join("\n")).toContain("unknown");
  });

  it("turns optional manifest validator failures into schema errors", async () => {
    const report = await reportWith(
      await emptyFixture(),
      "manifests.json",
      JSON.stringify({ agents: "not-an-array" }),
    );
    expect(report.schemaErrors.length).toBeGreaterThan(0);
    expect(
      report.schemaErrors.every((error) => error.startsWith("manifests.json")),
    ).toBe(true);
  });

  it("validates checksums and rejects malformed, duplicate, dangling, and unsafe entries", async () => {
    const root = await emptyFixture();
    await writeFile(path.join(root, "a.txt"), "hello");
    const good = createHash("sha256").update("hello").digest("hex");
    const bad = "0".repeat(64);
    const report = await reportWith(
      root,
      "MANIFEST.sha256",
      [
        `${good}  a.txt`,
        `${good}  a.txt`,
        `${good}  missing.txt`,
        `${good}  ../escape.txt`,
        `${bad}  a.txt`,
        "malformed",
      ].join("\n"),
    );
    expect(report.schemaErrors).toEqual([
      "MANIFEST.sha256[2]: duplicate path a.txt",
      "MANIFEST.sha256[3]: missing path missing.txt",
      "MANIFEST.sha256[4]: unsafe path ../escape.txt",
      "MANIFEST.sha256[5]: duplicate path a.txt",
      "MANIFEST.sha256[5]: hash mismatch for a.txt",
      "MANIFEST.sha256[6]: expected <64hex><two spaces><safe relative path>",
    ]);
  });

  it("requires diagram sources and SVG renders in sibling pairs", async () => {
    const root = await emptyFixture();
    await mkdir(path.join(root, "diagrams"));
    await writeFile(path.join(root, "diagrams", "source.dot"), "digraph {}\n");
    await writeFile(path.join(root, "diagrams", "orphan.svg"), "<svg/>\n");
    const report = await validateIngestBundle(root);
    expect(report.schemaErrors).toEqual([
      "diagrams/orphan.svg: missing sibling .dot or .mmd source",
      "diagrams/source.dot: missing sibling .svg render",
    ]);
  });

  it("rejects root escapes and missing markdown links while ignoring external schemes", async () => {
    const root = await emptyFixture();
    const report = await reportWith(
      root,
      "README.md",
      [
        "[escape](../secret.md)",
        "[missing](missing.md)",
        "[web](https://example.com)",
        "[mail](mailto:test@example.com)",
      ].join("\n"),
    );
    expect(report.brokenLinks).toEqual([
      "README.md -> ../secret.md (escapes bundle root)",
      "README.md -> missing.md (missing)",
    ]);
  });
});
