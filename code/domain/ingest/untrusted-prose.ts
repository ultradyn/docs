/**
 * B003 — Untrusted prose brand.
 *
 * HONESTY (binding — REQUIRED 1):
 * - This is a COMPILE-TIME control that catches accidental coupling (mistakes).
 * - The unique-symbol brand is ERASED at runtime and forgeable by hand-constructing
 *   a plausible object. It does NOT stop anything at runtime and does NOT stop a
 *   determined caller.
 * - Threat model: a developer wiring critic free text into a model path without
 *   noticing — not an adversary inside our own process.
 * - If you believe this is a runtime guarantee, you will skip a check that never
 *   existed. Comments and types that overclaim safety are how we got here.
 *
 * Why an object wrapper (not `string & Brand`):
 * TypeScript allows `string & Brand` to widen into plain `string`, so a branded
 * string would still assign into any model-input `string` slot without a deliberate
 * call. The wrapper is NOT assignable to `string`, so a consumer must call
 * deliberatelyExposeUntrustedProseToModel (grep-auditable) to get characters back.
 *
 * Consumer rule: free-text fields on Evidence Critic proposals (reason,
 * whyCurrentPacketFails) are UntrustedProse after validation. Do NOT pass them
 * into provider message construction without deliberatelyExposeUntrustedProseToModel.
 *
 * Producer rule: free text is preserved (reviewability). We do not strip
 * question-shaped prose — structural child keys remain schema-forbidden.
 */

/** Compile-time only — erased at runtime (do not use as a value). */
declare const untrustedProseBrand: unique symbol;

/** Runtime marker for isUntrustedProse shape checks (not a security boundary). */
const UNTRUSTED_PROSE_RUNTIME = Symbol.for("ultradyn.UntrustedProse");

export type UntrustedProse = {
  readonly [untrustedProseBrand]: true;
  readonly text: string;
};

export function markUntrustedProse(text: string): UntrustedProse {
  if (typeof text !== "string") {
    throw new TypeError("markUntrustedProse requires a string");
  }
  return Object.freeze({
    text,
    [UNTRUSTED_PROSE_RUNTIME]: true,
  }) as unknown as UntrustedProse;
}

/**
 * Deliberate, grep-auditable escape hatch to recover plain characters for a
 * model/provider path. Calling this is an explicit trust decision.
 */
export function deliberatelyExposeUntrustedProseToModel(
  value: UntrustedProse,
): string {
  return value.text;
}

/**
 * Runtime shape guard (not a security boundary). True for objects produced by
 * markUntrustedProse. Hand-forged objects can pass if they copy the shape —
 * brand security is compile-time for accidental misuse.
 */
export function isUntrustedProse(value: unknown): value is UntrustedProse {
  if (value === null || typeof value !== "object") return false;
  if (!(UNTRUSTED_PROSE_RUNTIME in value)) return false;
  const record = value as { text?: unknown };
  return typeof record.text === "string";
}
