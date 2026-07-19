/**
 * Testing-only scan adapters. Never re-export from a public package barrel.
 */
import type { ScanFinding } from "../../domain/ingest/content-scan.js";

export interface ScanAdapter {
  readonly detectorId: string;
  scan(text: string): readonly ScanFinding[];
}

function spanFor(start: number, end: number): ScanFinding["span"] {
  return {
    kind: "span",
    normalized: {
      utf16Start: start,
      utf16End: end,
      lineStart: 1,
      columnStart: start + 1,
      lineEnd: 1,
      columnEnd: end + 1,
    },
    original: {
      byteStart: start,
      byteEnd: end,
      lineStart: 1,
      columnStart: start + 1,
      lineEnd: 1,
      columnEnd: end + 1,
    },
  };
}

/** Deterministic seeded-secret detector for tests. */
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

/** Deterministic email PII detector (local only; no network). */
export function createEmailPiiAdapter(): ScanAdapter {
  // Simple, bounded email shape.
  const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  return {
    detectorId: "email-pii",
    scan(text: string) {
      if (typeof text !== "string") return [];
      const findings: ScanFinding[] = [];
      let match: RegExpExecArray | null;
      const re = new RegExp(EMAIL.source, "g");
      while ((match = re.exec(text)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        findings.push({
          kind: "pii",
          detectorId: "email-pii",
          span: spanFor(start, end),
        });
        if (match[0].length === 0) re.lastIndex += 1;
      }
      return findings;
    },
  };
}
