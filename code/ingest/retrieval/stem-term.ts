/**
 * B005 — Porter stemmer for MiniSearch processTerm (symmetric index + query).
 *
 * HONESTY:
 * - Stems recover morphology near-misses (capabilities/capability, locally/local).
 * - Does NOT recover zero-overlap semantic links (small-unit-18 stays FN under R1).
 * - processTerm must be identical at index and query time; asymmetric stemming
 *   will not match.
 */
import { stemmer } from "stemmer";

/**
 * MiniSearch processTerm: lowercase + Porter stem.
 * Returns the stemmed term string for indexing and querying.
 */
export function processLexicalTerm(term: string): string | null {
  if (typeof term !== "string" || term.length === 0) return null;
  const lower = term.toLowerCase();
  // MiniSearch may pass punctuation-only tokens; skip empty stems.
  const stemmed = stemmer(lower);
  return stemmed.length > 0 ? stemmed : null;
}
