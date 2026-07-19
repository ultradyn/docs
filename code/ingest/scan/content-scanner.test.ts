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
import { createSeededSecretAdapter, createEmailPiiAdapter } from "./testing.js";

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
