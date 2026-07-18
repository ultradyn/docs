# Security, Privacy, and Source Custody

## 1. Threat model summary

Automatic ingestion receives untrusted archives and content, sends selected text to powerful agents, stores source-derived artifacts, and can propose changes to an authoritative documentation repository. The system therefore treats source text as data, never executable instructions.

## 2. Preflight policy enforcement

Before extraction or external model calls:

- validate archive paths, links, counts, compression ratios, and sizes;
- identify file types independently of extension;
- apply malware-scanner hooks where deployed;
- classify data sensitivity and access;
- scan configured secrets/PII categories;
- determine license/transformation/quotation permissions;
- select permitted processor, region, retention, logging, and cache profile;
- block prohibited or unclassified material.

## 3. Processing profiles

Example profiles:

```text
public
internal
confidential
restricted_local_only
prohibited
```

The label propagates from source file/unit to evidence packets, claims, dashboard views, context packs, caches, and publication artifacts. Retrieval filters apply before content is exposed to an LLM.

## 4. Source replay capsule

Promotion requires organization-controlled, content-addressed retention of the exact source snapshot. The receipt records:

- package digest and size;
- encrypted storage location(s);
- replica verification;
- retention and legal-hold policy;
- access policy;
- deletion method;
- latest readability check;
- authorized portable export/escrow where used.

Ordinary Git stores the manifest and safe text records, not necessarily sensitive binary bytes.

## 5. Prompt injection defenses

- agent contracts state that source content is untrusted quoted data;
- only allowlisted tools/paths are exposed;
- Researcher tools are read-only;
- Evidence Critic opens references but does not execute source instructions;
- writers have no research or execution tools;
- HTML/Markdown source previews are escaped and sandboxed;
- adversarial fixtures contain instruction-like source text;
- model output is schema-validated before use.

## 6. Least privilege

- Source Importer can write snapshot storage and manifests, not Git main.
- Researcher can read allowed source units and search projections only.
- Evaluation agents cannot mutate graph state directly.
- Graph Gateway validates proposed mutations.
- Git writer is restricted to an isolated worktree/branch.
- Merge credentials belong to deterministic policy services, not agents.

## 7. Secrets and Git history

The publication pipeline scans proposed commits. A detected secret blocks publication. If sensitive content entered protected history, normal deletion is insufficient; invoke the repository incident/history-remediation procedure and invalidate derived artifacts.

## 8. Deletion workflow

A deletion request:

1. verifies authorization and legal-hold status;
2. calculates dependent source units, evidence, claims, answers, documents, caches, and exports;
3. freezes affected runs/publication;
4. deletes or cryptographically erases source objects and keys;
5. purges local/index/cache representations;
6. sends/records provider deletion requests where applicable;
7. invalidates dependent logical artifacts;
8. creates a signed deletion certificate;
9. identifies any Git-history remediation required.

## 9. Licensing and quotation

Source rights metadata controls:

- whether material may be transformed;
- whether verbatim excerpts may be stored/published;
- maximum quote length or distribution scope;
- whether generated summaries can be exported;
- retention and attribution requirements.

An evidence reference can remain private while a permitted paraphrased claim enters internal documentation, but the policy decision must be explicit.

## 10. Audit and privacy

Durable audit records consist of explicit structured outputs, tool receipts, decisions, and visible rationales. Private hidden model reasoning is neither required nor stored as a product artifact. General logs avoid duplicating sensitive source text.
