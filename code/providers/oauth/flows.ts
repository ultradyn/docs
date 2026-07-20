export interface OAuthFlowConfig {
  id: string;
  providerId: "xai" | "openai";
  label: string;
  issuer: string;
  authorizeEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  scopes: string[];
  redirectPath: string;
  fixedPort?: number;
  extraAuthorizeParams?: Record<string, string>;
  /** Consent scopes this token can honestly serve in Ultradyn Docs. */
  consentScopes: ("model" | "transcription")[];
}

export const XAI_OAUTH_FLOW: OAuthFlowConfig = {
  id: "xai-oauth",
  providerId: "xai",
  label: "xAI OAuth",
  issuer: "https://auth.x.ai",
  authorizeEndpoint: "https://auth.x.ai/oauth2/authorize",
  tokenEndpoint: "https://auth.x.ai/oauth2/token",
  clientId: "b1a00492-073a-47ea-816f-4c329264a828",
  scopes: ["openid", "profile", "email", "offline_access", "api:access"],
  redirectPath: "/callback",
  // One xAI token serves both model and STT; the user still grants each
  // Ultradyn consent scope explicitly.
  consentScopes: ["model", "transcription"],
};

export const OPENAI_OAUTH_FLOW: OAuthFlowConfig = {
  id: "openai-oauth",
  providerId: "openai",
  label: "OpenAI OAuth",
  issuer: "https://auth.openai.com",
  authorizeEndpoint: "https://auth.openai.com/oauth/authorize",
  tokenEndpoint: "https://auth.openai.com/oauth/token",
  clientId: "app_EMoamFRZ73f0CkXaXp7hrann",
  scopes: ["openid", "profile", "email", "offline_access"],
  redirectPath: "/auth/callback",
  fixedPort: 1455,
  // A ChatGPT subscription token is not an OpenAI audio API credential, so
  // this source honestly serves the model scope only.
  consentScopes: ["model"],
};

export const OAUTH_FLOWS: Record<string, OAuthFlowConfig> = {
  [XAI_OAUTH_FLOW.id]: XAI_OAUTH_FLOW,
  [OPENAI_OAUTH_FLOW.id]: OPENAI_OAUTH_FLOW,
};

export function getOAuthFlow(id: string): OAuthFlowConfig {
  const flow = OAUTH_FLOWS[id];
  if (!flow) {
    throw new Error(`Unknown OAuth flow: ${id}`);
  }
  return flow;
}
