// T-13-01 placeholder for the durable approval store seam.
//
// RED-2 imports the intended public surface. The module exists but exports
// nothing, so failures are genuine missing-export errors for absent T-13
// behaviour rather than module-resolution crashes.
//
// Contract (bound by coordinator ruling):
//   - PolicyService depends on PolicyApprovalStore.
//   - Two implementations ship: an in-memory fake and a file adapter rooted at
//     the portable, Git-visible `ingest/policy-approvals/`.
//   - One immutable record per safely keyed profile id. Same id + same digest
//     replays idempotently; same id + changed digest is APPROVAL_CONFLICT.
//     Changed content must take a NEW profile id.
//   - No ambient "latest", no revisions, no revoke, no overwrite, no delete.
//
// This module must never grow a delete, erase, purge, unlink, or revoke path.
// Authorised deletion is T-10-04, blocked on ADR 0007, ratified D9, and every
// capability gate.
export {};
