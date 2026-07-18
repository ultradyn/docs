import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateIngestBundle } from "./index.js";

async function fixture(kind: "valid" | "broken" | "cycle" | "index") {
  const root = await mkdtemp(path.join(tmpdir(), `ingest-bundle-${kind}-`));
  await mkdir(path.join(root, "docs"), { recursive: true });
  await writeFile(path.join(root, "docs", "readme.md"), "# Readme\n");
  const tasks = [
    { id: "T-A", dependencies: kind === "cycle" ? ["T-B"] : [] },
    { id: "T-B", dependencies: kind === "cycle" ? ["T-A"] : ["T-A"] },
  ];
  await writeFile(path.join(root, "tasks.json"), JSON.stringify(tasks));
  await writeFile(
    path.join(root, "README.md"),
    kind === "broken" ? "[missing](missing.md)\n" : "[docs](docs/readme.md)\n",
  );
  if (kind === "index")
    await writeFile(path.join(root, "search.minisearch"), "x");
  return root;
}

describe("curated ingestion bundle validation", () => {
  it("produces a reproducible clean report", async () => {
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
    ["broken", "brokenLinks", "missing.md"],
    ["cycle", "cycles", "T-A -> T-B -> T-A"],
    ["index", "forbiddenArtifacts", "search.minisearch"],
  ] as const)(
    "reports %s fixtures deterministically",
    async (kind, field, expected) => {
      const report = await validateIngestBundle(await fixture(kind));
      expect(report.ok).toBe(false);
      const rendered =
        field === "cycles"
          ? report.cycles.map((cycle) => cycle.join(" -> ")).join("\n")
          : JSON.stringify(report[field]);
      expect(rendered).toContain(expected);
    },
  );

  it("rejects paths that escape the supplied root", async () => {
    const root = await fixture("valid");
    await writeFile(path.join(root, "README.md"), "[escape](../secret.md)\n");
    const report = await validateIngestBundle(root);
    expect(report.brokenLinks).toEqual(["README.md -> ../secret.md"]);
  });
});
