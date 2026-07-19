import type { ScanFinding } from "../../domain/ingest/content-scan.js";

/** Production scan adapter contract — not a test seam. */
export interface ScanAdapter {
  readonly detectorId: string;
  scan(text: string): readonly ScanFinding[];
}

export function spanFor(start: number, end: number): ScanFinding["span"] {
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

/**
 * Production secret detector: PEM/private-key blocks and common high-entropy
 * token shapes (sk-/AKIA-/ghp_ prefixes). Deterministic, bounded, no network.
 */
export function createPrivateKeySecretAdapter(): ScanAdapter {
  const PEM =
    /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----[\s\S]{0,8192}?-----END (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/g;
  // Common cloud/API token prefixes; bounded length.
  const TOKEN =
    /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,128}\b|\bAKIA[0-9A-Z]{16}\b|\bghp_[A-Za-z0-9]{20,80}\b|\bgithub_pat_[A-Za-z0-9_]{20,120}\b/g;

  return {
    detectorId: "secret-pem-token",
    scan(text: string) {
      if (typeof text !== "string" || text.length === 0) return [];
      // Bound input scan cost.
      const sample = text.length > 256_000 ? text.slice(0, 256_000) : text;
      const findings: ScanFinding[] = [];
      for (const re of [PEM, TOKEN]) {
        const pattern = new RegExp(re.source, re.flags);
        let match: RegExpExecArray | null;
        let guard = 0;
        while ((match = pattern.exec(sample)) !== null && guard < 64) {
          guard += 1;
          const start = match.index;
          const end = start + match[0].length;
          findings.push({
            kind: "secret",
            detectorId: "secret-pem-token",
            span: spanFor(start, end),
          });
          if (match[0].length === 0) pattern.lastIndex += 1;
        }
      }
      return findings;
    },
  };
}

/**
 * Production email PII detector. Deterministic, bounded, no network.
 */
export function createEmailPiiAdapter(): ScanAdapter {
  const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  return {
    detectorId: "email-pii",
    scan(text: string) {
      if (typeof text !== "string" || text.length === 0) return [];
      const sample = text.length > 256_000 ? text.slice(0, 256_000) : text;
      const findings: ScanFinding[] = [];
      const re = new RegExp(EMAIL.source, "g");
      let match: RegExpExecArray | null;
      let guard = 0;
      while ((match = re.exec(sample)) !== null && guard < 128) {
        guard += 1;
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

/** Default production adapters for ContentScanner when callers omit injects. */
export function createDefaultScanAdapters(): readonly ScanAdapter[] {
  return Object.freeze([
    createPrivateKeySecretAdapter(),
    createEmailPiiAdapter(),
  ]);
}
