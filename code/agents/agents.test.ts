import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { FakeLlmProvider } from "../providers/index.js";
import {
  AgentOutputValidationError,
  AgentRuntime,
  loadAgentDefinition,
  validateAgentFixtures,
} from "./index.js";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const shippedAgentsRoot = existsSync(join(repositoryRoot, "scaffold", "agents"))
  ? join(repositoryRoot, "scaffold", "agents")
  : join(repositoryRoot, "agents");

async function writeAgent(
  root: string,
  prompt: string,
  schema: object,
): Promise<void> {
  const directory = join(root, "diff-summarizer");
  await mkdir(join(directory, "fixtures"), { recursive: true });
  await writeFile(
    join(directory, "agent.md"),
    `---\nname: diff-summarizer\ndescription: Summarize an actual diff.\ninputPolicy: diff-summarizer\nmaxAttempts: 2\n---\n${prompt}\n`,
  );
  await writeFile(join(directory, "schema.json"), JSON.stringify(schema));
}

describe("agent runtime public seam", () => {
  it("loads definitions dynamically on every invocation and validates structured output", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-agents-"));
    await writeAgent(root, "First prompt", {
      type: "object",
      additionalProperties: false,
      required: ["summary"],
      properties: { summary: { type: "string" } },
    });
    const provider = new FakeLlmProvider({
      outputs: [{ summary: "first" }, { summary: "second" }],
    });
    const runtime = new AgentRuntime({ definitionsRoot: root, provider });

    expect(
      await runtime.invoke("diff-summarizer", {
        diff: "+ first",
        secretPlan: "do not pass",
      }),
    ).toEqual({
      summary: "first",
    });
    await writeAgent(root, "Changed prompt", {
      type: "object",
      additionalProperties: false,
      required: ["summary"],
      properties: { summary: { type: "string", minLength: 1 } },
    });
    expect(
      await runtime.invoke("diff-summarizer", { diff: "+ second" }),
    ).toEqual({ summary: "second" });
    expect(provider.requests[0]?.agent.prompt).toContain("First prompt");
    expect(provider.requests[1]?.agent.prompt).toContain("Changed prompt");
  });

  it("projects evaluator inputs so fresh calls cannot receive producer plans or prior context", async () => {
    const root = shippedAgentsRoot;
    const provider = new FakeLlmProvider({
      outputs: [
        {
          summary: "Changed the index docs.",
          changes: ["Documented regeneration."],
          risks: [],
        },
        {
          satisfied: true,
          reason: "The post-diff view answers the verbatim ask.",
          goalResults: [
            {
              goal: "implementation",
              satisfied: true,
              rationale: "Steps are present.",
            },
          ],
        },
      ],
    });
    let invocation = 0;
    const runtime = new AgentRuntime({
      definitionsRoot: root,
      provider,
      invocationId: () => `fresh-${++invocation}`,
    });
    await runtime.invoke("diff-summarizer", {
      diff: "+ durable index instructions",
      integratorPlan: "Intent that must not leak",
      previousConversation: "Producer context that must not leak",
    });
    await runtime.invoke("simulated-asker", {
      verbatimQuestion: "How do I rebuild it?",
      verbatimChat: "I need implementation detail.",
      goals: ["implementation"],
      postDiffDocumentation: "Run ultradyn docs index regenerate.",
      integratorPlan: "must not leak",
    });

    expect(
      JSON.parse(provider.requests[0]?.messages[0]?.content ?? "{}"),
    ).toEqual({
      diff: "+ durable index instructions",
    });
    expect(
      JSON.parse(provider.requests[1]?.messages[0]?.content ?? "{}"),
    ).toEqual({
      verbatimQuestion: "How do I rebuild it?",
      verbatimChat: "I need implementation detail.",
      goals: ["implementation"],
      postDiffDocumentation: "Run ultradyn docs index regenerate.",
    });
    expect(provider.requests.map((request) => request.invocationId)).toEqual([
      "fresh-1",
      "fresh-2",
    ]);
  });

  it("requires Simulated Asker callers to declare verbatim chat even when it is empty", async () => {
    const provider = new FakeLlmProvider({
      outputs: [
        {
          satisfied: true,
          reason: "The post-diff view answers the ask.",
          goalResults: [
            {
              goal: "implementation",
              satisfied: true,
              rationale: "The required steps are present.",
            },
          ],
        },
      ],
    });
    const runtime = new AgentRuntime({
      definitionsRoot: shippedAgentsRoot,
      provider,
    });

    await expect(
      runtime.invoke("simulated-asker", {
        verbatimQuestion: "How do I rebuild it?",
        goals: ["implementation"],
        postDiffDocumentation: "Run the rebuild command.",
      }),
    ).rejects.toThrow(/verbatimChat/);
    expect(provider.requests).toHaveLength(0);
  });

  it("rejects schema-invalid model output after a bounded fresh retry", async () => {
    const root = shippedAgentsRoot;
    const provider = new FakeLlmProvider({
      outputs: [{ summary: 42 }, { stillWrong: true }],
    });
    const runtime = new AgentRuntime({ definitionsRoot: root, provider });
    await expect(
      runtime.invoke("diff-summarizer", { diff: "+ x" }),
    ).rejects.toBeInstanceOf(AgentOutputValidationError);
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0]?.invocationId).not.toBe(
      provider.requests[1]?.invocationId,
    );
  });

  it("ships all sixteen definitions with at least three schema-valid golden fixtures", async () => {
    const results = await validateAgentFixtures(shippedAgentsRoot);
    expect(results).toHaveLength(16);
    expect(results.map((result) => result.name).sort()).toEqual([
      "agent-smith",
      "claim-extractor",
      "claim-reviewer",
      "critic",
      "diff-summarizer",
      "evidence-critic",
      "goal-clerk",
      "integrator",
      "librarian",
      "matcher",
      "prioritizer",
      "registrar",
      "researcher",
      "reviewer",
      "simulated-asker",
      "structurer",
    ]);
    expect(results.every((result) => result.cases >= 3 && result.valid)).toBe(
      true,
    );
    expect(
      (await loadAgentDefinition(shippedAgentsRoot, "critic")).prompt,
    ).toMatch(/contradiction/i);
  });

  it("ships behavioural golden coverage for every non-legacy agent (B008)", async () => {
    const { validateAgentBehaviouralGoldens } = await import(
      "./golden-behaviour.js"
    );
    const behavioural = await validateAgentBehaviouralGoldens(shippedAgentsRoot);
    const failed = behavioural.filter((r) => !r.valid);
    expect(
      failed,
      failed.map((f) => `${f.name}: ${f.errors.join("; ")}`).join(" | "),
    ).toEqual([]);
  });
});
