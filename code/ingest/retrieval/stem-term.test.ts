/**
 * B005 — stemmer processTerm pins (morphology + symmetry contract).
 */
import MiniSearch from "minisearch";
import { describe, expect, it } from "vitest";

import { processLexicalTerm } from "./stem-term.js";

describe("processLexicalTerm (B005)", () => {
  it("stems morphology near-miss pairs to the same form", () => {
    expect(processLexicalTerm("capabilities")).toBe(
      processLexicalTerm("capability"),
    );
    expect(processLexicalTerm("locally")).toBe(processLexicalTerm("local"));
    expect(processLexicalTerm("operate")).toBe(processLexicalTerm("operation"));
  });

  it("returns null for empty tokens", () => {
    expect(processLexicalTerm("")).toBeNull();
  });

  it("wires symmetrically: index+query stem recovers provider unit for local query", () => {
    const docs = [
      {
        id: "small-unit-22",
        text: "# Provider — Every external capability boundary has a deterministic fake for local operation.",
        path: "22-provider.md",
      },
      {
        id: "small-unit-18",
        text: "# Machine index — A machine index is disposable, rebuilt from HEAD, and never committed.",
        path: "18-machine-index.md",
      },
    ];
    const withStem = new MiniSearch({
      fields: ["text", "path"],
      storeFields: ["id", "path"],
      processTerm: processLexicalTerm,
      searchOptions: { boost: { text: 2 }, fuzzy: 0.15, prefix: true },
    });
    withStem.addAll(docs);
    const withoutStem = new MiniSearch({
      fields: ["text", "path"],
      storeFields: ["id", "path"],
      searchOptions: { boost: { text: 2 }, fuzzy: 0.15, prefix: true },
    });
    withoutStem.addAll(docs);

    const q = "What capabilities must operate locally?";
    const stemmedHits = withStem.search(q).map((h) => String(h.id));
    const plainHits = withoutStem.search(q).map((h) => String(h.id));

    expect(plainHits).not.toContain("small-unit-22");
    expect(stemmedHits).toContain("small-unit-22");
    // Zero lexical overlap: stemmer must NOT invent unit-18.
    expect(stemmedHits).not.toContain("small-unit-18");
  });
});
