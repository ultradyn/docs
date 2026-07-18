# Evidence and Claim Protocol

## 1. Purpose

This protocol makes the transition from search results to accepted reusable knowledge explicit. It prevents fluent answer generation from hiding weak retrieval or unsupported synthesis.

## 2. Evidence packet structure

An EvidencePacket is scoped to one question generation and contains:

- raw and canonical question;
- goals, facets, scope, and expected answer type;
- source snapshot and retrieval build IDs;
- search receipt;
- ordered evidence references;
- a proposed role for every reference;
- proposed facet support mapping;
- explicit gaps and conflicts;
- previous packet ID and addressed criticism for refinements.

Reference roles:

```text
primary
qualifying
example
context_only
conflict
historical
```

The Researcher may explain why a reference was selected but may not synthesize the final answer.

## 3. Evidence Critic contract

The Evidence Critic independently opens all material references and returns:

### Reference review

```text
necessary_primary
necessary_qualifying
useful_example
context_only
redundant
irrelevant
wrong_scope
deprecated_for_scope
conflicting
unverifiable
```

### Per-facet state

```text
satisfied
partial
missing
conflicting
ambiguous_scope
unsupported_in_snapshot
not_applicable
```

### Terminal verdict

```text
accepted
needs_more_evidence
ambiguous_scope
conflicting_or_deprecated
no_supported_answer
human_authority_required
source_processing_blocked
search_incomplete
```

A packet is `accepted` only when every required facet is satisfied, all material qualifiers are represented, and no unnecessary reference is being used to create a misleading appearance of support.

## 4. Minimal complete evidence

The Evidence Critic optimizes for the smallest set that fully supports the required facets and qualifiers. It does not require every related source passage.

Source coverage is checked elsewhere. This distinction prevents both:

- citation bloat; and
- silent exclusion of uncited source content.

## 5. Refinement loop

A `needs_more_evidence` verdict contains a bounded request:

```yaml
missing_facets:
  - authentication-failure-behavior
required_search:
  subject: token validation errors
  scope: public API v2
  exclusions:
    - client SDK retry behavior
why_current_packet_fails: ...
```

The next Researcher packet records which criticism it addresses. Repeated requests that add no new search obligation do not loop indefinitely.

## 6. No-evidence standard

A no-evidence outcome requires:

- a valid and sufficiently broad search receipt;
- no unresolved retrieval failure;
- aliases and likely terminology considered;
- relevant maps/sections inspected;
- the Evidence Critic agreeing that the absence conclusion is justified.

The durable outcome is “not supported by snapshot S under search configuration R,” not “false” or “unknown in the world.”

## 7. Claim extraction

After evidence acceptance, the Claim Extractor proposes atomic claims. Rules:

1. A claim expresses one independently reviewable proposition.
2. Material conditions, exceptions, version, environment, and time are preserved.
3. A claim does not state rationale or intent unless the source does.
4. Procedures may produce ordered step claims plus precondition/outcome claims.
5. Examples are typed as examples and cannot silently become universal behavior.
6. Unknown boundaries are valid claims when the source explicitly establishes them.
7. Contradictory propositions remain separate proposed claims pending resolution.

## 8. Claim review

The Claim Reviewer evaluates:

- entailment by exact evidence;
- overstatement or unjustified generalization;
- missing qualifiers;
- scope compatibility;
- authority/lifecycle classification;
- atomicity and reuse;
- duplicate/variant/contradiction candidates;
- whether source extraction quality permits acceptance.

Possible outcomes:

```text
accept
accept_with_qualifier
split
merge_candidate
reject_unsupported
reject_wrong_scope
needs_authority
needs_extraction_repair
```

Only accepted claims enter answer/document packs.

## 9. Evidence diversity and common-mode checks

High-impact claims SHOULD be checked for source diversity where possible:

- independent documents;
- current policy plus operational procedure;
- implementation/reference material plus overview;
- alternate-model or human review for absence/conflict/authority.

Multiple passages copied from one origin do not count as independent evidence.

## 10. Claim dependency graph

Claims may:

- qualify another claim;
- provide a precondition;
- define a term used elsewhere;
- supersede a historical claim;
- contradict a same-scope claim;
- implement a policy claim;
- exemplify a behavior claim.

Answer Composer and Information Architect use these relationships to avoid omitting necessary context.

## 11. Traceability example

```text
source unit U-17
  └── evidence packet EP-4 (primary for retry-policy facet)
       └── verdict EV-4 accepted
            └── proposed claim PC-8
                 └── claim review CR-8 accepted
                      ├── used in answer A-2
                      ├── canonical home docs/retries.md#policy
                      └── replay fixture RF-19
```

## 12. Failure handling

- A malformed model output receives one schema-repair retry, then a durable failure task.
- A hash mismatch blocks the artifact and triggers snapshot investigation.
- A later source/authority/extraction change marks accepted claims stale and propagates invalidation.
- Claim acceptance never depends on the same call that extracted the claim.
