// T-13-01 placeholder for the durable approval record.
//
// A PolicyApproval embeds the CANONICAL DataRightsPolicyProfile alongside its
// digest and human provenance, so a fresh process can answer assertRunAllowed
// from the record alone without consulting any other state.
//
// Fields (bound): schemaVersion, profileId, profile (canonical),
// profileSha256, approvedBy, approvedAt, reason (nonblank).
//
// Declarative only: no deletion, revocation, or expiry-as-erasure semantics.
export {};
