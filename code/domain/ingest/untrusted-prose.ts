/**
 * B003 — Untrusted prose (compile-time control).
 *
 * HONESTY (binding):
 * - This is a COMPILE-TIME control that catches accidental coupling (mistakes).
 * - Private fields are ERASED at runtime and forgeable by a determined caller.
 *   This does NOT stop anything at runtime and does NOT stop an attacker inside
 *   our process.
 * - Threat model: a developer wiring critic free text into a model path without
 *   noticing — not an adversary.
 * - If you believe this is a runtime guarantee, you will skip a check that never
 *   existed.
 *
 * Why a class with private #text (not string&Brand, not { text: string }):
 * - `string & Brand` widens into plain `string` slots — hatch would be optional.
 * - A public `.text` or public `_exposeText()` is the same hole one step deeper:
 *   characters flow out without deliberatelyExposeUntrustedProseToModel, so
 *   grepping the hatch name under-scans. Private #text is read only through a
 *   module-local reader closed over in a static block; the only public string
 *   path is deliberatelyExposeUntrustedProseToModel.
 *
 * Serialisation: UntrustedProse does not survive JSON.stringify (private fields
 * drop; you get {}). Any persistence, logging, or MCP path must use the hatch
 * explicitly and re-mark on load, or deliberately omit the text — otherwise
 * reasons vanish silently rather than erroring.
 *
 * Consumer rule: after validation, critic free-text fields are UntrustedProse.
 * Pass them to provider message construction only via
 * deliberatelyExposeUntrustedProseToModel (grep-auditable; only public path).
 *
 * Producer rule: free text is preserved (reviewability). We do not strip
 * question-shaped prose — structural child keys remain schema-forbidden.
 */

/** Module-local reader — set once in UntrustedProse static block; not exported. */
let readUntrustedProseText: ((value: UntrustedProse) => string) | undefined;

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

  static {
    readUntrustedProseText = (value: UntrustedProse): string => value.#text;
  }

  /** @internal Used only by markUntrustedProse in this module. */
  static _fromValidatedString(text: string): UntrustedProse {
    if (typeof text !== "string") {
      throw new TypeError("markUntrustedProse requires a string");
    }
    return new UntrustedProse(text);
  }
}

export function markUntrustedProse(text: string): UntrustedProse {
  return UntrustedProse._fromValidatedString(text);
}

/**
 * Deliberate, grep-auditable escape hatch — the ONLY public way from
 * UntrustedProse to string. Calling this is an explicit trust decision.
 */
export function deliberatelyExposeUntrustedProseToModel(
  value: UntrustedProse,
): string {
  if (readUntrustedProseText === undefined) {
    throw new TypeError(
      "deliberatelyExposeUntrustedProseToModel: module reader not initialised",
    );
  }
  return readUntrustedProseText(value);
}

/**
 * Runtime instance guard (not a security boundary). True for UntrustedProse
 * instances. Hand-forged objects are out of scope — control is compile-time.
 */
export function isUntrustedProse(value: unknown): value is UntrustedProse {
  return value instanceof UntrustedProse;
}
