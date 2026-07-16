import { join } from "node:path";

import type {
  CodecProvider,
  CredentialCapability,
  CredentialSource,
  LlmProvider,
  ProcessRunner,
  SttProvider,
} from "../providers/index.js";
import {
  CodexCliLlmProvider,
  ConsentRequiredError,
  CredentialUnavailableError,
  CredentialSourceRegistry,
  ExecaProcessRunner,
  FakeCodecProvider,
  FakeLlmProvider,
  FakeSttProvider,
  FileConsentStore,
  FfmpegCodecProvider,
  OpenAiApiSttProvider,
  OpenAiResponsesLlmProvider,
  XaiResponsesLlmProvider,
  XaiRestSttProvider,
  createEnvironmentCredentialSources,
  createInstalledClientCredentialSources,
} from "../providers/index.js";

export interface ProviderSelections {
  llm: string;
  stt: string;
  codec: string;
}

export interface ProviderRuntimeReady<T> {
  state: "ready";
  selected: string;
  provider: T;
}

export interface ProviderRuntimeBlocked {
  state: "blocked";
  selected: string;
  reason:
    | "unsupported-selection"
    | "consent-required"
    | "consent-denied"
    | "consent-revoked"
    | "activation-required"
    | "source-not-registered"
    | "incompatible-source";
  message: string;
  activationChecklist: string[];
  sourceId?: string;
  scope?: "model" | "transcription";
}

export type ProviderRuntimeResolution<T> =
  ProviderRuntimeReady<T> | ProviderRuntimeBlocked;

export interface ProviderRuntimeSelection {
  ready: boolean;
  llm: ProviderRuntimeResolution<LlmProvider>;
  stt: ProviderRuntimeResolution<SttProvider>;
  codec: ProviderRuntimeResolution<CodecProvider>;
}

export class ProviderRuntimeFactory {
  readonly credentials: CredentialSourceRegistry;
  readonly #cwd: string;
  readonly #runner: ProcessRunner | undefined;
  readonly #fetch: typeof globalThis.fetch | undefined;
  readonly #models: { openai?: string; xai?: string };

  constructor(options: {
    credentials: CredentialSourceRegistry;
    cwd: string;
    processRunner?: ProcessRunner;
    fetch?: typeof globalThis.fetch;
    models?: { openai?: string; xai?: string };
  }) {
    this.credentials = options.credentials;
    this.#cwd = options.cwd;
    this.#runner = options.processRunner;
    this.#fetch = options.fetch;
    this.#models = options.models ?? {};
  }

  async resolve(
    selections: ProviderSelections,
  ): Promise<ProviderRuntimeSelection> {
    const [llm, stt, codec] = await Promise.all([
      this.resolveLlm(selections.llm),
      this.resolveStt(selections.stt),
      this.resolveCodec(selections.codec),
    ]);
    return {
      ready:
        llm.state === "ready" &&
        stt.state === "ready" &&
        codec.state === "ready",
      llm,
      stt,
      codec,
    };
  }

  async resolveLlm(
    selected: string,
  ): Promise<ProviderRuntimeResolution<LlmProvider>> {
    if (selected === "fake-llm") {
      return { state: "ready", selected, provider: new FakeLlmProvider() };
    }
    if (selected === "codex-cli") {
      const capability = await this.#credential(selected, "model");
      if ("state" in capability) return capability;
      if (
        capability.kind !== "delegated-client" ||
        capability.providerId !== "openai"
      ) {
        return this.#incompatibleCapability(selected, "model");
      }
      return {
        state: "ready",
        selected,
        provider: new CodexCliLlmProvider({
          cwd: this.#cwd,
          ...(this.#runner ? { runner: this.#runner } : {}),
        }),
      };
    }
    if (
      selected === "openai-env" ||
      selected === "xai-env" ||
      selected === "grok-auth-file"
    ) {
      const capability = await this.#credential(selected, "model");
      if ("state" in capability) return capability;
      const expectedProvider = selected === "openai-env" ? "openai" : "xai";
      if (
        capability.kind !== "http-bearer" ||
        capability.providerId !== expectedProvider
      ) {
        return this.#incompatibleCapability(selected, "model");
      }
      if (capability.providerId === "xai") {
        return {
          state: "ready",
          selected,
          provider: new XaiResponsesLlmProvider({
            credential: capability,
            ...(this.#fetch ? { fetch: this.#fetch } : {}),
            ...(this.#models.xai ? { model: this.#models.xai } : {}),
          }),
        };
      }
      return {
        state: "ready",
        selected,
        provider: new OpenAiResponsesLlmProvider({
          credential: capability,
          ...(this.#fetch ? { fetch: this.#fetch } : {}),
          model: this.#models.openai ?? "gpt-5.6",
        }),
      };
    }
    return this.#unsupported(selected, "model");
  }

  async resolveStt(
    selected: string,
  ): Promise<ProviderRuntimeResolution<SttProvider>> {
    if (selected === "fake-stt") {
      return { state: "ready", selected, provider: new FakeSttProvider() };
    }
    if (
      selected === "openai-env" ||
      selected === "xai-env" ||
      selected === "grok-auth-file"
    ) {
      const capability = await this.#credential(selected, "transcription");
      if ("state" in capability) return capability;
      const expectedProvider = selected === "openai-env" ? "openai" : "xai";
      if (
        capability.kind !== "http-bearer" ||
        capability.providerId !== expectedProvider
      ) {
        return this.#incompatibleCapability(selected, "transcription");
      }
      if (capability.providerId === "xai") {
        return {
          state: "ready",
          selected,
          provider: new XaiRestSttProvider({
            credential: capability,
            ...(this.#fetch ? { fetch: this.#fetch } : {}),
          }),
        };
      }
      return {
        state: "ready",
        selected,
        provider: new OpenAiApiSttProvider({
          credential: capability,
          ...(this.#fetch ? { fetch: this.#fetch } : {}),
        }),
      };
    }
    return this.#unsupported(selected, "transcription");
  }

  async resolveCodec(
    selected: string,
  ): Promise<ProviderRuntimeResolution<CodecProvider>> {
    if (selected === "fake-codec") {
      return { state: "ready", selected, provider: new FakeCodecProvider() };
    }
    if (selected === "ffmpeg") {
      const provider = this.#runner
        ? new FfmpegCodecProvider(this.#runner)
        : new FfmpegCodecProvider();
      const status = await provider.status();
      if (status.availability === "available") {
        return { state: "ready", selected, provider };
      }
      return {
        state: "blocked",
        selected,
        reason: "activation-required",
        message: status.reason ?? "FFmpeg is unavailable.",
        activationChecklist: [
          "Install FFmpeg and ensure `ffmpeg` is on PATH.",
          "Run the provider capability test.",
        ],
      };
    }
    return this.#unsupported(selected, "audio codec");
  }

  #unsupported(selected: string, capability: string): ProviderRuntimeBlocked {
    return {
      state: "blocked",
      selected,
      reason: "unsupported-selection",
      message: `${selected} is not a supported ${capability} selection.`,
      activationChecklist: [
        `Select a supported ${capability} provider.`,
        "Run the provider capability test.",
      ],
    };
  }

  #incompatibleCapability(
    selected: string,
    scope: "model" | "transcription",
  ): ProviderRuntimeBlocked {
    return {
      state: "blocked",
      selected,
      sourceId: selected,
      scope,
      reason: "incompatible-source",
      message: `${selected} resolved an incompatible credential capability.`,
      activationChecklist: [
        `Configure ${selected} for its expected provider and ${scope} scope.`,
        "Run the provider capability test.",
      ],
    };
  }

  async #credential(
    selected: string,
    scope: "model" | "transcription",
  ): Promise<CredentialCapability | ProviderRuntimeBlocked> {
    const description = this.credentials
      .descriptions()
      .find((candidate) => candidate.id === selected);
    if (!description) {
      return {
        state: "blocked",
        selected,
        sourceId: selected,
        scope,
        reason: "source-not-registered",
        message: `${selected} is not registered as a credential source.`,
        activationChecklist: [
          `Register the ${selected} credential source.`,
          "Run the provider capability test.",
        ],
      };
    }
    if (!description.scopes.includes(scope)) {
      return {
        state: "blocked",
        selected,
        sourceId: selected,
        scope,
        reason: "incompatible-source",
        message: `${description.label} does not provide the ${scope} scope.`,
        activationChecklist: [
          `Select a credential source that provides ${scope}.`,
          "Run the provider capability test.",
        ],
      };
    }
    const status = await this.credentials.status(selected, scope);
    if (status.consent === "required") {
      return {
        state: "blocked",
        selected,
        sourceId: selected,
        scope,
        reason: "consent-required",
        message: `Explicit ${scope} consent is required before inspecting ${description.label}.`,
        activationChecklist: [
          `Grant ${scope} consent for ${description.label} in personal settings.`,
          "Run the provider capability test.",
        ],
      };
    }
    if (status.consent === "denied" || status.consent === "revoked") {
      return {
        state: "blocked",
        selected,
        sourceId: selected,
        scope,
        reason: `consent-${status.consent}`,
        message: `${description.label} ${scope} consent is ${status.consent}.`,
        activationChecklist: [
          `Grant ${scope} consent for ${description.label} in personal settings.`,
          "Run the provider capability test.",
        ],
      };
    }
    if (status.availability === "unavailable") {
      return {
        state: "blocked",
        selected,
        sourceId: selected,
        scope,
        reason: "activation-required",
        message: status.reason ?? `${description.label} is unavailable.`,
        activationChecklist: [
          `Configure or sign in to ${description.label} outside the repository.`,
          "Run the provider capability test.",
        ],
      };
    }
    if (status.consent === "granted" && status.availability === "available") {
      try {
        return await this.credentials.resolve(selected, scope);
      } catch (error) {
        if (error instanceof ConsentRequiredError) {
          return {
            state: "blocked",
            selected,
            sourceId: selected,
            scope,
            reason: "consent-required",
            message: `Explicit ${scope} consent is required before inspecting ${description.label}.`,
            activationChecklist: [
              `Grant ${scope} consent for ${description.label} in personal settings.`,
              "Run the provider capability test.",
            ],
          };
        }
        if (error instanceof CredentialUnavailableError) {
          return {
            state: "blocked",
            selected,
            sourceId: selected,
            scope,
            reason: "activation-required",
            message: error.message,
            activationChecklist: [
              `Configure or sign in to ${description.label} outside the repository.`,
              "Run the provider capability test.",
            ],
          };
        }
        throw error;
      }
    }
    return this.#unsupported(selected, scope);
  }
}

export interface CreateDefaultProviderRuntimeFactoryOptions {
  repoRoot: string;
  dataRoot: string;
  credentialSources?: CredentialSource[];
  processRunner?: ProcessRunner;
  fetch?: typeof globalThis.fetch;
  models?: { openai?: string; xai?: string };
}

/**
 * Creates the local production selector without inspecting any credential
 * source. Source inspection remains behind the durable scoped consent store.
 */
export function createDefaultProviderRuntimeFactory(
  options: CreateDefaultProviderRuntimeFactoryOptions,
): ProviderRuntimeFactory {
  const processRunner = options.processRunner ?? new ExecaProcessRunner();
  const credentials = new CredentialSourceRegistry(
    new FileConsentStore(join(options.dataRoot, "consent.json")),
  );
  const sources = options.credentialSources ?? [
    ...createEnvironmentCredentialSources(),
    ...createInstalledClientCredentialSources(processRunner),
  ];
  for (const source of sources) credentials.register(source);
  return new ProviderRuntimeFactory({
    credentials,
    cwd: options.repoRoot,
    processRunner,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.models ? { models: options.models } : {}),
  });
}
