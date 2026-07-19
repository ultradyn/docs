/**
 * B003 — Untrusted prose (compile-time control).
 *
 * HONESTY (binding — REQUIRED 1):
 * - This is a COMPILE-TIME control that catches accidental coupling (mistakes).
 * - Brands and private fields are ERASED at runtime and forgeable by a determined
 *   caller. This does NOT stop anything at runtime and does NOT stop an attacker
 *   inside our process.
 * - Threat model: a developer wiring critic free text into a model path without
 *   noticing — not an adversary.
 * - If you believe this is a runtime guarantee, you will skip a check that never
 *   existed.
 *
 * Why a class with private #text (not string&Brand, not { text: string }):
 * - `string & Brand` widens into plain `string` slots — hatch would be optional.
 * - A public `.text` field is the same hole one step deeper: characters flow out
 *   without deliberatelyExposeUntrustedProseToModel, so grepping the hatch name
 *   under-scans. Private #text means only the hatch method returns a string.
 *
 * Consumer rule: after validation, critic free-text fields are UntrustedProse.
 * Pass them to provider message construction only via
 * deliberatelyExposeUntrustedProseToModel (grep-auditable).
 *
 * Producer rule: free text is preserved (reviewability). We do not strip
 * question-shaped prose — structural child keys remain schema-forbidden.
 */

/**
 * Opaque holder for free-text justifications that must not silently enter
 * model-input string slots. Characters are recoverable only via
 * deliberatelyExposeUntrustedProseToModel.
 */
export class UntrustedProse {
  readonly #text: string;

  private constructor(text: string) {
    this.#text = text;
  }

  /** @internal Used only by markUntrustedProse. */
  static _fromValidatedString(text: string): UntrustedProse {
    if (typeof text !== "string") {
      throw new TypeError("markUntrustedProse requires a string");
    }
    return new UntrustedProse(text);
  }

  /** @internal Hatch access — prefer deliberatelyExposeUntrustedProseToModel. */
  _exposeText(): string {
    return this.#text;
  }
}

export function markUntrustedProse(text: string): UntrustedProse {
  return UntrustedProse._fromValidatedString(text);
}

/**
 * Deliberate, grep-auditable escape hatch to recover plain characters for a
 * model/provider path. Calling this is an explicit trust decision.
 * This is the only public path from UntrustedProse to string.
 */
export function deliberatelyExposeUntrustedProseToModel(
  value: UntrustedProse,
): string {
  return value._exposeText();
}

/**
 * Runtime instance guard (not a security boundary). True for UntrustedProse
 * instances. Hand-forged objects are out of scope — control is compile-time.
 */
export function isUntrustedProse(value: unknown): value is UntrustedProse {
  return value instanceof UntrustedProse;
}
