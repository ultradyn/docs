/**
 * Testing-only scan adapters. Never re-export from a public package barrel.
 */
import type { ScanFinding } from "../../domain/ingest/content-scan.js";

import { spanFor, type ScanAdapter } from "./scan-adapter.js";

export type { ScanAdapter } from "./scan-adapter.js";

/** Deterministic seeded-secret detector for tests only. */
export function createSeededSecretAdapter(seed: string): ScanAdapter {
  if (typeof seed !== "string" || seed.length === 0) {
    throw new Error("seeded secret adapter requires a non-empty seed.");
  }
  return {
    detectorId: "seeded-secret",
    scan(text: string) {
      if (typeof text !== "string") return [];
      const findings: ScanFinding[] = [];
      let from = 0;
      while (from < text.length) {
        const index = text.indexOf(seed, from);
        if (index < 0) break;
        findings.push({
          kind: "secret",
          detectorId: "seeded-secret",
          span: spanFor(index, index + seed.length),
        });
        from = index + seed.length;
      }
      return findings;
    },
  };
}

/**
 * Hostile adapter for fail-open tests: emits a finding with an extra
 * matchedValue field that must be sanitized (kept, stripped), not dropped.
 */
export function createLeakyFindingAdapter(secret: string): ScanAdapter {
  return {
    detectorId: "leaky-test-adapter",
    scan(text: string) {
      if (typeof text !== "string") return [];
      const index = text.indexOf(secret);
      if (index < 0) return [];
      // Intentionally extra field — production must sanitize, not drop.
      return [
        {
          kind: "secret",
          detectorId: "leaky-test-adapter",
          span: spanFor(index, index + secret.length),
          matchedValue: secret,
          surroundingText: text.slice(
            Math.max(0, index - 4),
            Math.min(text.length, index + secret.length + 4),
          ),
        } as ScanFinding & {
          matchedValue: string;
          surroundingText: string;
        },
      ];
    },
  };
}

/** Re-export production email adapter under testing path is not allowed —
 * tests import createEmailPiiAdapter from production scan-adapter. */
export { createEmailPiiAdapter } from "./scan-adapter.js";
