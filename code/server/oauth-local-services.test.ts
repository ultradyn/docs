import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  EnvironmentBearerCredentialSource,
  FileOAuthTokenStore,
  OAuthTokenCredentialSource,
  OPENAI_OAUTH_FLOW,
  XAI_OAUTH_FLOW,
  startLoopbackListener,
  type LoopbackListener,
} from "../providers/index.js";
import { createLocalServices } from "./local-services.js";

const listeners: LoopbackListener[] = [];

afterEach(async () => {
  while (listeners.length > 0) {
    await listeners.pop()?.close().catch(() => undefined);
  }
});

function fakeOAuthFetch(): typeof globalThis.fetch {
  return async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (
      url === XAI_OAUTH_FLOW.tokenEndpoint ||
      url === OPENAI_OAUTH_FLOW.tokenEndpoint
    ) {
      return new Response(
        JSON.stringify({
          access_token: "access-from-oauth",
          refresh_token: "refresh-from-oauth",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
    return new Response(`unexpected fetch: ${url}`, { status: 500 });
  };
}

async function createOAuthServices(root: string) {
  const dataRoot = join(root, ".machine");
  const store = new FileOAuthTokenStore(join(dataRoot, "oauth"));
  const fetchImpl = fakeOAuthFetch();
  const services = await createLocalServices({
    repoRoot: root,
    dataRoot,
    fetch: fetchImpl,
    credentialSources: [
      new OAuthTokenCredentialSource({
        store,
        config: XAI_OAUTH_FLOW,
        fetch: fetchImpl,
      }),
      new OAuthTokenCredentialSource({
        store,
        config: OPENAI_OAUTH_FLOW,
        fetch: fetchImpl,
      }),
      new EnvironmentBearerCredentialSource({
        id: "openai-env",
        label: "OPENAI_API_KEY",
        providerId: "openai",
        variable: "OPENAI_API_KEY",
        scopes: ["model", "transcription"],
        readEnvironment: () => undefined,
      }),
    ],
    startOAuthListener: async (options) => {
      const listener = await startLoopbackListener({
        path: options.path,
        // Avoid OpenAI's fixed port 1455 collisions across tests.
        ...(options.path === XAI_OAUTH_FLOW.redirectPath
          ? {}
          : options.port !== undefined
            ? { port: options.port }
            : {}),
        timeoutMs: options.timeoutMs ?? 5_000,
      });
      listeners.push(listener);
      return listener;
    },
  });
  return { services, store };
}

describe("local OAuth session manager", () => {
  it("starts, completes, persists tokens, and exposes oauth status flags", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-oauth-local-"));
    const { services, store } = await createOAuthServices(root);

    const idle = await services.providers.oauthStatus("xai-oauth");
    expect(idle).toEqual({ state: "idle" });

    const started = await services.providers.oauthStart("xai-oauth");
    expect(started.authorizeUrl).toContain(
      `client_id=${XAI_OAUTH_FLOW.clientId}`,
    );
    expect(started.authorizeUrl).toContain("code_challenge=");
    expect(started.state).toMatch(/^[0-9a-f]{32}$/u);

    const authorize = new URL(started.authorizeUrl);
    const redirectUri = authorize.searchParams.get("redirect_uri");
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/u);

    const pending = await services.providers.oauthStatus("xai-oauth");
    expect(pending).toMatchObject({
      state: "pending",
      authorizeUrl: started.authorizeUrl,
    });

    // Idempotent restart while pending returns the same URL/state.
    const restarted = await services.providers.oauthStart("xai-oauth");
    expect(restarted).toEqual(started);

    await fetch(
      `${redirectUri}?code=auth-code&state=${encodeURIComponent(started.state)}`,
    );

    let status = await services.providers.oauthStatus("xai-oauth");
    for (
      let attempt = 0;
      attempt < 40 && status.state === "pending";
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      status = await services.providers.oauthStatus("xai-oauth");
    }
    expect(status).toMatchObject({ state: "complete" });

    expect(await store.get("xai-oauth")).toMatchObject({
      accessToken: "access-from-oauth",
      refreshToken: "refresh-from-oauth",
    });

    const providers = await services.providers.list();
    const xai = providers.find((provider) => provider.id === "xai-oauth");
    expect(xai?.oauth).toBe(true);
    // Consent is still required by design — OAuth does not auto-grant scopes.
    // Availability stays unknown until consent unlocks inspection.
    expect(xai?.state).toBe("consent_required");
    expect(xai?.consentScopes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "model",
          consent: "required",
        }),
      ]),
    );

    // After granting consent, the stored token makes the source available.
    await services.providers.consent("xai-oauth", "model", true);
    await services.providers.consent("xai-oauth", "transcription", true);
    const ready = await services.providers.list();
    expect(ready).toContainEqual(
      expect.objectContaining({
        id: "xai-oauth",
        oauth: true,
        state: "ready",
        consentScopes: expect.arrayContaining([
          expect.objectContaining({
            scope: "model",
            consent: "granted",
            availability: "available",
          }),
        ]),
      }),
    );
  });

  it("cancels a pending flow back to idle and rejects non-oauth ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-oauth-cancel-"));
    const { services } = await createOAuthServices(root);

    await services.providers.oauthStart("xai-oauth");
    expect(await services.providers.oauthStatus("xai-oauth")).toMatchObject({
      state: "pending",
    });

    await expect(services.providers.oauthCancel("xai-oauth")).resolves.toEqual({
      ok: true,
    });
    expect(await services.providers.oauthStatus("xai-oauth")).toEqual({
      state: "idle",
    });
    // Idempotent cancel.
    await expect(services.providers.oauthCancel("xai-oauth")).resolves.toEqual({
      ok: true,
    });

    await expect(services.providers.oauthStart("missing")).rejects.toMatchObject(
      {
        statusCode: 404,
        code: "provider_not_found",
      },
    );
    await expect(
      services.providers.oauthStart("openai-env"),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "oauth_not_supported",
    });
  });

  it("registers default OAuth credential sources with the oauth flag", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-oauth-defaults-"));
    const services = await createLocalServices({
      repoRoot: root,
      dataRoot: join(root, ".machine"),
    });
    const providers = await services.providers.list();
    expect(providers).toContainEqual(
      expect.objectContaining({
        id: "xai-oauth",
        oauth: true,
        activationChecklist: [
          "Complete the browser sign-in from this page",
          "Grant scoped discovery consent here",
          "Run the provider capability test before selection",
        ],
      }),
    );
    expect(providers).toContainEqual(
      expect.objectContaining({ id: "openai-oauth", oauth: true }),
    );
  });

  it("clears Ultradyn OAuth tokens on disconnect of any scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-oauth-disconnect-"));
    const { services, store } = await createOAuthServices(root);

    const started = await services.providers.oauthStart("xai-oauth");
    const authorize = new URL(started.authorizeUrl);
    const redirectUri = authorize.searchParams.get("redirect_uri");
    expect(redirectUri).toBeTruthy();

    await fetch(
      `${redirectUri}?code=auth-code&state=${encodeURIComponent(started.state)}`,
    );

    let status = await services.providers.oauthStatus("xai-oauth");
    for (
      let attempt = 0;
      attempt < 40 && status.state === "pending";
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      status = await services.providers.oauthStatus("xai-oauth");
    }
    expect(status).toMatchObject({ state: "complete" });
    expect(await store.get("xai-oauth")).toMatchObject({
      accessToken: "access-from-oauth",
      refreshToken: "refresh-from-oauth",
    });

    await services.providers.consent("xai-oauth", "model", true);
    await services.providers.consent("xai-oauth", "transcription", true);
    const ready = await services.providers.list();
    expect(ready).toContainEqual(
      expect.objectContaining({
        id: "xai-oauth",
        state: "ready",
      }),
    );

    // Disconnect any one scope → sign-out semantics for Ultradyn-owned tokens.
    const after = await services.providers.disconnect("xai-oauth", "model");
    expect(await store.get("xai-oauth")).toBeUndefined();
    expect(after).toMatchObject({
      id: "xai-oauth",
      state: "consent_required",
      consentScopes: expect.arrayContaining([
        expect.objectContaining({
          scope: "model",
          consent: "revoked",
        }),
      ]),
    });

    const listed = await services.providers.list();
    expect(listed).toContainEqual(
      expect.objectContaining({
        id: "xai-oauth",
        state: "consent_required",
      }),
    );
  });

  it("disconnects non-oauth sources without requiring a token store", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-oauth-disconnect-env-"));
    const { services, store } = await createOAuthServices(root);

    await services.providers.consent("openai-env", "model", true);
    const after = await services.providers.disconnect("openai-env", "model");
    expect(after).toMatchObject({
      id: "openai-env",
      consentScopes: expect.arrayContaining([
        expect.objectContaining({
          scope: "model",
          consent: "revoked",
        }),
      ]),
    });
    // Non-OAuth path never wrote tokens; store stays empty.
    expect(await store.list()).toEqual([]);
  });
});
