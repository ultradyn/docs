// T-13-01 placeholder.
//
// The RED baseline imports this module's intended public seam. Keeping the
// module present but empty makes the RED failures genuine missing-export
// errors for absent T-13 behaviour, rather than module-resolution crashes
// that would fail for the wrong reason.
//
// Vocabulary (binding, see the T-13-01 handoff):
//   PolicyProfile            - frozen minimal intake/preflight contract (v1,
//                              code/domain/ingest/policy-profile.ts). Never
//                              silently upgraded, never run-authoritative.
//   DataRightsPolicyProfile  - this module. The expanded declarative candidate
//                              record, registered under its own registry name
//                              at schemaVersion 1 and its own portable scaffold
//                              schema. Additive: it does not redefine v1 of the
//                              legacy name.
//   ApprovedPolicyProfile    - the approval-ledger, content-digest-bound view
//                              returned by PolicyService (code/ingest/policy).
//
// Declarative policy only. This module must never grow a delete, erase, purge,
// or unlink field, nor any retention semantics that mean physical erasure.
// Authorised deletion lives in T-10-04, blocked on ADR 0007, ratified D9, and
// every capability gate.
export {};
