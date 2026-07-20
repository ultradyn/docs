import { describe, expect, it } from "vitest";

import {
  getOAuthFlow,
  OAUTH_FLOWS,
  OPENAI_OAUTH_FLOW,
  XAI_OAUTH_FLOW,
} from "./flows.js";

describe("OAuth flow configs", () => {
  it("exposes the xAI and OpenAI flow constants", () => {
    expect(XAI_OAUTH_FLOW).toMatchObject({
      id: "xai-oauth",
      providerId: "xai",
      issuer: "https://auth.x.ai",
      authorizeEndpoint: "https://auth.x.ai/oauth2/authorize",
      tokenEndpoint: "https://auth.x.ai/oauth2/token",
      clientId: "b1a00492-073a-47ea-816f-4c329264a828",
      scopes: ["openid", "profile", "email", "offline_access", "api:access"],
      redirectPath: "/callback",
    });
    expect(XAI_OAUTH_FLOW.fixedPort).toBeUndefined();

    expect(OPENAI_OAUTH_FLOW).toMatchObject({
      id: "openai-oauth",
      providerId: "openai",
      issuer: "https://auth.openai.com",
      authorizeEndpoint: "https://auth.openai.com/oauth/authorize",
      tokenEndpoint: "https://auth.openai.com/oauth/token",
      clientId: "app_EMoamFRZ73f0CkXaXp7hrann",
      scopes: ["openid", "profile", "email", "offline_access"],
      redirectPath: "/auth/callback",
      fixedPort: 1455,
    });
  });

  it("indexes flows by id and looks them up", () => {
    expect(OAUTH_FLOWS["xai-oauth"]).toBe(XAI_OAUTH_FLOW);
    expect(OAUTH_FLOWS["openai-oauth"]).toBe(OPENAI_OAUTH_FLOW);
    expect(getOAuthFlow("xai-oauth")).toBe(XAI_OAUTH_FLOW);
    expect(() => getOAuthFlow("missing")).toThrow(/Unknown OAuth flow/u);
  });
});
