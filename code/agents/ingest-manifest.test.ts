import { describe, expect, it } from "vitest";

import { type IngestAgentManifest, validateIngestManifests } from "./index.js";

const validManifests = [
  {
    role: "researcher",
    outputSchema: "EvidencePacket",
    tools: ["source.search", "source.read"],
    freshContext: false,
    next: ["evidence-critic"],
  },
  {
    role: "evidence-critic",
    outputSchema: "EvidenceVerdict",
    tools: [],
    freshContext: true,
    next: ["claim-extractor"],
  },
  {
    role: "claim-extractor",
    outputSchema: "Claim",
    tools: [],
    freshContext: false,
    next: ["claim-reviewer"],
  },
  {
    role: "claim-reviewer",
    outputSchema: "ClaimReview",
    tools: [],
    freshContext: true,
    next: ["answer-composer"],
  },
  {
    role: "answer-composer",
    outputSchema: "AnswerComposition",
    tools: [],
    freshContext: false,
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

  it("accepts the exact ingestion roles when every successor reaches the terminal state", () => {
    expect(validateIngestManifests(validManifests)).toEqual({
      ok: true,
      value: true,
    });
  });

  it("allows Answer Composer non-retrieval tools", () => {
    const manifests = replaceManifest("answer-composer", {
      ...validManifests[4],
      tools: ["answer.format"],
    });
    expect(validateIngestManifests(manifests)).toEqual({
      ok: true,
      value: true,
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

  it("rejects cycles that cannot reach Answer Composer", () => {
    const cyclic = replaceManifest("claim-reviewer", {
      ...validManifests[3],
      next: ["claim-extractor"],
    });
    expect(validateIngestManifests(cyclic)).toMatchObject({
      ok: false,
      code: "UNREACHABLE_STATE",
    });
  });
});
