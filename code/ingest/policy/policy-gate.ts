// T-13-02 placeholder.
//
// The RED baseline imports the public seam named by the plan (r0-r1
// implementation plan lines 720-748) plus the bindings the coordinator ruled
// in. Keeping the module present but empty makes the RED failures genuine
// missing-export errors for absent T-13-02 behaviour rather than
// module-resolution crashes.
//
// Enforcement only. This module opens no unit text, calls no provider, and has
// no delete/erase/purge/redaction path (content scanning is T-13-03, deletion
// is T-10-04). Every gate method performs a FRESH assertRunAllowed and fails
// closed; it never trusts a profile handed in by the caller.
export {};
