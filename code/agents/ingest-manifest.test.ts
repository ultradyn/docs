import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { resolveShippedPath } from "../shared/shipped-layout.js";
import { type IngestAgentManifest, validateIngestManifests } from "./index.js";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const validManifests = [
  {
    role: "researcher",
    outputSchema: "EvidencePacket",
    tools: [
      "source.exact",
      "source.maps",
      "source.lexical",
      "source.open_unit",
      "source.follow_links",
      "source.vector_optional",
    ],
    freshContext: true,
    next: ["evidence-critic"],
  },
  {
    role: "evidence-critic",
    outputSchema: "EvidenceVerdict",
    tools: ["source.open_reference", "source.open_reference_context"],
    freshContext: true,
    next: ["claim-extractor"],
  },
  {
    role: "claim-extractor",
    outputSchema: "Claim",
    tools: ["source.open_reference"],
    freshContext: true,
    next: ["claim-reviewer"],
  },
  {
    role: "claim-reviewer",
    outputSchema: "ClaimReview",
    tools: ["source.open_reference", "claim.find_candidates"],
    freshContext: true,
    next: ["answer-composer"],
  },
  {
    role: "answer-composer",
    outputSchema: "AnswerComposition",
    tools: [],
    freshContext: true,
    next: [],
  },
] as const satisfies readonly IngestAgentManifest[];

function replaceManifest(
  role: IngestAgentManifest["role"],
  replacement: IngestAgentManifest,
): readonly IngestAgentManifest[] {
  return validManifests.map((manifest) =>
    manifest.role === role ? replacement : manifest,
  );
}

describe("ingestion manifest validation public seam", () => {
  it.each([
    {
      name: "a dangling output schema",
      manifests: replaceManifest("researcher", {
        ...validManifests[0],
        outputSchema: "MissingSchema",
      }),
      code: "DANGLING_REFERENCE",
    },
    {
      name: "an evaluator that reuses producer context",
      manifests: replaceManifest("evidence-critic", {
        ...validManifests[1],
        freshContext: false,
      }),
      code: "EVALUATOR_NOT_FRESH",
    },
    {
      name: "retrieval access for Answer Composer",
      manifests: replaceManifest("answer-composer", {
        ...validManifests[4],
        tools: ["source.search"],
      }),
      code: "TOOL_DENIED",
    },
    {
      name: "a nonterminal state without a successor",
      manifests: replaceManifest("claim-extractor", {
        ...validManifests[2],
        next: [],
      }),
      code: "UNREACHABLE_STATE",
    },
  ])("rejects $name", ({ manifests, code }) => {
    expect(validateIngestManifests(manifests)).toMatchObject({
      ok: false,
      code,
    });
  });

  it.each([
    "researcher",
    "claim-extractor",
    "claim-reviewer",
    "answer-composer",
  ] as const)("rejects false freshness for %s", (role) => {
    const current = validManifests.find((manifest) => manifest.role === role);
    expect(current).toBeDefined();
    expect(
      validateIngestManifests(
        replaceManifest(role, { ...current!, freshContext: false }),
      ),
    ).toMatchObject({ ok: false, code: "EVALUATOR_NOT_FRESH" });
  });

  it("rejects answer.format for Answer Composer", () => {
    expect(
      validateIngestManifests(
        replaceManifest("answer-composer", {
          ...validManifests[4],
          tools: ["answer.format"],
        }),
      ),
    ).toMatchObject({ ok: false, code: "TOOL_DENIED" });
  });

  it("accepts the exact ingestion roles when every successor reaches the terminal state", () => {
    expect(validateIngestManifests(validManifests)).toEqual({
      ok: true,
      value: true,
    });
  });

  it.each([
    ["researcher", "shell.exec"],
    ["evidence-critic", "source.search"],
    ["claim-extractor", "web.search"],
    ["claim-reviewer", "source.exact"],
    ["answer-composer", "source.search"],
  ] as const)("rejects arbitrary tool %s for %s", (role, tool) => {
    const current = validManifests.find((manifest) => manifest.role === role);
    expect(current).toBeDefined();
    const manifests = replaceManifest(role, {
      ...current!,
      tools: [...current!.tools, tool],
    });
    expect(validateIngestManifests(manifests)).toMatchObject({
      ok: false,
      code: "TOOL_DENIED",
    });
  });

  it("rejects dangling agent and workflow successor references", () => {
    const invalidRole = {
      ...validManifests[0],
      role: "curiosity-planner",
    } as unknown as IngestAgentManifest;
    expect(
      validateIngestManifests([invalidRole, ...validManifests.slice(1)]),
    ).toMatchObject({ ok: false, code: "DANGLING_REFERENCE" });

    const danglingSuccessor = replaceManifest("researcher", {
      ...validManifests[0],
      next: ["curiosity-planner"],
    });
    expect(validateIngestManifests(danglingSuccessor)).toMatchObject({
      ok: false,
      code: "DANGLING_REFERENCE",
    });
  });

  it("rejects roles that are disconnected from the Researcher entry state", () => {
    const disconnected = replaceManifest("evidence-critic", {
      ...validManifests[1],
      next: ["answer-composer"],
    });
    expect(validateIngestManifests(disconnected)).toMatchObject({
      ok: false,
      code: "UNREACHABLE_STATE",
    });
  });

  it.each([
    ["researcher", ["claim-extractor"]],
    ["evidence-critic", ["answer-composer"]],
    ["claim-extractor", ["evidence-critic"]],
    ["claim-reviewer", ["claim-extractor"]],
    ["answer-composer", ["researcher"]],
  ] as const)("rejects invalid successor edges from %s", (role, next) => {
    const current = validManifests.find((manifest) => manifest.role === role);
    expect(current).toBeDefined();
    expect(
      validateIngestManifests(
        replaceManifest(role, { ...current!, next: [...next] }),
      ),
    ).toMatchObject({ ok: false, code: "UNREACHABLE_STATE" });
  });

  it("accepts the Evidence Critic refinement edge back to Researcher", () => {
    expect(
      validateIngestManifests(
        replaceManifest("evidence-critic", {
          ...validManifests[1],
          next: ["researcher", "claim-extractor"],
        }),
      ),
    ).toEqual({ ok: true, value: true });
  });

  it("returns an IngestResult for malformed runtime input", () => {
    expect(
      validateIngestManifests([
        { role: null, tools: "shell.exec" },
      ] as unknown as readonly IngestAgentManifest[]),
    ).toMatchObject({ ok: false, code: "DANGLING_REFERENCE" });
  });

  it("enforces the Draft 2020-12 structural workflow boundary", async () => {
    const schema = JSON.parse(
      await readFile(
        resolveShippedPath(repositoryRoot, "agents", "ingest-workflow.schema.json"),
        "utf8",
      ),
    ) as object;
    const validate = new Ajv2020({ strict: true }).compile(schema);

    expect(validate(validManifests)).toBe(true);
    expect(
      validate([
        validManifests[0],
        validManifests[0],
        ...validManifests.slice(2),
      ]),
    ).toBe(false);
    expect(
      validate(
        replaceManifest("evidence-critic", {
          ...validManifests[1],
          freshContext: false,
        }),
      ),
    ).toBe(false);
    expect(
      validate(
        replaceManifest("answer-composer", {
          ...validManifests[4],
          tools: ["web.search"],
        }),
      ),
    ).toBe(false);
    expect(
      validate(
        replaceManifest("researcher", {
          ...validManifests[0],
          tools: validManifests[0].tools.slice(1),
        }),
      ),
    ).toBe(false);
    expect(
      validate(
        replaceManifest("claim-reviewer", {
          ...validManifests[3],
          outputSchema: "Claim",
        }),
      ),
    ).toBe(false);
    expect(
      validate(
        replaceManifest("claim-reviewer", {
          ...validManifests[3],
          freshContext: false,
        }),
      ),
    ).toBe(false);
  });
});
