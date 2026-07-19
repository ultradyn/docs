/**
 * T-13-03 RED — security surface.
 * Acceptance (1): seeded secret blocked BEFORE the external-agent/model event.
 * Privacy: secret value never appears in verdict/findings/messages.
 */
import { describe, expect, it, vi } from "vitest";

import {
  createContentScanner,
  type ContentScanner,
} from "./content-scanner.js";
import { createSeededSecretAdapter } from "./testing.js";

const SEEDED_SECRET = "sk-ultradyn-seeded-test-secret-DO-NOT-LEAK";

function defaultPolicy() {
  return {
    schemaVersion: 1 as const,
    id: "scan-policy-security",
    defaultAction: "block" as const,
    actionsByKind: {
      secret: "block" as const,
      pii: "redact" as const,
    },
  };
}

describe("construction", () => {
  it("exports createContentScanner", async () => {
    const mod = await import("./content-scanner.js");
    expect(typeof mod.createContentScanner).toBe("function");
  });

  it("requires adapters and policy at construction", () => {
    expect(() =>
      createContentScanner({
        policy: defaultPolicy(),
      } as never),
    ).toThrow(/adapter/i);
    expect(() =>
      createContentScanner({
        adapters: [createSeededSecretAdapter(SEEDED_SECRET)],
      } as never),
    ).toThrow(/policy/i);
  });
});

describe("AC1 — seeded secret blocked before model event", () => {
  it("scanForModelExposure blocks seeded secret fail-closed", async () => {
    const scanner = createContentScanner({
      adapters: [createSeededSecretAdapter(SEEDED_SECRET)],
      policy: defaultPolicy(),
    });
    const text = `config token=${SEEDED_SECRET} ok`;
    const result = await scanner.scanForModelExposure(text);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("BLOCKED");
      // Fixed message — never interpolates secret
      expect(result.message).not.toContain(SEEDED_SECRET);
      expect(JSON.stringify(result)).not.toContain(SEEDED_SECRET);
    }
  });

  it("blocks BEFORE a faked model event is invoked", async () => {
    const modelEvent = vi.fn(async (..._args: unknown[]) => {
      void _args;
      return { tokens: 1 };
    });
    const scanner = createContentScanner({
      adapters: [createSeededSecretAdapter(SEEDED_SECRET)],
      policy: defaultPolicy(),
    });
    // Seam: caller must consult scanForModelExposure before modelEvent.
    async function exposeToModel(text: string) {
      const verdict = await scanner.scanForModelExposure(text);
      if (!verdict.ok) {
        return verdict;
      }
      return modelEvent(text);
    }
    const out = await exposeToModel(`leak ${SEEDED_SECRET}`);
    expect(out).toMatchObject({ ok: false, code: "BLOCKED" });
    expect(modelEvent).not.toHaveBeenCalled();
  });

  it("clean text does not block and allows model event path", async () => {
    const modelEvent = vi.fn(async (..._args: unknown[]) => {
      void _args;
      return { tokens: 1 };
    });
    const scanner = createContentScanner({
      adapters: [createSeededSecretAdapter(SEEDED_SECRET)],
      policy: defaultPolicy(),
    });
    async function exposeToModel(text: string) {
      const verdict = await scanner.scanForModelExposure(text);
      if (!verdict.ok) return verdict;
      return { ok: true as const, value: await modelEvent(text) };
    }
    const out = await exposeToModel("hello world no secrets");
    expect(out.ok).toBe(true);
    expect(modelEvent).toHaveBeenCalledOnce();
  });
});

describe("secret value never leaks", () => {
  it("findings and messages never include raw secret or surrounding match text", async () => {
    const scanner = createContentScanner({
      adapters: [createSeededSecretAdapter(SEEDED_SECRET)],
      policy: {
        ...defaultPolicy(),
        actionsByKind: { secret: "redact", pii: "redact" },
        defaultAction: "redact",
      },
    });
    // When policy is redact rather than block, verdict may be ok with redacted outcome
    // Security still requires no secret material in structured output.
    const result = await scanner.scanForModelExposure(
      `prefix ${SEEDED_SECRET} suffix`,
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SEEDED_SECRET);
    expect(serialized).not.toMatch(/sk-ultradyn/i);
    if (result.ok) {
      for (const finding of result.value.findings) {
        expect(finding).not.toHaveProperty("matchedValue");
        expect(finding).not.toHaveProperty("surroundingText");
        expect(finding).not.toHaveProperty("match");
        expect(Object.keys(finding).sort()).toEqual(
          ["detectorId", "kind", "span"].sort(),
        );
      }
    }
  });

  it("rejects hostile non-plain scan input without throwing secret content", async () => {
    const scanner = createContentScanner({
      adapters: [createSeededSecretAdapter(SEEDED_SECRET)],
      policy: defaultPolicy(),
    });
    let accessed = false;
    const hostile = {
      get text() {
        accessed = true;
        return SEEDED_SECRET;
      },
    };
    // scanForModelExposure takes string; hostile object must fail closed
    const result = await (scanner as ContentScanner).scanForModelExposure(
      hostile as never,
    );
    expect(accessed).toBe(false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_INPUT");
      expect(JSON.stringify(result)).not.toContain(SEEDED_SECRET);
    }
  });
});

describe("public surface discipline", () => {
  it("knowledge/policy barrels do not export createSeededSecretAdapter", async () => {
    const knowledge = await import("../knowledge/index.js");
    expect(
      (knowledge as { createSeededSecretAdapter?: unknown })
        .createSeededSecretAdapter,
    ).toBeUndefined();
    const policy = await import("../policy/index.js");
    expect(
      (policy as { createSeededSecretAdapter?: unknown })
        .createSeededSecretAdapter,
    ).toBeUndefined();
  });

  it("scan testing fakes are not re-exported from content-scanner barrel path", async () => {
    const mod = await import("./content-scanner.js");
    expect(
      (mod as { createSeededSecretAdapter?: unknown })
        .createSeededSecretAdapter,
    ).toBeUndefined();
  });
});
