import { describe, expect, it } from "vitest";

import {
  filterSettings,
  normaliseQuestion,
  normaliseQuestionList,
  recorderLabel,
  sortQuestions,
  type SettingDefinition,
} from "./model.js";

describe("web route behavior", () => {
  it("adapts queue responses and keeps priority order stable", () => {
    const questions = normaliseQuestionList({
      items: [
        {
          id: "q-later",
          question: "Later",
          priority: "P4",
          state: "deferred",
          created: "2026-01-01",
        },
        {
          id: "q-first",
          title: "First",
          tier: "P1",
          state: "active",
          createdAt: "2026-02-01",
        },
      ],
    });

    expect(sortQuestions(questions).map((question) => question.id)).toEqual([
      "q-first",
      "q-later",
    ]);
    expect(questions[0]?.title).toBe("Later");
    expect(questions[0]?.tier).toBe("P4");
  });

  it("preserves a complete fallback question when an API record is sparse", () => {
    expect(normaliseQuestion({ id: "q-01" })).toMatchObject({
      id: "q-01",
      title: "Untitled question",
      goals: [],
      tier: "P3",
      state: "active",
    });
  });

  it("preserves stable asker identities and acceptance state", () => {
    expect(
      normaliseQuestion({
        id: "q-askers",
        askerDetails: [
          { id: "max", name: "Max", acceptance: "pending" },
          { id: "alice", name: "Alice", acceptance: "accepted" },
        ],
      }).askers,
    ).toEqual([
      { id: "max", name: "Max", status: "pending" },
      { id: "alice", name: "Alice", status: "accepted" },
    ]);
  });

  it("preserves the literal local change request and its review gates", () => {
    const question = normaliseQuestion({
      id: "q-01",
      title: "Recovery",
      state: "integrating",
      changeRequest: {
        id: "cr-01",
        state: "open",
        branch: "ultradyn/q-01",
        summary: "Adds recovery guidance.",
        diff: "diff --git a/docs/recovery.md b/docs/recovery.md",
        checks: [
          {
            id: "diff-check",
            label: "Git diff check",
            status: "passed",
            detail: "Clean.",
          },
        ],
        approvals: [],
        createdAt: "2026-07-16T00:00:00.000Z",
        updatedAt: "2026-07-16T00:00:00.000Z",
      },
    });

    expect(question.changeRequest).toMatchObject({
      state: "open",
      branch: "ultradyn/q-01",
      checks: [{ id: "diff-check", status: "passed" }],
    });
    expect(question.changeRequest?.diff).toContain("docs/recovery.md");
  });

  it("filters setting definitions across scope, category, label, and description", () => {
    const settings: SettingDefinition[] = [
      {
        key: "answer.autoStructure",
        label: "Structure automatically",
        description: "Run the Structurer after transcription.",
        category: "Answering",
        scope: "repo",
        type: "boolean",
        defaultValue: true,
      },
      {
        key: "appearance.compact",
        label: "Compact density",
        description: "Use less vertical space.",
        category: "Appearance",
        scope: "personal",
        type: "boolean",
        defaultValue: false,
      },
    ];

    expect(
      filterSettings(settings, {
        query: "transcription",
        scope: "all",
        category: "all",
      }),
    ).toHaveLength(1);
    expect(
      filterSettings(settings, {
        query: "",
        scope: "personal",
        category: "all",
      })[0]?.key,
    ).toBe("appearance.compact");
    expect(
      filterSettings(settings, {
        query: "",
        scope: "all",
        category: "Answering",
      })[0]?.scope,
    ).toBe("repo");
  });

  it("describes every recorder state without relying on color", () => {
    expect(recorderLabel("requesting")).toBe("Requesting microphone access");
    expect(recorderLabel("recording")).toBe("Recording and uploading");
    expect(recorderLabel("paused")).toBe("Recording paused");
    expect(recorderLabel("failed")).toBe("Recording needs attention");
  });
});
