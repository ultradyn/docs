/**
 * T-13-03 RED — privacy surface.
 * Acceptance (2): redaction preserves authorized source mapping.
 * Redaction emits NEW superseding representation; never mutates/deletes original.
 */
import { describe, expect, it } from "vitest";

import type {
  SourceFileId,
  SourceRepresentationId,
} from "../../domain/ingest/index.js";
import type { SourceRepresentation } from "../../domain/ingest/representation-records.js";

import { createContentScanner } from "./content-scanner.js";
import { createSeededSecretAdapter } from "./testing.js";

const SEEDED_SECRET = "sk-ultradyn-seeded-test-secret-DO-NOT-LEAK";
const FILE = `file-${"a".repeat(64)}` as SourceFileId;
const REP_ID = "repr-01ARZ3NDEKTSV4RRFFQ69G5FAV" as SourceRepresentationId;

function policyRedact() {
  return {
    schemaVersion: 1 as const,
    id: "scan-policy-privacy",
    defaultAction: "redact" as const,
    actionsByKind: {
      secret: "redact" as const,
      pii: "redact" as const,
    },
  };
}

function sampleRepresentation(
  text: string,
  overrides: Partial<SourceRepresentation> = {},
): SourceRepresentation {
  const end = text.length;
  return {
    schemaVersion: 1,
    id: REP_ID,
    sourceFileId: FILE,
    version: 1,
    kind: "text",
    normalizedText: text,
    locatorMap: [
      {
        kind: "span",
        normalized: {
          utf16Start: 0,
          utf16End: end,
          lineStart: 1,
          columnStart: 1,
          lineEnd: 1,
          columnEnd: end + 1,
        },
        original: {
          byteStart: 0,
          byteEnd: end,
          lineStart: 1,
          columnStart: 1,
          lineEnd: 1,
          columnEnd: end + 1,
        },
      },
    ],
    warnings: [],
    ...overrides,
  };
}

describe("AC2 — redaction preserves authorized source mapping", () => {
  it("exports redactRepresentation on content scanner", async () => {
    const mod = await import("./content-scanner.js");
    const scanner = (
      mod as { createContentScanner: typeof createContentScanner }
    ).createContentScanner?.({
      adapters: [createSeededSecretAdapter(SEEDED_SECRET)],
      policy: policyRedact(),
    });
    expect(scanner).toBeDefined();
    expect(typeof scanner?.redactRepresentation).toBe("function");
  });

  it("redaction omits secret from normalizedText and returns superseding representation", async () => {
    const scanner = createContentScanner({
      adapters: [createSeededSecretAdapter(SEEDED_SECRET)],
      policy: policyRedact(),
    });
    const originalText = `token=${SEEDED_SECRET}; ok`;
    const original = sampleRepresentation(originalText);
    const originalClone = structuredClone(original);

    const findingsResult = await scanner.scanForModelExposure(originalText);
    // Under redact policy, scan may still produce findings without hard block
    // depending on design; redaction path uses findings explicitly.
    const findings =
      findingsResult.ok && findingsResult.value.findings.length > 0
        ? findingsResult.value.findings
        : [
            {
              kind: "secret" as const,
              detectorId: "seeded-secret",
              span: {
                kind: "span" as const,
                normalized: {
                  utf16Start: originalText.indexOf(SEEDED_SECRET),
                  utf16End:
                    originalText.indexOf(SEEDED_SECRET) + SEEDED_SECRET.length,
                  lineStart: 1,
                  columnStart: 1,
                  lineEnd: 1,
                  columnEnd: 2,
                },
                original: {
                  byteStart: originalText.indexOf(SEEDED_SECRET),
                  byteEnd:
                    originalText.indexOf(SEEDED_SECRET) + SEEDED_SECRET.length,
                  lineStart: 1,
                  columnStart: 1,
                  lineEnd: 1,
                  columnEnd: 2,
                },
              },
            },
          ];

    const redacted = await scanner.redactRepresentation(original, findings);
    expect(redacted.ok).toBe(true);
    if (!redacted.ok) return;

    // NEW record
    expect(redacted.value.id).not.toBe(original.id);
    expect(redacted.value.supersedesId).toBe(original.id);
    expect(redacted.value.version).toBeGreaterThan(original.version);

    // Secret gone from text
    expect(redacted.value.normalizedText).not.toContain(SEEDED_SECRET);
    expect(JSON.stringify(redacted.value)).not.toContain(SEEDED_SECRET);

    // Original untouched (no mutate)
    expect(original.normalizedText).toBe(originalClone.normalizedText);
    expect(original.id).toBe(originalClone.id);
    expect(original.locatorMap).toEqual(originalClone.locatorMap);

    // locatorMap preserved/remapped (non-empty authorized mapping)
    expect(redacted.value.locatorMap.length).toBeGreaterThan(0);
    expect(Object.isFrozen(redacted.value)).toBe(true);
    expect(Object.isFrozen(redacted.value.locatorMap)).toBe(true);
  });

  it("redaction never deletes or returns a purge/erase code", async () => {
    const scanner = createContentScanner({
      adapters: [createSeededSecretAdapter(SEEDED_SECRET)],
      policy: policyRedact(),
    });
    const original = sampleRepresentation(`x=${SEEDED_SECRET}`);
    const result = await scanner.redactRepresentation(original, [
      {
        kind: "secret",
        detectorId: "seeded-secret",
        span: {
          kind: "span",
          normalized: {
            utf16Start: 2,
            utf16End: 2 + SEEDED_SECRET.length,
            lineStart: 1,
            columnStart: 3,
            lineEnd: 1,
            columnEnd: 3 + SEEDED_SECRET.length,
          },
          original: {
            byteStart: 2,
            byteEnd: 2 + SEEDED_SECRET.length,
            lineStart: 1,
            columnStart: 3,
            lineEnd: 1,
            columnEnd: 3 + SEEDED_SECRET.length,
          },
        },
      },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      expect(result.code).not.toMatch(/DELETE|ERASE|PURGE|UNLINK/i);
    }
  });
});
