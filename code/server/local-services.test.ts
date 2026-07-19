import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { simpleGit } from "simple-git";

import { buildServer, createLocalServices } from "./index.js";
import {
  EnvironmentBearerCredentialSource,
  FakeGitHostProvider,
  FakeLlmProvider,
  type GitHostProvider,
} from "../providers/index.js";
import {
  KnowledgeRepository,
  RepositorySettingsStore,
} from "../repository/index.js";

const shippedAgentsRoot = existsSync(join(process.cwd(), "scaffold", "agents"))
  ? join(process.cwd(), "scaffold", "agents")
  : join(process.cwd(), "agents");
const shippedRepositorySeedRoot = existsSync(join(process.cwd(), "scaffold"))
  ? join(process.cwd(), "scaffold")
  : process.cwd();

async function copyShippedRepositorySeed(destination: string): Promise<void> {
  await Promise.all(
    ["agents", "docs", "goals", "questions", "schemas", "settings"].map(
      (directory) =>
        cp(
          join(shippedRepositorySeedRoot, directory),
          join(destination, directory),
          {
            recursive: true,
          },
        ),
    ),
  );
}

function successfulAnswerOutputs(
  goal: string,
  content: string,
  options: { librarianCalls?: number; path?: string } = {},
) {
  const librarian = Array.from({ length: options.librarianCalls ?? 1 }, () => ({
    status: "insufficient",
    answer: "The current documentation does not satisfy this goal.",
    citations: [],
    unsatisfiedGoals: [goal],
  }));
  return [
    ...librarian,
    {
      title: "Recovery",
      sections: [{ heading: "Procedure", content }],
      correctionsApplied: [],
    },
    {
      done: true,
      goalResults: [
        {
          goal,
          status: "satisfied",
          rationale: "The procedure is explicit.",
        },
      ],
      findings: [],
      deferredQuestions: [],
      contradictions: [],
    },
    {
      edits: [
        {
          path: options.path ?? "docs/recovery.md",
          operation: "create",
          summary: "Document the recovery procedure.",
          content: `# Recovery\n\n${content}\n`,
        },
      ],
      mapUpdates: [],
      rationale: "Adds the missing procedure.",
    },
    { approved: true, findings: [] },
    {
      summary: "Adds the reviewed recovery procedure.",
      changes: ["Documents the exact recovery procedure."],
      risks: [],
    },
    {
      satisfied: true,
      reason: "The post-diff documentation answers the ask.",
      goalResults: [
        {
          goal,
          satisfied: true,
          rationale: "The requested procedure is present.",
        },
      ],
    },
  ];
}

describe("persistent local HTTP workflow", () => {
  const servers: Array<ReturnType<typeof buildServer>> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  async function server(
    root: string,
    options: {
      credentialSources?: EnvironmentBearerCredentialSource[];
      gitHostProvider?: GitHostProvider;
      llmProvider?: FakeLlmProvider;
      maintenanceEnabled?: boolean;
      allowFakeMedia?: boolean;
    } = {},
  ) {
    const app = buildServer({
      services: await createLocalServices({
        repoRoot: root,
        dataRoot: join(root, ".ultradyn", "local"),
        ...(options.credentialSources
          ? { credentialSources: options.credentialSources }
          : {}),
        ...(options.gitHostProvider
          ? { gitHostProvider: options.gitHostProvider }
          : {}),
        ...(options.llmProvider ? { llmProvider: options.llmProvider } : {}),
        ...(options.allowFakeMedia ? { allowFakeMedia: true } : {}),
      }),
      runtime: {
        maintenanceEnabled: options.maintenanceEnabled ?? false,
        demoMode: false,
        repoRoot: root,
        version: "0.1.0-test",
      },
    });
    servers.push(app);
    return app;
  }

  it("preserves a question, raw transcript, and structured answer across a server restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-local-services-"));
    const first = await server(root);
    const logged = await first.inject({
      method: "POST",
      url: "/api/ask",
      payload: {
        question: "How does the bridge recover after a partial journal write?",
        goals: ["implementation"],
        asker: "max",
        chat: "This is needed to implement restart handling.",
      },
    });
    expect(logged.statusCode).toBe(200);
    const id = logged.json().question.id as string;

    expect(
      (
        await first.inject({
          method: "POST",
          url: `/api/questions/${id}/claim`,
          payload: { answerer: "max" },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await first.inject({
          method: "POST",
          url: `/api/questions/${id}/transcripts`,
          payload: {
            text: "Replay from the last verified checkpoint and discard the incomplete tail.",
            source: "typed",
          },
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await first.inject({
          method: "POST",
          url: `/api/questions/${id}/structure`,
        })
      ).statusCode,
    ).toBe(200);

    await first.close();
    servers.splice(servers.indexOf(first), 1);
    const restarted = await server(root);
    const restored = await restarted.inject({
      method: "GET",
      url: `/api/questions/${id}`,
    });

    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({
      id,
      state: "in-answer",
      rawQuestion: "How does the bridge recover after a partial journal write?",
      chat: "This is needed to implement restart handling.",
      structuredAnswer:
        "Replay from the last verified checkpoint and discard the incomplete tail.",
    });
    expect(restored.json().transcripts).toEqual([
      expect.objectContaining({
        source: "typed",
        text: "Replay from the last verified checkpoint and discard the incomplete tail.",
      }),
    ]);
  });

  it("serves the repository-editable goal vocabulary", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-local-goals-"));
    await mkdir(join(root, "goals"), { recursive: true });
    await writeFile(
      join(root, "goals", "vocabulary.md"),
      "# Goals\n\n## disaster-recovery\n\nThe answer must identify the recovery point and prove a restore.\n",
      "utf8",
    );
    const app = await server(root);

    const response = await app.inject({ method: "GET", url: "/api/goals" });

    expect(response.json().items).toEqual([
      expect.objectContaining({
        id: "disaster-recovery",
        label: "Disaster Recovery",
        description:
          "The answer must identify the recovery point and prove a restore.",
      }),
    ]);
  });

  it("stores typed corrections as distinct immutable raw artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-local-correction-"));
    const app = await server(root);
    const logged = await app.inject({
      method: "POST",
      url: "/api/ask",
      payload: {
        question: "Which checkpoint is authoritative?",
        goals: ["implementation"],
        asker: "max",
      },
    });
    const id = logged.json().question.id as string;
    await app.inject({
      method: "POST",
      url: `/api/questions/${id}/claim`,
      payload: { answerer: "max" },
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/questions/${id}/transcripts`,
      payload: {
        text: "Correction: use the last checksum-verified checkpoint.",
        source: "typed",
        kind: "correction",
      },
    });

    expect(response.statusCode).toBe(201);
    const repository = new KnowledgeRepository(root);
    const correction = (await repository.listRawArtifacts(id)).find(
      (artifact) => artifact.kind === "correction",
    );
    expect(correction).toBeDefined();
    expect(await repository.readRawArtifact(id, correction!.path)).toContain(
      "last checksum-verified checkpoint",
    );
  });

  it("requires a claim before audio capture and treats continuing a claim as idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-local-claim-"));
    const app = await server(root);
    const logged = await app.inject({
      method: "POST",
      url: "/api/ask",
      payload: {
        question: "How is capture ownership assigned?",
        goals: ["implementation"],
        asker: "max",
      },
    });
    const id = logged.json().question.id as string;

    const unclaimedAudio = await app.inject({
      method: "POST",
      url: "/api/audio/sessions",
      payload: { questionId: id, mimeType: "audio/webm;codecs=opus" },
    });
    expect(unclaimedAudio.statusCode).toBe(409);

    const first = await app.inject({
      method: "POST",
      url: `/api/questions/${id}/claim`,
      payload: { answerer: "max" },
    });
    const continued = await app.inject({
      method: "POST",
      url: `/api/questions/${id}/claim`,
      payload: { answerer: "max" },
    });
    const competing = await app.inject({
      method: "POST",
      url: `/api/questions/${id}/claim`,
      payload: { answerer: "riley" },
    });
    expect(first.statusCode).toBe(200);
    expect(continued.statusCode).toBe(200);
    expect(continued.json()).toMatchObject({ id, state: "in-answer" });
    expect(competing.statusCode).toBe(409);
    expect(competing.json()).toMatchObject({
      error: { code: "question_already_claimed" },
    });

    const repository = new KnowledgeRepository(root);
    const persisted = await repository.getQuestion(id);
    expect(persisted.provenance.at(-1)).toMatchObject({
      by: "answerer:max",
      details: { to: "in-answer" },
    });
  });

  it("marks the running maintenance interval as restart-required", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "ultradyn-local-settings-schema-"),
    );
    const app = await server(root);

    const response = await app.inject({
      method: "GET",
      url: "/api/settings/schema",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().items).toContainEqual(
      expect.objectContaining({
        key: "server.pollIntervalMinutes",
        restartRequired: true,
      }),
    );
  });

  it("persists a personal actor handle with searchable setting metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-local-identity-"));
    const first = await server(root);

    const schema = await first.inject({
      method: "GET",
      url: "/api/settings/schema",
    });
    expect(schema.json().items).toContainEqual({
      key: "identity.actorHandle",
      category: "Identity & attribution",
      label: "Actor handle",
      description: expect.stringMatching(/attribution.+not authentication/i),
      type: "string",
      scope: "personal",
      default: "",
    });

    const saved = await first.inject({
      method: "PUT",
      url: "/api/settings",
      payload: {
        key: "identity.actorHandle",
        value: "alex.review-1",
        scope: "personal",
      },
    });
    expect(saved.statusCode).toBe(200);

    const invalid = await first.inject({
      method: "PUT",
      url: "/api/settings",
      payload: {
        key: "identity.actorHandle",
        value: "Alex Review",
        scope: "personal",
      },
    });
    expect(invalid.statusCode).toBe(400);

    const restarted = await server(root);
    const values = await restarted.inject({
      method: "GET",
      url: "/api/settings",
    });
    expect(values.json().items).toContainEqual({
      key: "identity.actorHandle",
      value: "alex.review-1",
      scope: "personal",
      source: "personal",
    });
  });

  it("exposes approval and merge of the actual local documentation change", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-local-integration-"));
    await cp(shippedAgentsRoot, join(root, "agents"), { recursive: true });
    const answer =
      "Replay from the last verified checkpoint and ignore the incomplete tail record.";
    const app = await server(root, {
      llmProvider: new FakeLlmProvider({
        outputs: successfulAnswerOutputs("implementation", answer),
      }),
    });
    const logged = await app.inject({
      method: "POST",
      url: "/api/ask",
      payload: {
        question: "How are interrupted writes recovered?",
        goals: ["implementation"],
        asker: "max",
      },
    });
    const id = logged.json().question.id as string;
    await app.inject({
      method: "POST",
      url: `/api/questions/${id}/claim`,
      payload: { answerer: "max" },
    });
    await app.inject({
      method: "POST",
      url: `/api/questions/${id}/transcripts`,
      payload: {
        text: answer,
        source: "typed",
      },
    });
    await app.inject({ method: "POST", url: `/api/questions/${id}/structure` });
    await app.inject({ method: "POST", url: `/api/questions/${id}/critic` });

    const integrated = await app.inject({
      method: "POST",
      url: `/api/questions/${id}/integrate`,
    });
    expect(integrated.statusCode).toBe(200);
    expect(integrated.json()).toMatchObject({
      state: "integrating",
      changeRequest: {
        state: "open",
        branch: expect.stringMatching(
          /^ultradyn-attempts\/cr-[0-9A-HJKMNP-TV-Z]{26}$/u,
        ),
        checks: expect.arrayContaining([
          expect.objectContaining({ status: "passed" }),
        ]),
      },
    });
    expect(integrated.json().changeRequest.diff).toContain(
      "last verified checkpoint",
    );

    const approved = await app.inject({
      method: "POST",
      url: `/api/questions/${id}/change-request/approve`,
      payload: { by: "max", kind: "answerer" },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().changeRequest.state).toBe("approved");

    const merged = await app.inject({
      method: "POST",
      url: `/api/questions/${id}/change-request/merge`,
      payload: { by: "max" },
    });
    expect(merged.statusCode, merged.body).toBe(200);
    expect(merged.json().state).toBe("merged");
    expect(await readFile(join(root, "docs", "recovery.md"), "utf8")).toContain(
      "last verified checkpoint",
    );
    const mergeStatus = await simpleGit(root).status();
    expect(
      [...mergeStatus.modified, ...mergeStatus.not_added].filter(
        (path) => path.startsWith("questions/") || path.startsWith("settings/"),
      ),
    ).toEqual([]);

    const accepted = await app.inject({
      method: "POST",
      url: `/api/questions/${id}/accept`,
      payload: { asker: "max" },
    });
    expect(accepted.json()).toMatchObject({
      state: "accepted",
      bucket: "answered",
    });
  });

  it("creates and merges a distinct active change-request attempt after asker rejection reopens a question", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-reopened-attempt-"));
    await cp(shippedAgentsRoot, join(root, "agents"), { recursive: true });
    const firstAnswer = "Replay only the last verified checkpoint.";
    const revisedAnswer =
      "Replay the last verified checkpoint and reject a corrupt checkpoint before recovery.";
    const app = await server(root, {
      llmProvider: new FakeLlmProvider({
        outputs: [
          ...successfulAnswerOutputs("implementation", firstAnswer),
          ...successfulAnswerOutputs("implementation", revisedAnswer).slice(1),
        ],
      }),
    });
    const logged = await app.inject({
      method: "POST",
      url: "/api/ask",
      payload: {
        question: "How are interrupted writes recovered?",
        goals: ["implementation"],
        asker: "max",
      },
    });
    const id = logged.json().question.id as string;

    async function integrateAttempt(answer: string) {
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/questions/${id}/claim`,
            payload: { answerer: "max" },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/questions/${id}/transcripts`,
            payload: { text: answer, source: "typed" },
          })
        ).statusCode,
      ).toBe(201);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/questions/${id}/structure`,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/questions/${id}/critic`,
          })
        ).statusCode,
      ).toBe(200);
      const integrated = await app.inject({
        method: "POST",
        url: `/api/questions/${id}/integrate`,
      });
      expect(integrated.statusCode, integrated.body).toBe(200);
      return integrated.json().changeRequest as {
        id: string;
        branch: string;
      };
    }

    async function approveAndMerge() {
      const approved = await app.inject({
        method: "POST",
        url: `/api/questions/${id}/change-request/approve`,
        payload: { by: "max", kind: "answerer" },
      });
      expect(approved.statusCode, approved.body).toBe(200);
      const merged = await app.inject({
        method: "POST",
        url: `/api/questions/${id}/change-request/merge`,
        payload: { by: "max" },
      });
      expect(merged.statusCode, merged.body).toBe(200);
    }

    const first = await integrateAttempt(firstAnswer);
    await approveAndMerge();
    const rejected = await app.inject({
      method: "POST",
      url: `/api/questions/${id}/reject`,
      payload: {
        asker: "max",
        reason: "The answer does not explain corrupt-checkpoint handling.",
      },
    });
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(rejected.json().state).toBe("reopened");
    expect(rejected.json()).not.toHaveProperty("changeRequest");

    const second = await integrateAttempt(revisedAnswer);
    expect(second.id).not.toBe(first.id);
    expect(second.branch).not.toBe(first.branch);
    await approveAndMerge();

    expect(await readFile(join(root, "docs", "recovery.md"), "utf8")).toContain(
      "reject a corrupt checkpoint",
    );
    const requests = await app.inject({
      method: "GET",
      url: "/api/change-requests",
    });
    expect(requests.json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.id, state: "merged" }),
        expect.objectContaining({ id: second.id, state: "merged" }),
      ]),
    );
    const accepted = await app.inject({
      method: "POST",
      url: `/api/questions/${id}/accept`,
      payload: { asker: "max" },
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json().state).toBe("accepted");
  });

  it("keeps the default scaffold fake visible but cannot use it to authorize a contradictory merge", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-default-fake-gate-"));
    await copyShippedRepositorySeed(root);
    await writeFile(
      join(root, "docs", "recovery.md"),
      "# Recovery\n\nInterrupted writes are recovered from the last verified checkpoint.\n",
      "utf8",
    );
    const app = await server(root);
    const providers = await app.inject({
      method: "GET",
      url: "/api/providers",
    });
    expect(providers.json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "fake-llm",
          state: "ready",
          fakeAvailable: true,
        }),
      ]),
    );
    const logged = await app.inject({
      method: "POST",
      url: "/api/ask",
      payload: {
        question: "How are interrupted writes recovered?",
        goals: ["implementation"],
        asker: "max",
      },
    });
    const id = logged.json().question.id as string;
    await app.inject({
      method: "POST",
      url: `/api/questions/${id}/claim`,
      payload: { answerer: "max" },
    });
    await app.inject({
      method: "POST",
      url: `/api/questions/${id}/transcripts`,
      payload: {
        text: "Interrupted writes are never recovered and checkpoints are ignored.",
        source: "typed",
      },
    });
    await app.inject({ method: "POST", url: `/api/questions/${id}/structure` });

    const critic = await app.inject({
      method: "POST",
      url: `/api/questions/${id}/critic`,
    });
    expect(critic.statusCode).toBe(409);
    expect(critic.json()).toMatchObject({ error: { code: "llm_unavailable" } });

    const integrated = await app.inject({
      method: "POST",
      url: `/api/questions/${id}/integrate`,
    });
    expect(integrated.statusCode).toBe(409);
    expect(integrated.json()).toMatchObject({
      error: { code: "evaluation_required" },
    });

    const repository = new KnowledgeRepository(root);
    await repository.initialize();
    const current = await repository.getQuestion(id);
    await repository.writeDerived(
      id,
      "answers/evaluation.json",
      `${JSON.stringify({
        done: true,
        goalResults: [
          {
            goal: "implementation",
            status: "satisfied",
            rationale:
              "Legacy deterministic fake marked the contradiction satisfied.",
          },
        ],
        contradictions: [],
        deferredChildren: [],
      })}\n`,
      { expectedRevision: current.revision, by: "legacy-fake-critic" },
    );
    const reviewGate = await app.inject({
      method: "POST",
      url: `/api/questions/${id}/integrate`,
    });
    expect(reviewGate.statusCode).toBe(409);
    expect(reviewGate.json()).toMatchObject({
      error: { code: "integration_review_failed" },
    });
    const requests = await app.inject({
      method: "GET",
      url: "/api/change-requests",
    });
    expect(requests.json().items).toEqual([
      expect.objectContaining({
        state: "blocked",
        checks: expect.arrayContaining([
          expect.objectContaining({ id: "reviewer", status: "failed" }),
          expect.objectContaining({ id: "diff-summary", status: "failed" }),
          expect.objectContaining({ id: "simulated-asker", status: "failed" }),
        ]),
      }),
    ]);
    for (const action of ["approve", "merge"]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/questions/${id}/change-request/${action}`,
        payload:
          action === "approve"
            ? { by: "max", kind: "answerer" }
            : { by: "max" },
      });
      expect(response.statusCode).toBe(409);
    }
  });

  it("deduplicates active questions and waits for every attached asker decision", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-local-askers-"));
    await cp(shippedAgentsRoot, join(root, "agents"), { recursive: true });
    const answer = "Replay from the last verified checkpoint.";
    const app = await server(root, {
      llmProvider: new FakeLlmProvider({
        outputs: successfulAnswerOutputs("implementation", answer, {
          librarianCalls: 2,
          path: "docs/relay-recovery.md",
        }),
      }),
    });
    const question = "How does the relay recover after an interrupted write?";
    const first = await app.inject({
      method: "POST",
      url: "/api/ask",
      payload: { question, goals: ["implementation"], asker: "max" },
    });
    const id = first.json().question.id as string;
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/ask",
      payload: { question, goals: ["implementation"], asker: "alice" },
    });
    expect(duplicate.json()).toMatchObject({
      kind: "logged",
      question: {
        id,
        askers: expect.arrayContaining(["max", "alice"]),
        askerDetails: expect.arrayContaining([
          expect.objectContaining({ id: "max", acceptance: "pending" }),
          expect.objectContaining({ id: "alice", acceptance: "pending" }),
        ]),
      },
    });

    await app.inject({
      method: "POST",
      url: `/api/questions/${id}/claim`,
      payload: { answerer: "max" },
    });
    await app.inject({
      method: "POST",
      url: `/api/questions/${id}/transcripts`,
      payload: { text: answer, source: "typed" },
    });
    await app.inject({ method: "POST", url: `/api/questions/${id}/structure` });
    await app.inject({ method: "POST", url: `/api/questions/${id}/critic` });
    await app.inject({ method: "POST", url: `/api/questions/${id}/integrate` });
    await app.inject({
      method: "POST",
      url: `/api/questions/${id}/change-request/approve`,
      payload: { by: "max", kind: "answerer" },
    });
    await app.inject({
      method: "POST",
      url: `/api/questions/${id}/change-request/merge`,
      payload: { by: "max" },
    });

    const firstDecision = await app.inject({
      method: "POST",
      url: `/api/questions/${id}/accept`,
      payload: { asker: "max" },
    });
    expect(firstDecision.json()).toMatchObject({ state: "merged" });
    const finalDecision = await app.inject({
      method: "POST",
      url: `/api/questions/${id}/accept`,
      payload: { asker: "alice" },
    });
    expect(finalDecision.json()).toMatchObject({
      state: "accepted",
      bucket: "answered",
    });

    const repository = new KnowledgeRepository(root);
    const accepted = await repository.getQuestion(id);
    expect(accepted.askers).toEqual([
      expect.objectContaining({ id: "max", acceptance: "accepted" }),
      expect.objectContaining({ id: "alice", acceptance: "accepted" }),
    ]);

    const artifactsBeforeLateRejection = await repository.listRawArtifacts(id);
    const rejected = await app.inject({
      method: "POST",
      url: `/api/questions/${id}/reject`,
      payload: {
        asker: "alice",
        reason: "It omits the corrupt checkpoint case.",
      },
    });
    expect(rejected.statusCode).toBe(409);
    expect(await repository.getQuestion(id)).toEqual(accepted);
    expect(await repository.listRawArtifacts(id)).toEqual(
      artifactsBeforeLateRejection,
    );
  });

  it("rejects an ineligible asker rejection before appending a raw artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-rejection-preflight-"));
    const app = await server(root);
    const logged = await app.inject({
      method: "POST",
      url: "/api/ask",
      payload: {
        question: "Can I reject before an answer is merged?",
        goals: ["documentation"],
        asker: "max",
      },
    });
    const id = logged.json().question.id as string;
    const repository = new KnowledgeRepository(root);
    const before = await repository.listRawArtifacts(id);

    const rejected = await app.inject({
      method: "POST",
      url: `/api/questions/${id}/reject`,
      payload: {
        asker: "max",
        reason: "There is no merged answer to reject.",
      },
    });

    expect(rejected.statusCode).toBe(409);
    expect(rejected.json()).toMatchObject({
      error: { code: "asker_decision_unavailable" },
    });
    expect(await repository.listRawArtifacts(id)).toEqual(before);
  });

  it("publishes exactly one rejection artifact for concurrent duplicate public rejections", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "ultradyn-concurrent-rejection-"),
    );
    const repository = new KnowledgeRepository(root);
    await repository.initialize();
    const created = await repository.createQuestion({
      title: "Can duplicate rejection race?",
      verbatimQuestion: "Can duplicate rejection race?",
      goals: ["implementation"],
      asker: { id: "max", acceptance: "pending" },
      origin: { kind: "raw" },
    });
    const claimed = await repository.transition(created.id, {
      to: "in-answer",
      expectedRevision: created.revision,
      by: "answerer:max",
    });
    const integrating = await repository.transition(created.id, {
      to: "integrating",
      expectedRevision: claimed.revision,
      by: "integrator",
    });
    const merged = await repository.transition(created.id, {
      to: "merged",
      expectedRevision: integrating.revision,
      by: "maintainer:max",
    });
    const app = await server(root);
    const request = () =>
      app.inject({
        method: "POST",
        url: `/api/questions/${created.id}/reject`,
        payload: {
          asker: "max",
          reason: "The answer omits duplicate rejection recovery.",
        },
      });

    const responses = await Promise.all([request(), request()]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      200, 409,
    ]);
    const artifacts = await repository.listRawArtifacts(created.id);
    expect(
      artifacts.filter((artifact) => artifact.kind === "rejection"),
    ).toHaveLength(1);
    const reopened = await repository.getQuestion(created.id);
    expect(reopened).toMatchObject({
      state: "reopened",
      tier: "P1",
      revision: merged.revision + 1,
      askers: [expect.objectContaining({ id: "max", acceptance: "rejected" })],
    });
    expect(
      reopened.provenance.filter((event) => event.type === "rejected"),
    ).toHaveLength(1);
  });

  it("rejects an asker value that cannot produce an honest stable identifier", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-local-asker-id-"));
    const app = await server(root);

    const response = await app.inject({
      method: "POST",
      url: "/api/ask",
      payload: {
        question: "Which actor asked this question?",
        goals: ["implementation"],
        asker: "!!!",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "invalid_identifier" },
    });
  });

  it("rejects duplicate Ask goals before persistence while preserving ordered distinct goals", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-ask-goals-"));
    const app = await server(root);
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/ask",
      payload: {
        question: "Can duplicate goals be stored?",
        goals: ["implementation", "implementation"],
        asker: "max",
      },
    });

    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.json()).toMatchObject({
      error: { code: "invalid_request" },
    });
    const repository = new KnowledgeRepository(root);
    expect(await repository.listQuestions()).toEqual([]);

    const distinct = await app.inject({
      method: "POST",
      url: "/api/ask",
      payload: {
        question: "In what order are distinct goals stored?",
        goals: ["security-review", "implementation"],
        asker: "max",
      },
    });
    expect(distinct.statusCode, distinct.body).toBe(200);
    expect(distinct.json().question.goals).toEqual([
      "security-review",
      "implementation",
    ]);
  });

  it("keeps display-name askers distinct from colliding stable handles", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "ultradyn-local-asker-collision-"),
    );
    const app = await server(root);
    const question = "Who must accept the collision-safe answer?";

    const first = await app.inject({
      method: "POST",
      url: "/api/ask",
      payload: { question, goals: ["implementation"], asker: "John Doe" },
    });
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/ask",
      payload: { question, goals: ["implementation"], asker: "john-doe" },
    });

    expect(first.statusCode, first.body).toBe(200);
    expect(duplicate.statusCode, duplicate.body).toBe(200);
    const askers = duplicate.json().question.askerDetails as Array<{
      id: string;
      name: string;
    }>;
    expect(askers).toHaveLength(2);
    expect(askers).toContainEqual(
      expect.objectContaining({
        id: expect.stringMatching(/^john-doe-[0-9a-f]+$/u),
        name: "John Doe",
      }),
    );
    expect(askers).toContainEqual(
      expect.objectContaining({ id: "john-doe", name: "john-doe" }),
    );
  });

  it("hashes the full display name when long asker names share a prefix", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-local-long-askers-"));
    const app = await server(root);
    const question = "Which long-name askers are waiting?";
    const sharedPrefix = "long-asker-name-".repeat(8);
    const names = [`${sharedPrefix}alpha`, `${sharedPrefix}bravo`];

    for (const asker of names) {
      const response = await app.inject({
        method: "POST",
        url: "/api/ask",
        payload: { question, goals: ["implementation"], asker },
      });
      expect(response.statusCode, response.body).toBe(200);
    }

    const questions = await app.inject({
      method: "GET",
      url: "/api/questions",
    });
    const askers = questions.json().items[0].askerDetails as Array<{
      id: string;
      name: string;
    }>;
    expect(askers.map((asker) => asker.id)).toHaveLength(2);
    expect(new Set(askers.map((asker) => asker.id)).size).toBe(2);
    expect(askers.every((asker) => asker.id.length <= 96)).toBe(true);
    expect(askers.map((asker) => asker.name)).toEqual(names);
  });

  it("promotes a matching deferred question to active P2 demand", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-local-promotion-"));
    const repository = new KnowledgeRepository(root);
    await repository.initialize();
    const deferred = await repository.createQuestion({
      title: "Which codec flags preserve speech timing?",
      verbatimQuestion: "Which codec flags preserve speech timing?",
      goals: ["implementation"],
      asker: { id: "generated", acceptance: "pending" },
      origin: {
        kind: "generated",
        parentQuestionId: "q-01J00000000000000000000000",
        findingId: "f-01J00000000000000000000000",
        goal: "implementation",
      },
      depth: 1,
    });
    expect(deferred).toMatchObject({ state: "deferred", tier: "P4" });
    const app = await server(root);

    const result = await app.inject({
      method: "POST",
      url: "/api/ask",
      payload: {
        question: "Which codec flags preserve speech timing?",
        goals: ["implementation"],
        asker: "max",
      },
    });

    expect(result.json()).toMatchObject({
      kind: "logged",
      question: { id: deferred.id, state: "active", tier: "P2" },
    });
    expect((await repository.getQuestion(deferred.id)).askers).toEqual([
      expect.objectContaining({ id: "generated" }),
      expect.objectContaining({ id: "max" }),
    ]);
  });

  it("retains a fuzzy matched ask as a new immutable question artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-local-fuzzy-ask-"));
    const repository = new KnowledgeRepository(root);
    await repository.initialize();
    const originalQuestion = "Which codec flags preserve speech timing?";
    const matchedQuestion =
      "Which speech codec flags preserve timing during streamed capture?";
    const existing = await repository.createQuestion({
      title: originalQuestion,
      verbatimQuestion: originalQuestion,
      goals: ["implementation"],
      asker: { id: "max", acceptance: "pending" },
      origin: { kind: "raw" },
    });
    const [originalArtifact] = await repository.listRawArtifacts(existing.id);
    const app = await server(root);

    const response = await app.inject({
      method: "POST",
      url: "/api/ask",
      payload: {
        question: matchedQuestion,
        goals: ["implementation"],
        asker: "alice",
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      kind: "logged",
      question: { id: existing.id },
    });
    const questionArtifacts = (
      await repository.listRawArtifacts(existing.id)
    ).filter((artifact) => artifact.kind === "question");
    expect(questionArtifacts).toHaveLength(2);
    expect(questionArtifacts[0]).toEqual(originalArtifact);
    expect(
      await repository.readRawArtifact(existing.id, questionArtifacts[0]!.path),
    ).toBe(originalQuestion);
    expect(
      await repository.readRawArtifact(existing.id, questionArtifacts[1]!.path),
    ).toBe(matchedQuestion);
  });

  it("merges matched acceptance goals and retains new chat without changing prior raw artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-local-matched-goals-"));
    const repository = new KnowledgeRepository(root);
    await repository.initialize();
    const question = "How does the relay recover after an interrupted write?";
    const originalChat = "Max needs the implementation sequence.";
    const matchedChat =
      "Alice also needs the threat boundary and operator recovery steps.";
    const existing = await repository.createQuestion({
      title: question,
      verbatimQuestion: question,
      chatlog: originalChat,
      goals: ["implementation"],
      asker: { id: "max", acceptance: "pending" },
      origin: { kind: "raw" },
    });
    const originalArtifacts = await repository.listRawArtifacts(existing.id);
    const app = await server(root);

    const response = await app.inject({
      method: "POST",
      url: "/api/ask",
      payload: {
        question,
        goals: ["security-review", "operations"],
        asker: "alice",
        chat: matchedChat,
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      kind: "logged",
      question: {
        id: existing.id,
        goals: ["implementation", "security-review", "operations"],
      },
    });
    const artifacts = await repository.listRawArtifacts(existing.id);
    expect(artifacts.slice(0, originalArtifacts.length)).toEqual(
      originalArtifacts,
    );
    const chatArtifacts = artifacts.filter(
      (artifact) => artifact.kind === "chatlog",
    );
    expect(chatArtifacts).toHaveLength(2);
    expect(
      await repository.readRawArtifact(existing.id, chatArtifacts[0]!.path),
    ).toBe(originalChat);
    expect(
      await repository.readRawArtifact(existing.id, chatArtifacts[1]!.path),
    ).toBe(matchedChat);
    expect((await repository.getQuestion(existing.id)).provenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "raw-artifact-appended",
          by: "matcher",
          details: expect.objectContaining({
            kind: "question",
            askerId: "alice",
            requestedGoals: ["security-review", "operations"],
            addedGoals: ["security-review", "operations"],
          }),
        }),
        expect.objectContaining({
          type: "raw-artifact-appended",
          by: "matcher",
          details: expect.objectContaining({
            kind: "chatlog",
            askerId: "alice",
          }),
        }),
      ]),
    );
  });

  it("persists each credential scope independently and rejects unadvertised scopes", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-local-consent-"));
    const reads: string[] = [];
    const source = new EnvironmentBearerCredentialSource({
      id: "xai-test-env",
      label: "Test xAI environment",
      providerId: "xai",
      variable: "XAI_TEST_TOKEN",
      scopes: ["model", "transcription"],
      readEnvironment: (name) => {
        reads.push(name);
        return "test-secret";
      },
    });
    const first = await server(root, { credentialSources: [source] });

    const before = await first.inject({ method: "GET", url: "/api/providers" });
    expect(before.json().items).toContainEqual(
      expect.objectContaining({
        id: "xai-test-env",
        state: "consent_required",
      }),
    );
    expect(reads).toEqual([]);

    const granted = await first.inject({
      method: "POST",
      url: "/api/providers/xai-test-env/consent",
      payload: { scope: "model", granted: true },
    });
    expect(granted.json()).toMatchObject({
      id: "xai-test-env",
      state: "consent_required",
      consentScopes: [
        {
          scope: "model",
          consent: "granted",
          availability: "available",
        },
        {
          scope: "transcription",
          consent: "required",
          availability: "unknown",
        },
      ],
    });
    expect(reads.length).toBeGreaterThan(0);

    const unsupported = await first.inject({
      method: "POST",
      url: "/api/providers/xai-test-env/consent",
      payload: { scope: "git-host", granted: true },
    });
    expect(unsupported.statusCode).toBe(400);
    expect(unsupported.json()).toMatchObject({
      error: { code: "unsupported_provider_scope" },
    });

    await first.close();
    servers.splice(servers.indexOf(first), 1);
    reads.splice(0);
    const restarted = await server(root, { credentialSources: [source] });
    const after = await restarted.inject({
      method: "GET",
      url: "/api/providers",
    });
    expect(after.json().items).toContainEqual(
      expect.objectContaining({
        id: "xai-test-env",
        state: "consent_required",
        consentScopes: [
          expect.objectContaining({ scope: "model", consent: "granted" }),
          expect.objectContaining({
            scope: "transcription",
            consent: "required",
          }),
        ],
      }),
    );
    expect(reads.length).toBeGreaterThan(0);

    const transcription = await restarted.inject({
      method: "POST",
      url: "/api/providers/xai-test-env/consent",
      payload: { scope: "transcription", granted: true },
    });
    expect(transcription.json()).toMatchObject({ state: "ready" });

    const revokedModel = await restarted.inject({
      method: "POST",
      url: "/api/providers/xai-test-env/consent",
      payload: { scope: "model", granted: false },
    });
    expect(revokedModel.json()).toMatchObject({
      state: "consent_required",
      consentScopes: [
        expect.objectContaining({ scope: "model", consent: "revoked" }),
        expect.objectContaining({
          scope: "transcription",
          consent: "granted",
        }),
      ],
    });
  });

  it("answers from existing repository documentation with a direct citation", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-local-retrieval-"));
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(
      join(root, "docs", "recovery.md"),
      "# Bridge recovery\n\nAfter an interrupted write, replay from the last verified checkpoint and discard the incomplete journal tail.\n",
      "utf8",
    );
    const app = await server(root);

    const answer = await app.inject({
      method: "POST",
      url: "/api/ask",
      payload: {
        question: "How does bridge recovery handle an interrupted write?",
        goals: ["documentation"],
        asker: "max",
      },
    });
    const queue = await app.inject({ method: "GET", url: "/api/questions" });

    expect(answer.json()).toMatchObject({
      kind: "answer",
      citations: [{ path: "docs/recovery.md", title: "Bridge recovery" }],
      goalResults: [{ goal: "documentation", status: "satisfied" }],
    });
    expect(answer.json().answer).toContain("last verified checkpoint");
    expect(queue.json().items).toEqual([]);
  });

  it("does not treat a lexical document match as proof of non-documentation goals", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-local-goal-routing-"));
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(
      join(root, "docs", "recovery.md"),
      "# Bridge recovery\n\nAfter an interrupted write, replay from the last verified checkpoint.\n",
      "utf8",
    );
    const app = await server(root);

    const response = await app.inject({
      method: "POST",
      url: "/api/ask",
      payload: {
        question: "How does bridge recovery handle an interrupted write?",
        goals: ["security-review"],
        asker: "max",
      },
    });

    expect(response.json()).toMatchObject({
      kind: "logged",
      question: { goals: ["security-review"] },
    });
  });

  it("uses a selected LLM through the schema-valid Librarian contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-local-librarian-"));
    await cp(shippedAgentsRoot, join(root, "agents"), {
      recursive: true,
    });
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(
      join(root, "docs", "operator.md"),
      "# Operator guide\n\nThe amber switch transfers control to the standby relay.\n",
      "utf8",
    );
    const llm = new FakeLlmProvider({
      outputs: [
        {
          status: "answered",
          answer: "Use the amber switch to transfer control.",
          citations: [
            {
              path: "docs/operator.md",
              claim: "The amber switch transfers control to the standby relay.",
            },
          ],
          unsatisfiedGoals: [],
        },
      ],
    });
    const app = await server(root, { llmProvider: llm });

    const response = await app.inject({
      method: "POST",
      url: "/api/ask",
      payload: {
        question: "How do I move authority to the alternate device?",
        goals: ["operations"],
        asker: "max",
      },
    });

    expect(response.json()).toMatchObject({
      kind: "answer",
      answer: "Use the amber switch to transfer control.",
      citations: [{ path: "docs/operator.md" }],
    });
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]?.agent.name).toBe("librarian");
    expect(
      (await app.inject({ method: "GET", url: "/api/questions" })).json().items,
    ).toEqual([]);
  });

  it("logs only the goals a grounded partial Librarian answer leaves unsatisfied", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "ultradyn-local-librarian-partial-"),
    );
    await cp(shippedAgentsRoot, join(root, "agents"), { recursive: true });
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(
      join(root, "docs", "operator.md"),
      "# Operator guide\n\nThe relay uses checksum verification before recovery.\n",
      "utf8",
    );
    const llm = new FakeLlmProvider({
      outputs: [
        {
          status: "insufficient",
          answer:
            "Checksum verification is documented, but the threat model is not.",
          citations: [
            {
              path: "docs/operator.md",
              claim: "The relay uses checksum verification before recovery.",
            },
          ],
          unsatisfiedGoals: ["security-review"],
        },
      ],
    });
    const app = await server(root, { llmProvider: llm });

    const response = await app.inject({
      method: "POST",
      url: "/api/ask",
      payload: {
        question: "How does relay recovery satisfy its threat model?",
        goals: ["documentation", "security-review"],
        asker: "max",
      },
    });

    expect(response.json()).toMatchObject({
      kind: "logged",
      partialAnswer:
        "Checksum verification is documented, but the threat model is not.",
      citations: [{ path: "docs/operator.md" }],
      question: { goals: ["security-review"] },
    });
  });

  it("runs the selected LLM Structurer against immutable transcript inputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-local-structurer-"));
    await cp(shippedAgentsRoot, join(root, "agents"), {
      recursive: true,
    });
    const repository = new KnowledgeRepository(root);
    await repository.initialize();
    const created = await repository.createQuestion({
      title: "How is journal recovery performed?",
      verbatimQuestion: "How is journal recovery performed?",
      goals: ["implementation"],
      asker: { id: "max", acceptance: "pending" },
      origin: { kind: "raw" },
    });
    const llm = new FakeLlmProvider({
      outputs: [
        {
          title: "Journal recovery",
          sections: [
            {
              heading: "Recovery point",
              content: "Replay the last checksum-verified checkpoint.",
            },
          ],
          correctionsApplied: [],
        },
      ],
    });
    const app = await server(root, { llmProvider: llm });
    await app.inject({
      method: "POST",
      url: `/api/questions/${created.id}/claim`,
      payload: { answerer: "max" },
    });
    await app.inject({
      method: "POST",
      url: `/api/questions/${created.id}/transcripts`,
      payload: {
        text: "Replay from the verified checkpoint.",
        source: "typed",
      },
    });

    const structured = await app.inject({
      method: "POST",
      url: `/api/questions/${created.id}/structure`,
    });

    expect(structured.statusCode, structured.body).toBe(200);
    expect(structured.json().structuredAnswer).toContain(
      "# Journal recovery\n\n## Recovery point",
    );
    expect(llm.requests[0]?.agent.name).toBe("structurer");
    expect(JSON.parse(llm.requests[0]!.messages[0]!.content)).toMatchObject({
      question: "How is journal recovery performed?",
      transcripts: ["Replay from the verified checkpoint."],
    });
  });

  it("turns Critic depth gaps into deferred children and contradictions into active P1 work", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-local-critic-"));
    await cp(shippedAgentsRoot, join(root, "agents"), {
      recursive: true,
    });
    const repository = new KnowledgeRepository(root);
    await repository.initialize();
    const created = await repository.createQuestion({
      title: "How is a checkpoint selected?",
      verbatimQuestion: "How is a checkpoint selected?",
      goals: ["implementation"],
      asker: { id: "max", acceptance: "pending" },
      origin: { kind: "raw" },
    });
    const claimed = await repository.transition(created.id, {
      to: "in-answer",
      expectedRevision: created.revision,
      by: "answerer:max",
    });
    await repository.writeDerived(
      created.id,
      "answers/structured.md",
      "# Selection\n\nUse the verified checkpoint.\n",
      { expectedRevision: claimed.revision, by: "structurer" },
    );
    const llm = new FakeLlmProvider({
      outputs: [
        {
          done: true,
          goalResults: [
            {
              goal: "implementation",
              status: "deferred",
              rationale:
                "The main path is answered; codec tuning is optional depth.",
            },
          ],
          findings: [
            {
              category: "depth",
              text: "Codec tuning is extra detail.",
              blocking: false,
            },
            {
              category: "contradiction",
              text: "Two sources claim the newest checkpoint wins.",
              blocking: true,
            },
          ],
          deferredQuestions: [
            {
              question: "Which codec tuning flags preserve checkpoint timing?",
              goal: "implementation",
              extraDetail: true,
            },
          ],
          contradictions: ["Two sources claim the newest checkpoint wins."],
        },
      ],
    });
    const app = await server(root, { llmProvider: llm });

    const reviewed = await app.inject({
      method: "POST",
      url: `/api/questions/${created.id}/critic`,
    });

    expect(reviewed.statusCode, reviewed.body).toBe(200);
    expect(reviewed.json().evaluation).toMatchObject({
      done: false,
      contradictions: ["Two sources claim the newest checkpoint wins."],
      deferredChildren: [
        expect.objectContaining({
          state: "deferred",
          tier: "P5",
          tags: expect.arrayContaining(["extra-detail"]),
        }),
      ],
    });
    const children = (await repository.listQuestions()).filter(
      (question) => question.id !== created.id,
    );
    expect(children).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: "deferred", tier: "P5" }),
        expect.objectContaining({
          state: "active",
          tier: "P1",
          tags: expect.arrayContaining(["contradiction"]),
        }),
      ]),
    );
    expect(llm.requests[0]?.agent.name).toBe("critic");
  });

  it("gates LLM integration through fresh Reviewer and Simulated Asker contexts", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "ultradyn-local-agent-integration-"),
    );
    await cp(shippedAgentsRoot, join(root, "agents"), {
      recursive: true,
    });
    const repository = new KnowledgeRepository(root);
    await repository.initialize();
    const created = await repository.createQuestion({
      title: "How does recovery work?",
      verbatimQuestion: "How does recovery work?",
      chatlog: "I need the operational recovery point.",
      goals: ["implementation"],
      asker: { id: "max", acceptance: "pending" },
      origin: { kind: "raw" },
    });
    const claimed = await repository.transition(created.id, {
      to: "in-answer",
      expectedRevision: created.revision,
      by: "answerer:max",
    });
    const structured = await repository.writeDerived(
      created.id,
      "answers/structured.md",
      "# Recovery\n\nReplay from the last checksum-verified checkpoint.\n",
      { expectedRevision: claimed.revision, by: "structurer" },
    );
    await repository.writeDerived(
      created.id,
      "answers/evaluation.json",
      `${JSON.stringify({
        done: true,
        goalResults: [
          {
            goal: "implementation",
            status: "satisfied",
            rationale: "The recovery point is explicit.",
          },
        ],
        contradictions: [],
        deferredChildren: [],
      })}\n`,
      { expectedRevision: structured.revision, by: "critic" },
    );
    const llm = new FakeLlmProvider({
      outputs: [
        {
          edits: [
            {
              path: "docs/recovery.md",
              operation: "create",
              summary: "Document the recovery point.",
              content:
                "# Recovery\n\nReplay from the last checksum-verified checkpoint.\n",
            },
          ],
          mapUpdates: [],
          rationale: "Adds the missing recovery procedure.",
        },
        { approved: true, findings: [] },
        {
          summary: "Adds the checksum-verified recovery procedure.",
          changes: ["Documents the exact checkpoint used for replay."],
          risks: [],
        },
        {
          satisfied: true,
          reason: "The procedure identifies the operational recovery point.",
          goalResults: [
            {
              goal: "implementation",
              satisfied: true,
              rationale: "The replay point is explicit.",
            },
          ],
        },
      ],
    });
    const app = await server(root, { llmProvider: llm });

    const integrated = await app.inject({
      method: "POST",
      url: `/api/questions/${created.id}/integrate`,
    });

    expect(integrated.statusCode, integrated.body).toBe(200);
    expect(integrated.json()).toMatchObject({
      state: "integrating",
      changeRequest: {
        state: "open",
        summary: "Adds the checksum-verified recovery procedure.",
        checks: expect.arrayContaining([
          expect.objectContaining({ id: "reviewer", status: "passed" }),
          expect.objectContaining({ id: "diff-summary", status: "passed" }),
          expect.objectContaining({ id: "simulated-asker", status: "passed" }),
        ]),
      },
    });
    expect(integrated.json().changeRequest.diff).toContain("docs/recovery.md");
    await expect(
      readFile(join(root, "docs", "recovery.md"), "utf8"),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(llm.requests.map((request) => request.agent.name)).toEqual([
      "integrator",
      "reviewer",
      "diff-summarizer",
      "simulated-asker",
    ]);
    const actualDiff = integrated.json().changeRequest.diff as string;
    expect(JSON.parse(llm.requests[1]!.messages[0]!.content)).toMatchObject({
      question: "How does recovery work?",
      structuredAnswer:
        "# Recovery\n\nReplay from the last checksum-verified checkpoint.\n",
      diff: actualDiff,
    });
    expect(JSON.parse(llm.requests[2]!.messages[0]!.content)).toEqual({
      diff: actualDiff,
    });
    expect(JSON.parse(llm.requests[3]!.messages[0]!.content)).toMatchObject({
      verbatimQuestion: "How does recovery work?",
      verbatimChat: "I need the operational recovery point.",
      goals: ["implementation"],
      postDiffDocumentation: [
        {
          path: "docs/recovery.md",
          content:
            "# Recovery\n\nReplay from the last checksum-verified checkpoint.\n",
        },
      ],
    });
  });

  it("persists a failed actual-diff gate and retries the same branch without rerunning Integrator", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-actual-diff-retry-"));
    await cp(shippedAgentsRoot, join(root, "agents"), { recursive: true });
    const repository = new KnowledgeRepository(root);
    await repository.initialize();
    const created = await repository.createQuestion({
      title: "When does recovery begin?",
      verbatimQuestion: "When does recovery begin?",
      goals: ["implementation"],
      asker: { id: "max", acceptance: "pending" },
      origin: { kind: "raw" },
    });
    const claimed = await repository.transition(created.id, {
      to: "in-answer",
      expectedRevision: created.revision,
      by: "answerer:max",
    });
    const structured = await repository.writeDerived(
      created.id,
      "answers/structured.md",
      "# Recovery trigger\n\nBegin recovery when the journal tail checksum is invalid.\n",
      { expectedRevision: claimed.revision, by: "structurer" },
    );
    await repository.writeDerived(
      created.id,
      "answers/evaluation.json",
      `${JSON.stringify({
        done: true,
        goalResults: [
          {
            goal: "implementation",
            status: "satisfied",
            rationale: "The trigger is explicit.",
          },
        ],
        contradictions: [],
        deferredChildren: [],
      })}\n`,
      { expectedRevision: structured.revision, by: "critic" },
    );

    const failingLlm = new FakeLlmProvider({
      outputs: [
        {
          edits: [
            {
              path: "docs/recovery-trigger.md",
              operation: "create",
              summary: "Document the recovery trigger.",
              content:
                "# Recovery trigger\n\nBegin recovery when the journal tail checksum is invalid.\n",
            },
          ],
          mapUpdates: [],
          rationale: "Documents the recovery trigger.",
        },
        {
          approved: false,
          findings: [
            {
              severity: "blocking",
              text: "The actual diff does not name who verifies the checksum.",
            },
          ],
        },
        {
          summary: "Adds a recovery-trigger page.",
          changes: ["Defines the invalid-tail trigger."],
          risks: ["Checksum ownership remains unspecified."],
        },
        {
          satisfied: true,
          reason: "The trigger itself is answered.",
          goalResults: [
            {
              goal: "implementation",
              satisfied: true,
              rationale: "The invalid checksum starts recovery.",
            },
          ],
        },
      ],
    });
    const first = await server(root, { llmProvider: failingLlm });
    const failed = await first.inject({
      method: "POST",
      url: `/api/questions/${created.id}/integrate`,
    });

    expect(failed.statusCode, failed.body).toBe(409);
    const blocked = await first.inject({
      method: "GET",
      url: `/api/questions/${created.id}`,
    });
    expect(blocked.json()).toMatchObject({
      state: "in-answer",
      changeRequest: {
        state: "blocked",
        summary: "Adds a recovery-trigger page.",
        checks: expect.arrayContaining([
          expect.objectContaining({
            id: "reviewer",
            status: "failed",
            detail: expect.stringContaining("who verifies"),
          }),
          expect.objectContaining({ id: "diff-summary", status: "passed" }),
        ]),
      },
    });
    const changeRequestId = blocked.json().changeRequest.id as string;
    const actualDiff = blocked.json().changeRequest.diff as string;
    expect(JSON.parse(failingLlm.requests[1]!.messages[0]!.content).diff).toBe(
      actualDiff,
    );

    await first.close();
    servers.splice(servers.indexOf(first), 1);
    const retryLlm = new FakeLlmProvider({
      outputs: [
        { approved: true, findings: [] },
        {
          summary: "Adds the reviewed recovery-trigger page.",
          changes: ["Defines the invalid-tail trigger."],
          risks: [],
        },
        {
          satisfied: true,
          reason: "The trigger answers the question.",
          goalResults: [
            {
              goal: "implementation",
              satisfied: true,
              rationale: "The trigger is explicit.",
            },
          ],
        },
      ],
    });
    const restarted = await server(root, { llmProvider: retryLlm });
    const retried = await restarted.inject({
      method: "POST",
      url: `/api/questions/${created.id}/integrate`,
    });

    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json()).toMatchObject({
      state: "integrating",
      changeRequest: {
        id: changeRequestId,
        state: "open",
        summary: "Adds the reviewed recovery-trigger page.",
        diff: actualDiff,
      },
    });
    expect(retryLlm.requests.map((request) => request.agent.name)).toEqual([
      "reviewer",
      "diff-summarizer",
      "simulated-asker",
    ]);
    expect(JSON.parse(retryLlm.requests[0]!.messages[0]!.content).diff).toBe(
      actualDiff,
    );
    expect(JSON.parse(retryLlm.requests[1]!.messages[0]!.content)).toEqual({
      diff: actualDiff,
    });
  });

  it("supersedes a stored proposal when current integration input changes without rerunning Integrator for comparison", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-current-input-"));
    await cp(shippedAgentsRoot, join(root, "agents"), { recursive: true });
    const repository = new KnowledgeRepository(root);
    await repository.initialize();
    const created = await repository.createQuestion({
      title: "Who verifies recovery?",
      verbatimQuestion: "Who verifies the recovery checksum?",
      goals: ["implementation"],
      asker: { id: "max", acceptance: "pending" },
      origin: { kind: "raw" },
    });
    const claimed = await repository.transition(created.id, {
      to: "in-answer",
      expectedRevision: created.revision,
      by: "answerer:max",
    });
    let current = await repository.writeDerived(
      created.id,
      "answers/structured.md",
      "# Recovery owner\n\nThe service verifies the checksum.\n",
      { expectedRevision: claimed.revision, by: "structurer" },
    );
    current = await repository.writeDerived(
      created.id,
      "answers/evaluation.json",
      `${JSON.stringify({
        done: true,
        goalResults: [
          {
            goal: "implementation",
            status: "satisfied",
            rationale: "The owner is explicit.",
          },
        ],
        contradictions: [],
        deferredChildren: [],
      })}\n`,
      { expectedRevision: current.revision, by: "critic" },
    );
    const firstLlm = new FakeLlmProvider({
      outputs: [
        {
          edits: [
            {
              path: "docs/recovery-owner.md",
              operation: "create",
              summary: "Document checksum ownership.",
              content:
                "# Recovery owner\n\nThe service verifies the checksum.\n",
            },
          ],
          mapUpdates: [],
          rationale: "Documents checksum ownership.",
        },
        {
          approved: false,
          findings: [
            {
              severity: "blocking",
              text: "The answer does not name the operator escalation.",
            },
          ],
        },
        {
          summary: "Documents checksum ownership.",
          changes: ["Names the checksum verifier."],
          risks: ["Escalation remains unclear."],
        },
        {
          satisfied: false,
          reason: "Escalation remains unclear.",
          goalResults: [
            {
              goal: "implementation",
              satisfied: false,
              rationale: "The operational escalation is missing.",
            },
          ],
        },
      ],
    });
    const first = await server(root, { llmProvider: firstLlm });
    const failed = await first.inject({
      method: "POST",
      url: `/api/questions/${created.id}/integrate`,
    });
    expect(failed.statusCode, failed.body).toBe(409);
    const blocked = await first.inject({
      method: "GET",
      url: `/api/questions/${created.id}`,
    });
    const priorId = blocked.json().changeRequest.id as string;
    await first.close();
    servers.splice(servers.indexOf(first), 1);

    await repository.writeDerived(
      created.id,
      "answers/structured.md",
      "# Recovery owner\n\nThe service verifies the checksum and the maintainer handles escalation.\n",
      { expectedRevision: current.revision, by: "structurer" },
    );
    const retryLlm = new FakeLlmProvider({
      outputs: [
        { approved: true, findings: [] },
        {
          summary: "Reviews checksum ownership and escalation.",
          changes: ["Checks the revised answer against the stored proposal."],
          risks: [],
        },
        {
          satisfied: true,
          reason: "Ownership and escalation are explicit.",
          goalResults: [
            {
              goal: "implementation",
              satisfied: true,
              rationale: "Both responsibilities are named.",
            },
          ],
        },
      ],
    });
    const restarted = await server(root, { llmProvider: retryLlm });
    const retried = await restarted.inject({
      method: "POST",
      url: `/api/questions/${created.id}/integrate`,
    });

    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json().changeRequest.id).not.toBe(priorId);
    expect(retryLlm.requests.map((request) => request.agent.name)).toEqual([
      "reviewer",
      "diff-summarizer",
      "simulated-asker",
    ]);
    expect(
      JSON.parse(retryLlm.requests[0]!.messages[0]!.content).structuredAnswer,
    ).toContain("maintainer handles escalation");
    const requests = await restarted.inject({
      method: "GET",
      url: "/api/change-requests",
    });
    expect(requests.json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: priorId, state: "superseded" }),
      ]),
    );
  });

  it("finalizes durable audio through the selected fake STT contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-local-audio-"));
    const app = await server(root, { allowFakeMedia: true });
    const logged = await app.inject({
      method: "POST",
      url: "/api/ask",
      payload: {
        question: "What does the undocumented relay do?",
        goals: ["documentation"],
        asker: "max",
      },
    });
    const questionId = logged.json().question.id as string;
    await app.inject({
      method: "POST",
      url: `/api/questions/${questionId}/claim`,
      payload: { answerer: "max" },
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/audio/sessions",
      payload: { questionId, mimeType: "audio/webm;codecs=opus" },
    });
    const sessionId = created.json().id as string;
    await app.inject({
      method: "PUT",
      url: `/api/audio/sessions/${sessionId}/chunks/0`,
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from("fake-browser-audio"),
    });

    const finalized = await app.inject({
      method: "POST",
      url: `/api/audio/sessions/${sessionId}/finalize`,
    });

    expect(finalized.statusCode).toBe(200);
    expect(finalized.json()).toMatchObject({
      id: sessionId,
      state: "ready",
      transcript: "Deterministic fake transcript.",
    });
  });

  it("does not label fake codec or STT output as a normal recording", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-local-fake-media-"));
    const app = await server(root);
    const logged = await app.inject({
      method: "POST",
      url: "/api/ask",
      payload: {
        question: "How is fake media identified?",
        goals: ["documentation"],
        asker: "max",
      },
    });
    const questionId = logged.json().question.id as string;
    await app.inject({
      method: "POST",
      url: `/api/questions/${questionId}/claim`,
      payload: { answerer: "max" },
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/audio/sessions",
      payload: { questionId, mimeType: "audio/webm;codecs=opus" },
    });

    expect(created.statusCode).toBe(409);
    expect(created.json()).toMatchObject({
      error: { code: "fake_media_selected" },
    });
  });

  it("reports shipped agent fixtures and keeps Agent-Smith work blocked until fresh evaluation", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-local-agents-"));
    await cp(shippedAgentsRoot, join(root, "agents"), {
      recursive: true,
    });
    const app = await server(root);
    const agents = await app.inject({ method: "GET", url: "/api/agents" });

    expect(agents.statusCode).toBe(200);
    expect(agents.json().agents).toHaveLength(17);
    expect(agents.json().agents).toContainEqual(
      expect.objectContaining({
        id: "critic",
        fixtureStatus: "passing",
        fixtureCount: 3,
        schemaStatus: "valid",
      }),
    );
    expect(agents.json().agents).toContainEqual(
      expect.objectContaining({
        id: "researcher",
        fixtureStatus: "passing",
        fixtureCount: 3,
        schemaStatus: "valid",
      }),
    );
    expect(agents.json().agents).toContainEqual(
      expect.objectContaining({
        id: "evidence-critic",
        fixtureStatus: "passing",
        fixtureCount: 3,
        schemaStatus: "valid",
      }),
    );
    const fixtures = await app.inject({
      method: "POST",
      url: "/api/agents/critic/fixtures",
    });
    expect(fixtures.json()).toMatchObject({
      name: "critic",
      cases: 3,
      valid: true,
    });

    const proposal = await app.inject({
      method: "POST",
      url: "/api/agents/agent-smith",
      payload: {
        mode: "create",
        request:
          "Explain recovery decisions from a constrained repository view.",
      },
    });
    expect(proposal.statusCode).toBe(201);
    expect(proposal.json()).toMatchObject({
      agent: expect.stringMatching(/recovery/),
      changeRequest: {
        state: "blocked",
        branch: expect.stringMatching(/^ultradyn-attempts\/cr-/u),
        checks: expect.arrayContaining([
          expect.objectContaining({ id: "reviewer", status: "failed" }),
          expect.objectContaining({ id: "diff-summary", status: "failed" }),
          expect.objectContaining({ id: "simulated-asker", status: "failed" }),
        ]),
      },
    });
    expect(proposal.json().changeRequest.diff).toContain("/agent.md");
    expect(proposal.json().changeRequest.diff).toContain("/schema.json");
    expect(proposal.json().changeRequest.diff).toContain("001-input.json");
    await expect(
      readFile(join(root, "agents", proposal.json().agent, "agent.md"), "utf8"),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    const changeRequestId = proposal.json().changeRequest.id as string;
    for (const action of ["approve", "merge"]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/change-requests/${changeRequestId}/${action}`,
        payload:
          action === "approve"
            ? { by: "maintainer", kind: "maintainer" }
            : { by: "maintainer" },
      });
      expect(response.statusCode).toBe(409);
    }
    await expect(
      readFile(join(root, "agents", proposal.json().agent, "agent.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports a malformed agent directory as an invalid agent row", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-local-invalid-agent-"));
    const directory = join(root, "agents", "broken-agent");
    await mkdir(join(directory, "fixtures"), { recursive: true });
    await writeFile(
      join(directory, "agent.md"),
      "not valid agent frontmatter\n",
    );
    const app = await server(root);

    const response = await app.inject({ method: "GET", url: "/api/agents" });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().agents).toEqual([
      expect.objectContaining({
        id: "broken-agent",
        fixtureStatus: "failing",
        schemaStatus: "invalid",
        role: expect.stringMatching(/frontmatter/iu),
      }),
    ]);
  });

  it("polls an injected Git host and persists maintenance review tasks", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-local-maintenance-"));
    const gitHost = new FakeGitHostProvider();
    gitHost.tasks.push({
      id: "event-12-head",
      changeRequestId: "12",
      revision: "head-one",
      reason: "review-requested",
    });
    const first = await server(root, {
      gitHostProvider: gitHost,
      maintenanceEnabled: true,
    });
    const polled = await first.inject({
      method: "POST",
      url: "/api/maintenance/run",
    });

    expect(polled.statusCode, polled.body).toBe(202);
    expect(polled.json().items).toContainEqual(
      expect.objectContaining({
        id: `fake-git-host:local/${root.split("/").at(-1)}#12`,
        kind: "review",
        status: "open",
      }),
    );

    await first.close();
    servers.splice(servers.indexOf(first), 1);
    const restarted = await server(root, {
      gitHostProvider: gitHost,
      maintenanceEnabled: true,
    });
    const restored = await restarted.inject({
      method: "GET",
      url: "/api/maintenance",
    });
    expect(restored.json().items).toContainEqual(
      expect.objectContaining({
        kind: "review",
        title: "Review change request #12",
      }),
    );
  });

  it("surfaces one pending portable-state checkpoint when automatic commits are disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-local-checkpoint-"));
    const git = simpleGit(root);
    await git.init(["--initial-branch=main"]);
    await git.raw([
      "-c",
      "user.name=Ultradyn Docs Test",
      "-c",
      "user.email=test@ultradyn.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "Initialize test repository",
    ]);
    const app = await server(root, { maintenanceEnabled: true });
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/settings",
          payload: {
            key: "review.checkpointCommits",
            value: false,
            scope: "repo",
          },
        })
      ).statusCode,
    ).toBe(200);
    await app.inject({
      method: "POST",
      url: "/api/ask",
      payload: {
        question: "Which portable state still needs a checkpoint?",
        goals: ["operations"],
        asker: "max",
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/maintenance",
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ pendingCheckpoints: 1 });
    expect(response.json().items).toContainEqual(
      expect.objectContaining({
        id: "checkpoint:portable-state",
        kind: "checkpoint",
        title: "Checkpoint pending portable state",
        status: "open",
        detail: expect.stringMatching(
          /automatic checkpoint commits are disabled.+questions\/.+settings\//iu,
        ),
      }),
    );
  });

  it("keeps local maintenance work visible when the Git host needs activation", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-local-provider-task-"));
    const git = simpleGit(root);
    await git.init(["--initial-branch=main"]);
    await git.raw([
      "-c",
      "user.name=Ultradyn Docs Test",
      "-c",
      "user.email=test@ultradyn.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "Initialize test repository",
    ]);
    const unavailableGitHost: GitHostProvider = {
      id: "fake-git-host",
      status: async () => ({
        id: "fake-git-host",
        kind: "git-host",
        label: "Unavailable test Git host",
        availability: "available",
        consent: "required",
        streaming: "none",
        reason: "Grant Git-host consent and sign in.",
      }),
      publish: async () => {
        throw new Error("not used");
      },
      poll: async () => {
        throw new Error("not used");
      },
    };
    const app = await server(root, {
      gitHostProvider: unavailableGitHost,
      maintenanceEnabled: true,
    });
    await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: {
        key: "review.checkpointCommits",
        value: false,
        scope: "repo",
      },
    });
    await app.inject({
      method: "POST",
      url: "/api/ask",
      payload: {
        question: "Which local task survives provider activation?",
        goals: ["operations"],
        asker: "max",
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/maintenance",
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "checkpoint:portable-state" }),
        expect.objectContaining({
          id: "provider:git-host",
          kind: "provider",
          status: "open",
          detail: expect.stringMatching(/consent.+sign in/iu),
        }),
      ]),
    );
  });

  it("does not turn unrelated Git-host failures into provider tasks", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "ultradyn-local-provider-error-"),
    );
    const brokenGitHost: GitHostProvider = {
      id: "fake-git-host",
      status: async () => ({
        id: "fake-git-host",
        kind: "git-host",
        label: "Broken test Git host",
        availability: "available",
        consent: "not-applicable",
        streaming: "none",
      }),
      publish: async () => {
        throw new Error("not used");
      },
      poll: async () => {
        throw new Error("corrupt provider response");
      },
    };
    const app = await server(root, {
      gitHostProvider: brokenGitHost,
      maintenanceEnabled: true,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/maintenance/run",
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      error: { code: "internal_error" },
    });
  });

  it("timeout-accepts every silent asker during maintenance without implying endorsement", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-local-timeout-"));
    const repository = new KnowledgeRepository(root, {
      now: () => "2020-01-01T00:00:00.000Z",
    });
    await repository.initialize();
    const created = await repository.createQuestion({
      title: "Will silence strand this answer?",
      verbatimQuestion: "Will silence strand this answer?",
      goals: ["documentation"],
      asker: { id: "max", acceptance: "pending" },
      origin: { kind: "raw" },
    });
    const attached = await repository.attachAsker(created.id, {
      asker: { id: "alice", acceptance: "pending" },
      expectedRevision: created.revision,
      by: "matcher",
    });
    const claimed = await repository.transition(created.id, {
      to: "in-answer",
      expectedRevision: attached.revision,
      by: "answerer:max",
    });
    const integrating = await repository.transition(created.id, {
      to: "integrating",
      expectedRevision: claimed.revision,
      by: "integrator",
    });
    await repository.transition(created.id, {
      to: "merged",
      expectedRevision: integrating.revision,
      by: "maintainer:max",
    });
    const settings = new RepositorySettingsStore(
      root,
      join(root, ".ultradyn", "settings.json"),
    );
    await settings.writeProject({
      schemaVersion: 1,
      acceptanceTimeoutDays: 1,
      integrationMode: "manual",
      maintenance: { enabled: true, pollIntervalMinutes: 15 },
      providers: {
        llm: "fake-llm",
        stt: "fake-stt",
        codec: "fake-codec",
        gitHost: "fake-git-host",
      },
    });
    const app = await server(root, { maintenanceEnabled: true });

    const run = await app.inject({
      method: "POST",
      url: "/api/maintenance/run",
    });
    expect(run.statusCode).toBe(202);
    const accepted = await repository.getQuestion(created.id);
    expect(accepted.state).toBe("accepted");
    expect(accepted.askers.map((asker) => asker.acceptance)).toEqual([
      "timed-out",
      "timed-out",
    ]);
    expect(
      accepted.provenance.filter((event) => event.type === "timeout-accepted"),
    ).toHaveLength(2);
  });
});
