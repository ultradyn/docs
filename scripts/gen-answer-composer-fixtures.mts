import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { composeAnswerFromPack } from "../code/ingest/agents/answer-composer-agent.ts";

const QUESTION = "q-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CLM_A = "clm-01ARZ3NDEKTSV4RRFFQ69G5FAA";
const CLM_B = "clm-01ARZ3NDEKTSV4RRFFQ69G5FAB";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const claim = (id: string, statement: string) => ({
  schemaVersion: 2 as const,
  id,
  version: 1,
  statement,
  claimType: "behavior" as const,
  scope: { product: "atlas" },
  authority: "source-doc",
  lifecycle: "current",
  state: "accepted" as const,
  evidenceRefs: [
    {
      snapshotId: `snap-${"b".repeat(64)}`,
      fileId: `file-${"c".repeat(64)}`,
      unitId: "unit-01ARZ3NDEKTSV4RRFFQ69G5FAA",
      fileSha256: sha("f"),
      unitSha256: sha("u"),
    },
  ],
  relationships: {
    qualifierClaimIds: [] as string[],
    contradictsClaimIds: [] as string[],
    supersedesClaimIds: [] as string[],
  },
  createdFrom: {
    questionId: QUESTION,
    packetId: "pkt-01ARZ3NDEKTSV4RRFFQ69G5FAV",
  },
});
const claims = [
  claim(CLM_A, "Atlas stores portable project knowledge in Git."),
  claim(CLM_B, "Settings apply through the documented procedure."),
];
const pack = {
  schemaVersion: 2 as const,
  hash: "a".repeat(64),
  questionId: QUESTION,
  graphRevision: 1,
  claimIds: claims.map((c) => c.id),
  claims,
  qualifierEdges: [] as [],
  citations: claims.map((c) => ({
    claimId: c.id,
    unitId: c.evidenceRefs[0]!.unitId,
    unitSha256: c.evidenceRefs[0]!.unitSha256,
    fileSha256: c.evidenceRefs[0]!.fileSha256,
    snapshotId: c.evidenceRefs[0]!.snapshotId,
  })),
  gaps: [] as string[],
  applicationRefs: [] as [],
};

// 001 — proposed: goal tokens overlap pack statements
const goals1 = [
  {
    goalId: "g-storage",
    text: "Where is portable project knowledge stored in Git?",
  },
];
const r1 = composeAnswerFromPack({
  questionId: QUESTION,
  pack: pack as never,
  goals: goals1,
});
if (!r1.ok) throw new Error(r1.code);
if (r1.value.state !== "proposed") {
  throw new Error(`001 expected proposed, got ${r1.value.state}`);
}
const input1 = { questionId: QUESTION, pack, goals: goals1 };
writeFileSync(
  "scaffold/agents/answer-composer/fixtures/001-input.json",
  JSON.stringify(input1, null, 2),
);
writeFileSync(
  "scaffold/agents/answer-composer/fixtures/001-expected.json",
  JSON.stringify(r1.value, null, 2),
);

// 002 — insufficient_pack: no lexical overlap with pack
const goals2 = [
  {
    goalId: "g-quantum",
    text: "What is the quantum entanglement protocol for payments?",
  },
];
const r2 = composeAnswerFromPack({
  questionId: QUESTION,
  pack: pack as never,
  goals: goals2,
});
if (!r2.ok) throw new Error(r2.code);
if (r2.value.state !== "insufficient_pack") {
  throw new Error(`002 expected insufficient_pack, got ${r2.value.state}`);
}
writeFileSync(
  "scaffold/agents/answer-composer/fixtures/002-input.json",
  JSON.stringify({ questionId: QUESTION, pack, goals: goals2 }, null, 2),
);
writeFileSync(
  "scaffold/agents/answer-composer/fixtures/002-expected.json",
  JSON.stringify(r2.value, null, 2),
);

// 003 — proposed multi-goal: both storage + settings claims selected
const goals3 = [
  {
    goalId: "g-storage",
    text: "Where is portable project knowledge stored in Git?",
  },
  {
    goalId: "g-settings",
    text: "How do settings apply through the documented procedure?",
  },
];
const r3 = composeAnswerFromPack({
  questionId: QUESTION,
  pack: pack as never,
  goals: goals3,
});
if (!r3.ok) throw new Error(r3.code);
if (r3.value.state !== "proposed") {
  throw new Error(`003 expected proposed, got ${r3.value.state}`);
}
writeFileSync(
  "scaffold/agents/answer-composer/fixtures/003-input.json",
  JSON.stringify({ questionId: QUESTION, pack, goals: goals3 }, null, 2),
);
writeFileSync(
  "scaffold/agents/answer-composer/fixtures/003-expected.json",
  JSON.stringify(r3.value, null, 2),
);
console.log("ok", r1.value.state, r2.value.state, r3.value.state);
