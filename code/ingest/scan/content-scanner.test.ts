/**
 * T-13-03 RED — workflow surface.
 * Acceptance (3): proposed commit with prohibited material fails.
 * Action selection, quarantine append-only, deep-freeze, fixed messages.
 */
import { describe, expect, it } from "vitest";

import type { DataRightsPolicyProfile } from "../../domain/ingest/index.js";

import {
  createContentScanner,
  createInMemoryQuarantineStore,
  createFileQuarantineStore,
} from "./content-scanner.js";
import {
  createEmailPiiAdapter,
  createPrivateKeySecretAdapter,
  createDefaultScanAdapters,
} from "./scan-adapter.js";
import { createSeededSecretAdapter } from "./testing.js";

const SEEDED_SECRET = "sk-ultradyn-seeded-test-secret-DO-NOT-LEAK";

function policy(actions?: {
  secret?: "allow" | "redact" | "quarantine" | "block";
  pii?: "allow" | "redact" | "quarantine" | "block";
  defaultAction?: "allow" | "redact" | "quarantine" | "block";
}) {
  return {
    schemaVersion: 1 as const,
    id: "scan-policy-workflow",
    defaultAction: actions?.defaultAction ?? ("block" as const),
    actionsByKind: {
      secret: actions?.secret ?? ("block" as const),
      pii: actions?.pii ?? ("redact" as const),
    },
  };
}

function rightsProfile(
  overrides: Partial<DataRightsPolicyProfile> = {},
): DataRightsPolicyProfile {
  return {
    schemaVersion: 1,
    id: "dr-profile-1",
    dataRightsClass: "confidential",
    include: ["docs/**"],
    exclude: [],
    allowedMediaTypes: ["text/markdown"],
    allowedProcessors: ["local-markdown"],
    allowedProviders: ["provider:local-whisper"],
    allowedStorage: ["project-repository"],
    allowedRegions: ["local"],
    retentionClass: "project-lifetime",
    retentionDays: 365,
    logging: "ids-only",
    cache: ["profileId"],
    accessClass: "project-members",
    licenceRestrictions: [],
    publication: "external",
    maxQuoteBytes: 100,
    maxFiles: 1000,
    maxFileBytes: 1_000_000,
    maxExpandedBytes: 10_000_000,
    ...overrides,
  } as DataRightsPolicyProfile;
}

describe("workflow — action selection", () => {
  it("exports createContentScanner and scanProposedCommit", async () => {
    const mod = await import("./content-scanner.js");
    expect(typeof mod.createContentScanner).toBe("function");
    const scanner = mod.createContentScanner({
      adapters: [createSeededSecretAdapter(SEEDED_SECRET)],
      policy: policy(),
    });
    expect(typeof scanner.scanProposedCommit).toBe("function");
  });

  it("allow action yields clean outcome for matching-kind text without findings", async () => {
    const scanner = createContentScanner({
      adapters: [createSeededSecretAdapter(SEEDED_SECRET)],
      policy: policy({ secret: "allow", defaultAction: "allow" }),
    });
    const result = await scanner.scanForModelExposure("no secrets here");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe("clean");
    expect(Object.isFrozen(result.value)).toBe(true);
  });

  it("block action yields blocked outcome / BLOCKED failure", async () => {
    const scanner = createContentScanner({
      adapters: [createSeededSecretAdapter(SEEDED_SECRET)],
      policy: policy({ secret: "block" }),
    });
    const result = await scanner.scanForModelExposure(`x=${SEEDED_SECRET}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("BLOCKED");
  });

  it("quarantine action records append-only quarantine entry", async () => {
    const store = createInMemoryQuarantineStore();
    const scanner = createContentScanner({
      adapters: [createSeededSecretAdapter(SEEDED_SECRET)],
      policy: policy({ secret: "quarantine" }),
      quarantine: store,
    });
    const result = await scanner.scanForModelExposure(`x=${SEEDED_SECRET}`);
    // May be ok with quarantined outcome or typed quarantine path
    if (result.ok) {
      expect(result.value.outcome).toBe("quarantined");
    }
    const listed = await store.list();
    expect(listed.length).toBeGreaterThanOrEqual(1);
    // No secret in quarantine records
    expect(JSON.stringify(listed)).not.toContain(SEEDED_SECRET);
    // Append-only: no delete API
    expect(
      (store as { delete?: unknown; erase?: unknown; purge?: unknown }).delete,
    ).toBeUndefined();
    expect((store as { erase?: unknown }).erase).toBeUndefined();
  });
});

describe("AC3 — proposed commit with prohibited material fails", () => {
  it("scanProposedCommit fails for secret material under block policy", async () => {
    const scanner = createContentScanner({
      adapters: [createSeededSecretAdapter(SEEDED_SECRET)],
      policy: policy({ secret: "block" }),
    });
    const result = await scanner.scanProposedCommit({
      paths: ["docs/secret.md"],
      textByPath: {
        "docs/secret.md": `apiKey=${SEEDED_SECRET}`,
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["PROHIBITED_MATERIAL", "BLOCKED"]).toContain(result.code);
      expect(result.message).not.toContain(SEEDED_SECRET);
      expect(JSON.stringify(result)).not.toContain(SEEDED_SECRET);
    }
  });

  it("scanProposedCommit fails when data-rights publication is forbidden", async () => {
    const scanner = createContentScanner({
      adapters: [createSeededSecretAdapter(SEEDED_SECRET)],
      policy: policy({ secret: "allow", defaultAction: "allow" }),
    });
    const result = await scanner.scanProposedCommit({
      paths: ["docs/a.md"],
      textByPath: { "docs/a.md": "public docs text" },
      dataRights: rightsProfile({ publication: "forbidden" }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["PROHIBITED_MATERIAL", "PUBLICATION_FORBIDDEN"]).toContain(
        result.code,
      );
    }
  });

  it("scanProposedCommit fails for prohibited dataRightsClass", async () => {
    const scanner = createContentScanner({
      adapters: [createSeededSecretAdapter(SEEDED_SECRET)],
      policy: policy({ secret: "allow", defaultAction: "allow" }),
    });
    const result = await scanner.scanProposedCommit({
      paths: ["docs/a.md"],
      textByPath: { "docs/a.md": "anything" },
      dataRights: rightsProfile({ dataRightsClass: "prohibited" }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["PROHIBITED_MATERIAL", "PROHIBITED_CLASS"]).toContain(
        result.code,
      );
    }
  });

  it("clean commit material under external publication may pass", async () => {
    const scanner = createContentScanner({
      adapters: [createSeededSecretAdapter(SEEDED_SECRET)],
      policy: policy({ secret: "block", defaultAction: "allow" }),
    });
    const result = await scanner.scanProposedCommit({
      paths: ["docs/a.md"],
      textByPath: { "docs/a.md": "harmless documentation" },
      dataRights: rightsProfile({ publication: "external" }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe("clean");
    expect(Object.isFrozen(result.value)).toBe(true);
  });
});

describe("workflow — detectors and bounds", () => {
  it("email PII detector contributes pii findings under redact policy", async () => {
    const scanner = createContentScanner({
      adapters: [
        createSeededSecretAdapter(SEEDED_SECRET),
        createEmailPiiAdapter(),
      ],
      policy: policy({
        secret: "allow",
        pii: "redact",
        defaultAction: "allow",
      }),
    });
    const result = await scanner.scanForModelExposure(
      "contact me at alice@example.com please",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.findings.some((f) => f.kind === "pii")).toBe(true);
    expect(JSON.stringify(result.value)).not.toContain("alice@example.com");
  });

  it("rejects empty adapters list at construction", () => {
    expect(() =>
      createContentScanner({
        adapters: [],
        policy: policy(),
      }),
    ).toThrow(/adapter/i);
  });

  it("exports file quarantine store constructor for custody tests", async () => {
    const mod = await import("./content-scanner.js");
    expect(typeof mod.createFileQuarantineStore).toBe("function");
    if (process.platform !== "linux") return;
    // Construction must exist; durable ops exercised under GREEN
    expect(typeof createFileQuarantineStore).toBe("function");
  });
});

describe("registry + barrel", () => {
  it("registers ScanPolicy / ScanVerdict in schema registry", async () => {
    const { ingestSchemaRegistry } =
      await import("../../domain/ingest/schema-registry.js");
    expect(() => ingestSchemaRegistry.get("ScanPolicy", 1)).not.toThrow();
    expect(() => ingestSchemaRegistry.get("ScanVerdict", 1)).not.toThrow();
    const policySchema = ingestSchemaRegistry.get("ScanPolicy", 1);
    expect(policySchema.safeParse({ schemaVersion: 1, id: "x" }).success).toBe(
      false,
    );
  });

  it("domain barrel re-exports ScanPolicySchema", async () => {
    const barrel = await import("../../domain/ingest/index.js");
    expect(
      typeof (barrel as { ScanPolicySchema?: { safeParse: unknown } })
        .ScanPolicySchema?.safeParse,
    ).toBe("function");
  });
});

describe("production detectors (deliverable)", () => {
  it("createDefaultScanAdapters returns secret+pii production adapters", () => {
    const adapters = createDefaultScanAdapters();
    expect(adapters.length).toBeGreaterThanOrEqual(2);
    expect(adapters.some((a) => a.detectorId.includes("secret"))).toBe(true);
    expect(adapters.some((a) => a.detectorId.includes("pii"))).toBe(true);
  });

  it("private-key/token secret adapter fires on PEM and sk- token shapes without leaking match", async () => {
    const pem =
      "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANfakekeybody\n-----END PRIVATE KEY-----";
    const token = "sk-live-abcdefghijklmnopqrstuvwxyz012345";
    const scanner = createContentScanner({
      adapters: [createPrivateKeySecretAdapter()],
      policy: policy({ secret: "block" }),
    });
    for (const sample of [pem, token]) {
      const result = await scanner.scanForModelExposure(sample);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("BLOCKED");
        expect(JSON.stringify(result)).not.toContain("PRIVATE KEY");
        expect(JSON.stringify(result)).not.toContain("sk-live");
      }
    }
  });

  it("production email adapter fires without matched email in output", async () => {
    const scanner = createContentScanner({
      adapters: [createEmailPiiAdapter()],
      policy: policy({
        secret: "allow",
        pii: "redact",
        defaultAction: "allow",
      }),
    });
    const result = await scanner.scanForModelExposure(
      "write to bob@example.org now",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.findings.some((f) => f.kind === "pii")).toBe(true);
    expect(JSON.stringify(result.value)).not.toContain("bob@example.org");
  });
});

describe("fail-closed sanitize (no fail-open drop)", () => {
  it("adapter finding with extra matchedValue still blocks and never leaks the field", async () => {
    const { createLeakyFindingAdapter } = await import("./testing.js");
    const secret = "sk-ultradyn-seeded-test-secret-DO-NOT-LEAK";
    const scanner = createContentScanner({
      adapters: [createLeakyFindingAdapter(secret)],
      policy: policy({ secret: "block" }),
    });
    const result = await scanner.scanForModelExposure(`x=${secret}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("BLOCKED");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("matchedValue");
  });

  it("leaky finding still drives redaction of that span", async () => {
    const { createLeakyFindingAdapter } = await import("./testing.js");
    const secret = "sk-ultradyn-seeded-test-secret-DO-NOT-LEAK";
    const scanner = createContentScanner({
      adapters: [createLeakyFindingAdapter(secret)],
      policy: policy({ secret: "redact", defaultAction: "redact" }),
    });
    const text = `token=${secret};ok`;
    const leaky = createLeakyFindingAdapter(secret).scan(text);
    const redacted = await scanner.redactRepresentation(
      {
        schemaVersion: 1,
        id: "repr-01ARZ3NDEKTSV4RRFFQ69G5FAV" as never,
        sourceFileId: `file-${"a".repeat(64)}` as never,
        version: 1,
        kind: "text",
        normalizedText: text,
        locatorMap: [
          {
            kind: "span",
            normalized: {
              utf16Start: 0,
              utf16End: text.length,
              lineStart: 1,
              columnStart: 1,
              lineEnd: 1,
              columnEnd: text.length + 1,
            },
            original: {
              byteStart: 0,
              byteEnd: text.length,
              lineStart: 1,
              columnStart: 1,
              lineEnd: 1,
              columnEnd: text.length + 1,
            },
          },
        ],
        warnings: [],
      },
      leaky,
    );
    expect(redacted.ok).toBe(true);
    if (!redacted.ok) return;
    expect(redacted.value.normalizedText).not.toContain(secret);
    expect(JSON.stringify(redacted.value)).not.toContain(secret);
    expect(JSON.stringify(redacted.value)).not.toContain("matchedValue");
  });
});

describe("locatorMap remapped onto redacted text", () => {
  it("normalized utf16 spans stay within redactedText length", async () => {
    const secret = "sk-ultradyn-seeded-test-secret-DO-NOT-LEAK";
    const scanner = createContentScanner({
      adapters: [createSeededSecretAdapter(secret)],
      policy: policy({ secret: "redact", defaultAction: "redact" }),
    });
    const text = `aa${secret}bb`;
    const start = text.indexOf(secret);
    const end = start + secret.length;
    const redacted = await scanner.redactRepresentation(
      {
        schemaVersion: 1,
        id: "repr-01ARZ3NDEKTSV4RRFFQ69G5FAV" as never,
        sourceFileId: `file-${"a".repeat(64)}` as never,
        version: 1,
        kind: "text",
        normalizedText: text,
        locatorMap: [
          {
            kind: "span",
            normalized: {
              utf16Start: 0,
              utf16End: text.length,
              lineStart: 1,
              columnStart: 1,
              lineEnd: 1,
              columnEnd: text.length + 1,
            },
            original: {
              byteStart: 0,
              byteEnd: text.length,
              lineStart: 1,
              columnStart: 1,
              lineEnd: 1,
              columnEnd: text.length + 1,
            },
          },
          {
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
          },
        ],
        warnings: [],
      },
      createSeededSecretAdapter(secret).scan(text),
    );
    expect(redacted.ok).toBe(true);
    if (!redacted.ok) return;
    const len = redacted.value.normalizedText.length;
    for (const span of redacted.value.locatorMap) {
      expect(span.normalized.utf16Start).toBeGreaterThanOrEqual(0);
      expect(span.normalized.utf16End).toBeLessThanOrEqual(len);
      expect(span.normalized.utf16Start).toBeLessThanOrEqual(
        span.normalized.utf16End,
      );
    }
    const full = redacted.value.locatorMap[0]!;
    expect(full.normalized.utf16End).toBe(len);
  });
});
