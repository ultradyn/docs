import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import writeFileAtomic from "write-file-atomic";
import { z } from "zod";

import { ConsentReceiptSchema, type ConsentReceipt } from "../domain/index.js";
import type { ProviderConsentScope } from "../shared/index.js";

export type CredentialCapability =
  | {
      kind: "http-bearer";
      sourceId: string;
      providerId: string;
      authorize(headers: Headers): Promise<void>;
    }
  | {
      kind: "delegated-client";
      sourceId: string;
      providerId: string;
      executable: string;
    }
  | {
      kind: "fake";
      sourceId: string;
      providerId: string;
    };

export interface CredentialSourceDescription {
  id: string;
  providerId: string;
  label: string;
  kind: CredentialCapability["kind"];
  scopes: ProviderConsentScope[];
}

export interface CredentialSource {
  describe(): CredentialSourceDescription;
  inspect(
    scope: ProviderConsentScope,
  ): Promise<{ available: boolean; reason?: string }>;
  resolve(scope: ProviderConsentScope): Promise<CredentialCapability>;
}

export interface ConsentStore {
  get(
    sourceId: string,
    scope: ProviderConsentScope,
  ): Promise<ConsentReceipt | undefined>;
  set(receipt: ConsentReceipt): Promise<void>;
  list(): Promise<Record<string, ConsentReceipt>>;
}

function consentKey(sourceId: string, scope: ProviderConsentScope): string {
  return `${sourceId}:${scope}`;
}

export class InMemoryConsentStore implements ConsentStore {
  readonly #receipts = new Map<string, ConsentReceipt>();

  async get(
    sourceId: string,
    scope: ProviderConsentScope,
  ): Promise<ConsentReceipt | undefined> {
    return this.#receipts.get(consentKey(sourceId, scope));
  }

  async set(receipt: ConsentReceipt): Promise<void> {
    this.#receipts.set(consentKey(receipt.sourceId, receipt.scope), receipt);
  }

  async list(): Promise<Record<string, ConsentReceipt>> {
    return Object.fromEntries(this.#receipts);
  }
}

const fileSchema = z.object({
  schemaVersion: z.literal(1),
  receipts: z.record(z.string(), ConsentReceiptSchema),
});

export class FileConsentStore implements ConsentStore {
  constructor(readonly path: string) {}

  async #read(): Promise<z.infer<typeof fileSchema>> {
    try {
      return fileSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { schemaVersion: 1, receipts: {} };
      }
      throw error;
    }
  }

  async get(
    sourceId: string,
    scope: ProviderConsentScope,
  ): Promise<ConsentReceipt | undefined> {
    return (await this.#read()).receipts[consentKey(sourceId, scope)];
  }

  async set(receipt: ConsentReceipt): Promise<void> {
    const current = await this.#read();
    current.receipts[consentKey(receipt.sourceId, receipt.scope)] = receipt;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFileAtomic(this.path, `${JSON.stringify(current, null, 2)}\n`, {
      encoding: "utf8",
    });
  }

  async list(): Promise<Record<string, ConsentReceipt>> {
    return (await this.#read()).receipts;
  }
}

export class ConsentRequiredError extends Error {
  constructor(sourceId: string, scope: string) {
    super(
      `Explicit consent is required before inspecting credential source ${sourceId} for ${scope}.`,
    );
    this.name = "ConsentRequiredError";
  }
}

export class CredentialUnavailableError extends Error {
  constructor(sourceId: string, reason: string) {
    super(`Credential source ${sourceId} is unavailable: ${reason}`);
    this.name = "CredentialUnavailableError";
  }
}

export class CredentialSourceRegistry {
  readonly #sources = new Map<string, CredentialSource>();

  constructor(readonly consentStore: ConsentStore) {}

  register(source: CredentialSource): void {
    const description = source.describe();
    if (this.#sources.has(description.id)) {
      throw new Error(
        `Credential source ${description.id} is already registered.`,
      );
    }
    this.#sources.set(description.id, source);
  }

  descriptions(): CredentialSourceDescription[] {
    return [...this.#sources.values()].map((source) => source.describe());
  }

  async setConsent(
    sourceId: string,
    scope: ProviderConsentScope,
    decision: ConsentReceipt["decision"],
    decidedAt = new Date().toISOString(),
  ): Promise<void> {
    const source = this.#source(sourceId);
    if (!source.describe().scopes.includes(scope)) {
      throw new Error(
        `Credential source ${sourceId} does not provide scope ${scope}.`,
      );
    }
    await this.consentStore.set({ sourceId, scope, decision, decidedAt });
  }

  async status(
    sourceId: string,
    scope: ProviderConsentScope,
  ): Promise<{
    source: CredentialSourceDescription;
    consent: "required" | ConsentReceipt["decision"];
    availability: "unknown" | "available" | "unavailable";
    reason?: string;
  }> {
    const source = this.#source(sourceId);
    const receipt = await this.consentStore.get(sourceId, scope);
    if (!receipt)
      return {
        source: source.describe(),
        consent: "required",
        availability: "unknown",
      };
    if (receipt.decision !== "granted") {
      return {
        source: source.describe(),
        consent: receipt.decision,
        availability: "unknown",
      };
    }
    const inspection = await source.inspect(scope);
    return {
      source: source.describe(),
      consent: "granted",
      availability: inspection.available ? "available" : "unavailable",
      ...(inspection.reason ? { reason: inspection.reason } : {}),
    };
  }

  async resolve(
    sourceId: string,
    scope: ProviderConsentScope,
  ): Promise<CredentialCapability> {
    const source = this.#source(sourceId);
    const receipt = await this.consentStore.get(sourceId, scope);
    if (receipt?.decision !== "granted")
      throw new ConsentRequiredError(sourceId, scope);
    const inspected = await source.inspect(scope);
    if (!inspected.available) {
      throw new CredentialUnavailableError(
        sourceId,
        inspected.reason ?? "not configured",
      );
    }
    return source.resolve(scope);
  }

  #source(sourceId: string): CredentialSource {
    const source = this.#sources.get(sourceId);
    if (!source) throw new Error(`Unknown credential source ${sourceId}.`);
    return source;
  }
}

export class EnvironmentBearerCredentialSource implements CredentialSource {
  readonly #options: {
    id: string;
    label: string;
    providerId: string;
    variable: string;
    scopes?: ProviderConsentScope[];
    readEnvironment?: (name: string) => string | undefined;
  };

  constructor(options: {
    id: string;
    label: string;
    providerId: string;
    variable: string;
    scopes?: ProviderConsentScope[];
    readEnvironment?: (name: string) => string | undefined;
  }) {
    this.#options = options;
  }

  describe(): CredentialSourceDescription {
    return {
      id: this.#options.id,
      label: this.#options.label,
      providerId: this.#options.providerId,
      kind: "http-bearer",
      scopes: this.#options.scopes ?? ["model", "transcription"],
    };
  }

  async inspect(): Promise<{ available: boolean; reason?: string }> {
    const value = (
      this.#options.readEnvironment ?? ((name) => process.env[name])
    )(this.#options.variable);
    return value
      ? { available: true }
      : { available: false, reason: `${this.#options.variable} is not set.` };
  }

  async resolve(): Promise<CredentialCapability> {
    const read =
      this.#options.readEnvironment ?? ((name: string) => process.env[name]);
    return {
      kind: "http-bearer",
      sourceId: this.#options.id,
      providerId: this.#options.providerId,
      authorize: async (headers) => {
        const value = read(this.#options.variable);
        if (!value)
          throw new CredentialUnavailableError(
            this.#options.id,
            "environment changed",
          );
        headers.set("authorization", `Bearer ${value}`);
      },
    };
  }
}

export class InstalledClientCredentialSource implements CredentialSource {
  constructor(
    readonly options: {
      id: string;
      label: string;
      providerId: string;
      executable: string;
      scopes: ProviderConsentScope[];
      check: () => Promise<boolean>;
    },
  ) {}

  describe(): CredentialSourceDescription {
    return { ...this.options, kind: "delegated-client" };
  }

  async inspect(): Promise<{ available: boolean; reason?: string }> {
    return (await this.options.check())
      ? { available: true }
      : {
          available: false,
          reason: `${this.options.executable} is not available or signed in.`,
        };
  }

  async resolve(): Promise<CredentialCapability> {
    return {
      kind: "delegated-client",
      sourceId: this.options.id,
      providerId: this.options.providerId,
      executable: this.options.executable,
    };
  }
}

export class ActivationRequiredCredentialSource implements CredentialSource {
  constructor(
    readonly description: CredentialSourceDescription,
    readonly reason: string,
  ) {}

  describe(): CredentialSourceDescription {
    return this.description;
  }

  async inspect(): Promise<{ available: boolean; reason: string }> {
    return { available: false, reason: this.reason };
  }

  async resolve(): Promise<never> {
    throw new CredentialUnavailableError(this.description.id, this.reason);
  }
}

function parseGrokExpiry(value: string): number {
  const normalized = value.replace(/(\.\d{3})\d+(Z)$/u, "$1$2");
  return Date.parse(normalized);
}

interface GrokOidcRecord {
  key: string;
  expiresAt: number;
}

/**
 * Reads the Grok client's user OIDC record only through the consent-gated
 * CredentialSourceRegistry. The short-lived bearer is re-read and expiry
 * checked for every request; refresh material is deliberately never handled.
 */
export class GrokAuthFileCredentialSource implements CredentialSource {
  readonly path: string;
  readonly #now: () => Date;

  constructor(options: { path?: string; now?: () => Date } = {}) {
    this.path = options.path ?? join(homedir(), ".grok", "auth.json");
    this.#now = options.now ?? (() => new Date());
  }

  describe(): CredentialSourceDescription {
    return {
      id: "grok-auth-file",
      providerId: "xai",
      label: "Grok client OIDC sign-in",
      kind: "http-bearer",
      scopes: ["model", "transcription"],
    };
  }

  async inspect(): Promise<{ available: boolean; reason?: string }> {
    try {
      await this.#record();
      return { available: true };
    } catch (error) {
      return {
        available: false,
        reason:
          error instanceof Error
            ? error.message
            : "The Grok sign-in record could not be used.",
      };
    }
  }

  async resolve(): Promise<CredentialCapability> {
    await this.#record();
    return {
      kind: "http-bearer",
      sourceId: "grok-auth-file",
      providerId: "xai",
      authorize: async (headers) => {
        const record = await this.#record();
        headers.set("authorization", `Bearer ${record.key}`);
      },
    };
  }

  async #record(): Promise<GrokOidcRecord> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          "Grok is not signed in; run `grok login --device-auth`.",
          {
            cause: error,
          },
        );
      }
      throw new Error("The Grok sign-in record is unreadable or invalid.", {
        cause: error,
      });
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("The Grok sign-in record has an unsupported format.");
    }
    for (const [issuer, candidate] of Object.entries(parsed)) {
      if (!issuer.startsWith("https://auth.x.ai::")) continue;
      if (
        !candidate ||
        typeof candidate !== "object" ||
        Array.isArray(candidate)
      )
        continue;
      const value = candidate as Record<string, unknown>;
      if (
        value.auth_mode !== "oidc" ||
        value.principal_type !== "User" ||
        typeof value.key !== "string" ||
        value.key.length === 0 ||
        typeof value.expires_at !== "string"
      ) {
        continue;
      }
      const expiresAt = parseGrokExpiry(value.expires_at);
      if (!Number.isFinite(expiresAt)) {
        throw new Error("The Grok sign-in expiry is invalid; sign in again.");
      }
      if (expiresAt <= this.#now().getTime()) {
        throw new Error(
          "The Grok sign-in has expired; sign in again with `grok login --device-auth`.",
        );
      }
      return { key: value.key, expiresAt };
    }
    throw new Error(
      "No usable Grok user OIDC sign-in was found; sign in again.",
    );
  }
}

export function createEnvironmentCredentialSources(): CredentialSource[] {
  return [
    new GrokAuthFileCredentialSource(),
    new EnvironmentBearerCredentialSource({
      id: "openai-env",
      label: "OPENAI_API_KEY",
      providerId: "openai",
      variable: "OPENAI_API_KEY",
      scopes: ["model", "transcription"],
    }),
    new EnvironmentBearerCredentialSource({
      id: "xai-env",
      label: "XAI_API_KEY",
      providerId: "xai",
      variable: "XAI_API_KEY",
      scopes: ["model", "transcription"],
    }),
    new EnvironmentBearerCredentialSource({
      id: "anthropic-env",
      label: "ANTHROPIC_API_KEY",
      providerId: "anthropic",
      variable: "ANTHROPIC_API_KEY",
      scopes: ["model"],
    }),
    new ActivationRequiredCredentialSource(
      {
        id: "opencode-auth-file",
        label: "OpenCode auth file (schema not pinned)",
        providerId: "opencode",
        kind: "http-bearer",
        scopes: ["model"],
      },
      "The OpenCode auth.json schema is not pinned; use delegated opencode-cli authorization instead. The file is never read.",
    ),
  ];
}
