// T-13-01 placeholder.
//
// The RED baseline imports the public seam named by the authoritative task
// recipe (docs/specs/automatic-ingestion-v3/r0-r1-implementation-plan.md
// lines 695-720). Keeping this module present but empty makes the RED failures
// genuine missing-export errors for absent T-13 behaviour, rather than
// module-resolution crashes that would fail for the wrong reason.
//
// Declarative policy only: this module must never gain a delete, erase, purge,
// unlink, or any other destructive path. Authorised deletion lives in T-10-04,
// which stays blocked on ADR 0007, ratified D9, and every capability gate.
export {};
