import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

async function readArchitecture(): Promise<string> {
  return readFile(
    path.join(
      process.cwd(),
      "docs",
      "architecture",
      "automatic-ingestion-v3.md",
    ),
    "utf8",
  );
}

describe("automatic ingestion architecture", () => {
  it("records the adopted authority and isolation boundaries", async () => {
    const architecture = await readArchitecture();

    expect(architecture).toContain("## Authority boundaries");
    expect(architecture).toContain("canonical `QuestionRecord.state`");
    expect(architecture).toContain("orthogonal ingestion records");
    expect(architecture).toContain("inert source bundle");
    expect(architecture).toContain("deterministic services own writes");
    expect(architecture).toContain("fresh Evidence Critic");
    expect(architecture).toContain("fresh Claim Reviewer");
    expect(architecture).toContain("distinct `AnswerComposition`");
    expect(architecture).toContain("existing change-request manager");
    expect(architecture).toContain("## Agent isolation");
    expect(architecture).toContain("## Completion predicate");
    expect(architecture.replace(/\s+/g, " ")).toContain(
      "A question is never complete because ingestion exhausted a search. Completion remains a canonical QuestionRecord transition and is blocked by any active P1 contradiction. Accepted claims and answer compositions are evidence products, not lifecycle authorities.",
    );
    expect(architecture).toContain("## Deferred activation");
  });

  it("defines repository paths and agreed ingestion seams", async () => {
    const architecture = await readArchitecture();
    const seams = await readFile(
      path.join(process.cwd(), "docs", "engineering", "tdd-seams.md"),
      "utf8",
    );

    for (const seam of [
      "Source custody",
      "Source representation",
      "Ingestion knowledge repository",
      "Ingestion graph gateway",
      "Ingestion fixture runner",
    ]) {
      expect(seams).toContain(`| ${seam}`);
    }

    expect(architecture).toContain("`sources/snapshots/`");
    expect(architecture).toContain("`ingest/claims/`");
    expect(architecture).toContain("`.ultradyn/runtime/ingest/`");
    expect(architecture).toContain("one file per accepted logical record");
    expect(architecture).toContain("`IdGenerator.next(kind): string`");
    expect(architecture.replace(/\s+/g, " ")).toContain(
      "queue folders remain projections",
    );
  });
});
