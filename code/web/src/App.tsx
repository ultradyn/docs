import {
  AlertTriangle,
  CloudOff,
  FlaskConical,
  GitBranch,
  Radio,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";

import { ApiClient } from "./api.js";
import {
  ApiContext,
  actorIdentityFromSettings,
  type ActorIdentityState,
} from "./api-context.js";
import { Navigation } from "./components/Navigation.js";
import { ErrorState, LoadingState, StatusPill } from "./components/ui.js";
import { AnswerPage } from "./pages/AnswerPage.js";
import { AskPage } from "./pages/AskPage.js";
import { MaintenancePage } from "./pages/MaintenancePage.js";
import { NotFoundPage } from "./pages/NotFoundPage.js";
import { QueuePage } from "./pages/QueuePage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
import type { RuntimeConfig, StreamEvent } from "./types.js";

interface BootState {
  api: ApiClient;
  runtime: RuntimeConfig;
}

async function loadActorIdentity(api: ApiClient): Promise<ActorIdentityState> {
  try {
    return actorIdentityFromSettings(await api.settings());
  } catch (error) {
    return {
      status: "error",
      message:
        error instanceof Error
          ? error.message
          : "Personal settings could not be loaded.",
    };
  }
}

export function App() {
  const [boot, setBoot] = useState<BootState>();
  const [bootError, setBootError] = useState<Error>();
  const [attempt, setAttempt] = useState(0);
  const [eventConnected, setEventConnected] = useState(false);
  const [latestEvent, setLatestEvent] = useState<StreamEvent>();
  const [actorIdentity, setActorIdentity] = useState<ActorIdentityState>({
    status: "loading",
  });

  useEffect(() => {
    let current = true;
    void ApiClient.connect().then(
      (connected) => {
        if (current) setBoot(connected);
      },
      (error: unknown) => {
        if (current)
          setBootError(
            error instanceof Error
              ? error
              : new Error("Unable to start the application"),
          );
      },
    );
    return () => {
      current = false;
    };
  }, [attempt]);

  const activeApi = boot?.api;
  const refreshActorIdentity = useCallback(async () => {
    if (!activeApi) return;
    setActorIdentity(await loadActorIdentity(activeApi));
  }, [activeApi]);

  useEffect(() => {
    if (!activeApi) return;
    let current = true;
    void loadActorIdentity(activeApi).then((identity) => {
      if (current) setActorIdentity(identity);
    });
    return () => {
      current = false;
    };
  }, [activeApi]);

  useEffect(() => {
    if (!boot) return;
    return boot.api.subscribe((event) => {
      setLatestEvent(event);
      if (
        event.type === "settings.updated" ||
        event.type === "runtime.updated"
      ) {
        void boot.api
          .runtime()
          .then((runtime) =>
            setBoot((current) => (current ? { ...current, runtime } : current)),
          );
      }
      if (event.type === "settings.updated") void refreshActorIdentity();
    }, setEventConnected);
  }, [boot, refreshActorIdentity]);

  const refreshRuntime = useCallback(async () => {
    if (!activeApi) return;
    const runtime = await activeApi.runtime();
    setBoot((current) => (current ? { ...current, runtime } : current));
  }, [activeApi]);

  if (bootError) {
    return (
      <main className="boot-screen">
        <Brand />
        <ErrorState
          error={bootError}
          retry={() => {
            setBootError(undefined);
            setAttempt((value) => value + 1);
          }}
        />
      </main>
    );
  }
  if (!boot) {
    return (
      <main className="boot-screen">
        <Brand />
        <LoadingState label="Opening your documentation workspace…" />
      </main>
    );
  }

  const context = {
    api: boot.api,
    runtime: boot.runtime,
    refreshRuntime,
    refreshActorIdentity,
    actorIdentity,
    eventConnected,
    ...(latestEvent ? { latestEvent } : {}),
  };

  return (
    <ApiContext.Provider value={context}>
      <HashRouter>
        <div className="app-shell">
          <aside className="sidebar">
            <Brand />
            <Navigation maintenanceEnabled={boot.runtime.maintenanceEnabled} />
            <div className="sidebar-foot">
              <StatusPill
                tone={eventConnected ? "positive" : "warning"}
                icon={Radio}
              >
                {eventConnected ? "Live updates" : "Reconnecting"}
              </StatusPill>
              <p className="repo-label" title={boot.runtime.repoRoot}>
                <GitBranch aria-hidden="true" size={14} />{" "}
                {boot.runtime.repoRoot}
              </p>
              <span className="version-label">v{boot.runtime.version}</span>
            </div>
          </aside>

          <div className="workspace">
            <header className="mobile-header">
              <Brand />
              <StatusPill tone={eventConnected ? "positive" : "warning"}>
                {eventConnected ? "Live" : "Offline"}
              </StatusPill>
            </header>
            {boot.runtime.demoMode ? (
              <div className="mode-banner" role="status">
                {boot.runtime.offline ? (
                  <CloudOff aria-hidden="true" size={17} />
                ) : (
                  <FlaskConical aria-hidden="true" size={17} />
                )}
                <div>
                  <strong>
                    {boot.runtime.offline
                      ? "Server offline — interactive demo"
                      : "Demo provider mode"}
                  </strong>
                  <span>
                    {boot.runtime.offline
                      ? " Actions use in-browser sample data and are not saved. Start ultradyn-docs to work with your repository."
                      : " External calls use deterministic fakes. Every state is safe to explore."}
                  </span>
                </div>
              </div>
            ) : null}

            <main id="main-content" className="main-content" tabIndex={-1}>
              <Routes>
                <Route index element={<Navigate to="/ask" replace />} />
                <Route path="/ask" element={<AskPage />} />
                <Route path="/queue" element={<QueuePage />} />
                <Route path="/queue/:questionId" element={<QueuePage />} />
                <Route path="/answer" element={<AnswerPage />} />
                <Route path="/answer/:questionId" element={<AnswerPage />} />
                <Route path="/settings" element={<SettingsPage />} />
                {boot.runtime.maintenanceEnabled ? (
                  <Route path="/maintenance" element={<MaintenancePage />} />
                ) : null}
                <Route path="*" element={<NotFoundPage />} />
              </Routes>
            </main>
            <div className="mobile-navigation">
              <Navigation
                maintenanceEnabled={boot.runtime.maintenanceEnabled}
              />
            </div>
          </div>
        </div>
      </HashRouter>
    </ApiContext.Provider>
  );
}

function Brand() {
  return (
    <div className="brand" aria-label="Ultradyn Docs">
      <span className="brand-mark" aria-hidden="true">
        <Sparkles size={19} strokeWidth={1.7} />
      </span>
      <span className="brand-type">
        <strong>Ultradyn</strong>
        <span>Docs</span>
      </span>
    </div>
  );
}

export function ApplicationErrorFallback() {
  return (
    <main className="boot-screen">
      <Brand />
      <div className="state-panel state-error" role="alert">
        <AlertTriangle aria-hidden="true" size={26} />
        <div>
          <strong>The interface hit an unexpected error</strong>
          <p>
            Your repository has not been changed. Reload this window to try
            again.
          </p>
        </div>
      </div>
    </main>
  );
}
