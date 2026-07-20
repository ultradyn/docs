import { createContext, useContext } from "react";

import type { ApiClient } from "./api.js";
import type { RuntimeConfig, SettingsPayload, StreamEvent } from "./types.js";

export const ACTOR_HANDLE_SETTING_KEY = "identity.actorHandle";

export type ActorIdentityState =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "configured"; handle: string }
  | { status: "error"; message: string };

export function actorIdentityFromSettings(
  settings: SettingsPayload,
): ActorIdentityState {
  const value = settings.values[ACTOR_HANDLE_SETTING_KEY];
  return typeof value === "string" && value.length > 0
    ? { status: "configured", handle: value }
    : { status: "missing" };
}

export interface ApiContextValue {
  api: ApiClient;
  runtime: RuntimeConfig;
  refreshRuntime: () => Promise<void>;
  refreshActorIdentity: () => Promise<void>;
  refreshTheme: () => Promise<void>;
  actorIdentity: ActorIdentityState;
  eventConnected: boolean;
  latestEvent?: StreamEvent;
}

export const ApiContext = createContext<ApiContextValue | null>(null);

export function useApi(): ApiContextValue {
  const context = useContext(ApiContext);
  if (!context)
    throw new Error("useApi must be called within the application shell");
  return context;
}

export function useActorIdentity(): ActorIdentityState {
  return useApi().actorIdentity;
}
