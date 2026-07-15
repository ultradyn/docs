# Ultradyn Docs — Self-Review

Document 5 of 6 · Cross-referencing pass over docs 01–04 + architecture.html. Issues are ordered by severity. "Fixed" means the fix is already applied in the bundle; "Open" means a decision or work item remains.

---

## Issues found and fixed

**1. The Matcher didn't check the active queue.** (Fixed — 02, 03, HTML.)
Docs 02/03 had the Matcher deduplicating new questions against *deferred* and *answered* only. Two people asking the same in-flight question would create duplicate records and duplicate answering work — the exact failure the Matcher exists to prevent, in the window where it's most likely (hot topics get asked repeatedly *while* unanswered). Fix: Matcher checks active + deferred + answered; an active match attaches the new asker to the in-flight question.

**2. The Simulated Asker lost the chat log.** (Fixed — 02, 03, HTML.)
The design conversation explicitly concluded the asker-simulation must run against the raw question *plus the surrounding chat log*, because the cleaned question launders away the asker's context. The roster and flows had drifted to "raw question + goals". Fix: chat log restored to the Simulated Asker's inputs everywhere. This was a live demonstration of the context-laundering failure the check exists to catch.

**3. Merged questions could strand on asker silence.** (Fixed — 03 §7.3.)
The lifecycle had `Merged → Accepted` only via explicit asker acceptance; a non-responding asker left questions in `merged` forever. Fix: timeout-accept (configurable, default 14 days) logged distinctly in provenance so a timeout-accept is never mistaken for an endorsement.

**4. `index.jsonl` had an undefined concurrent-write story.** (Fixed — 03 §2.)
Concurrent answer branches both rewriting index lines produce merge conflicts with no stated resolution. Fix: the index is declared *committed-but-regenerable* — derived from the question folders, conflicts resolved by regeneration, never by hand. This keeps the readable-map benefit without inventing a locking scheme.

**5. Goal Clerk existed in the roster but not in the Ask flow.** (Fixed — 03 §7.1.)
Spec now states the intake sequence: Clerk suggests tags, asker confirms, ≥1 tag with `documentation` default. Closes the gap between "askers tag goals" (01) and "who nudges toward the vocabulary" (03 §5).

## Deliberate resolutions (not defects, but worth flagging)

**6. Agent-change review gating: resolved to Max's relaxed position.** The conversation contained a disagreement — Claude argued agent-definition changes should default to manual review (machinery errors compound); Max preferred relaxing this and containing fragility in libraries instead. Docs 02 §5 / 03 §7.4 implement Max's position: agent changes flow through the same PR lane as docs, relaxed by default, with the fixture-CI mechanism retained because it's cheap and makes stricter gating a one-line config change if experience demands it. The disagreement itself is preserved in the transcript (doc 04) per the project's own provenance principle.

**7. Belt-and-braces audio ignore.** Audio lives outside the repo (`~/.ultradyn-docs/audio/`), yet `.gitignore` also contains `**/audio/`. Redundant by design: the gitignore entry is insurance against a future in-repo capture path — protecting C3 twice costs one line.

## Open items (no fix in this bundle)

**8. Mermaid diagrams are unrendered-verified.** Syntax was checked by inspection, not by rendering (no headless browser in the build environment). First action on receipt: open `architecture.html` and confirm all seven diagrams render; mermaid v10 is pinned via cdnjs so drift is bounded. Low risk, nonzero.

**9. Deferred-question garbage collection.** P5 questions could accumulate indefinitely. Demand-promotion handles the important ones; nothing archives the rest. Proposal (undecided): periodic Agent-Smith-style sweep proposing `archived` state for P5 items untouched for N months, via PR. Deliberately left out of v1 — accumulation is cheap in git, and premature GC risks deleting the long tail the log exists to keep.

**10. Per-goal critic guidelines are unwritten.** The vocabulary seeds (implementation, security-review, …) name goals but their satisfaction criteria — what the critic's ✔ actually requires per goal — are stubs. This is the highest-leverage prompt-engineering work in the project and should be fitted from real transcripts, not invented up front (same philosophy as the P1–P5 rules).

**11. Transcript quality is trusted.** The design re-derives everything from transcripts but has no check that a transcript faithfully captured the audio (C3's whole point). Cheap partial: capture STT confidence scores into the transcript frontmatter and flag low-confidence segments to the answerer during the Structurer round. Needs a decision on STT vendor first (open).

**12. Unquantified friction claims.** Doc 01 asserts "< 30s to submit" and "critic rounds faster than dictation." Plausible, unmeasured; treat as targets, and instrument both in v1.

## Cross-reference verification summary

- Priority tiers: identical across 02 §6, 03 §6, HTML, and the conversation (contradiction ⇒ P1; rejection-reopen ⇒ P1; demand-promotion ⇒ P2; depth decay P4/P5). ✔
- Lifecycle states: 02 state diagram ↔ 03 §4 frontmatter enum ↔ HTML — consistent after fix 3. ✔
- Repo layout: 03 §2 ↔ HTML repo diagram ↔ C1/C2 constraints. ✔ (`.ultradyn-docs/` derived dir appears in 03 only; HTML shows it generically as "derived, gitignored" — acceptable abstraction.)
- ULID decision: consistent in 01 C5, 02, 03 §3; conversation's hash-prefix idea appears only in the transcript, marked superseded by context. ✔
- Fresh-context mandate: C6 ↔ roster "isolated ∎" rows ↔ 03 §7.3.2 — consistent; Structurer correctly *exempted* (it shares the answer session by design). ✔
- Terminology: "goal tags" vs "goals" used interchangeably in 01; standardized on "goal tags" for the UI surface and "goals" for evaluation semantics — acceptable, glossary deferred to v1 docs. ✔
